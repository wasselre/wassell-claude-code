-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W1 — migration 03/05: queue, capture trigger,
-- worker RPCs, twin-fill, seed import, reconcile/GC/stats.
-- Ships dark (translation_settings.is_enabled=false + resources disabled).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Coalescing queue (REV 4 §4f) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.translation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_kind text NOT NULL, entity_id uuid NOT NULL, model_id uuid,
  changed_paths text[] NOT NULL DEFAULT '{}',   -- '{}' = full-entity sweep
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  run_after timestamptz NOT NULL DEFAULT now(),
  first_enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0, claimed_at timestamptz, claimed_by text, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS translation_jobs_active_uq
  ON public.translation_jobs (resource_kind, entity_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS translation_jobs_claim_idx ON public.translation_jobs (status, run_after);
ALTER TABLE public.translation_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.translation_jobs FROM anon, authenticated;

-- ── Search documents (table here — the capture trigger below writes it; the
--    trigram indexes + search RPCs land in migration 04) ────────────────────
CREATE TABLE IF NOT EXISTS public.search_documents (
  resource_kind text NOT NULL, entity_id uuid NOT NULL,
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  model_id uuid,
  text_src text, text_ar text, text_en text,
  dirty boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_kind, entity_id)
);
ALTER TABLE public.search_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_documents FROM anon, authenticated;
-- Clients never read this table directly — search goes through the
-- SECURITY INVOKER entity_search/record_search_v2 RPCs (mig 04) whose joins
-- re-apply the caller's RLS via translation_visible.

-- ── Capture trigger on records (validated §A8; gates in cost order) ───────
CREATE OR REPLACE FUNCTION public.tg_records_enqueue_translation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_enabled boolean; v_res_enabled boolean; v_debounce int; v_depth int; v_changed text[];
BEGIN
  SELECT s.is_enabled, s.debounce_seconds INTO v_enabled, v_debounce
  FROM translation_settings s WHERE s.id;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NEW; END IF;
  -- ANY marked system write (twin_fill, element_id_backfill, …) is derived
  -- machine data — never re-capture it.
  IF COALESCE(current_setting('wassell.system_write', true), '') <> '' THEN RETURN NEW; END IF;
  SELECT r.enabled INTO v_res_enabled FROM translation_resources r WHERE r.resource_kind = 'record';
  IF NOT COALESCE(v_res_enabled, false) THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM translation_field_policies p
                 WHERE p.resource_kind = 'record' AND p.scope_id = NEW.model_id
                   AND p.classification_status = 'confirmed' AND p.treatment <> 'skip') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.data IS NOT DISTINCT FROM NEW.data THEN RETURN NEW; END IF;

  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
  FROM (
    SELECT k FROM jsonb_object_keys(NEW.data) k
    WHERE TG_OP = 'INSERT' OR (OLD.data->k) IS DISTINCT FROM (NEW.data->k)
  ) keys(k)
  WHERE EXISTS (SELECT 1 FROM translation_field_policies p
                WHERE p.resource_kind='record' AND p.scope_id = NEW.model_id
                  AND split_part(p.field_path,'[',1) IN (keys.k, 'pair:' || keys.k)
                  AND p.classification_status='confirmed' AND p.treatment <> 'skip');
  IF v_changed = '{}' THEN RETURN NEW; END IF;

  -- Depth cap = backpressure only; durable dirty state below means nothing is
  -- ever lost (translation_reconcile re-finds it from the units).
  SELECT count(*)::int INTO v_depth FROM translation_jobs WHERE status = 'queued';
  IF v_depth < (SELECT max_queue_depth FROM translation_settings WHERE id) THEN
    INSERT INTO translation_jobs (resource_kind, entity_id, model_id, changed_paths, run_after)
    VALUES ('record', NEW.id, NEW.model_id, v_changed,
            now() + make_interval(secs => COALESCE(v_debounce, 20)))
    ON CONFLICT (resource_kind, entity_id) WHERE status = 'queued'
    DO UPDATE SET
      changed_paths = (SELECT array_agg(DISTINCT x)
                       FROM unnest(translation_jobs.changed_paths || EXCLUDED.changed_paths) x),
      run_after = LEAST(translation_jobs.first_enqueued_at + interval '60 seconds', EXCLUDED.run_after),
      updated_at = now();
  END IF;

  -- SYNCHRONOUS stale-out (REV 4 §B4): from this commit no reader/search can
  -- serve the previous generation's translations for the changed fields.
  UPDATE translation_units u SET
    generation = u.generation + 1, dirty = true, next_retry_at = now(), updated_at = now()
  WHERE u.resource_kind = 'record' AND u.entity_id = NEW.id
    AND split_part(u.field_path,'[',1) = ANY (v_changed);
  UPDATE translation_variants v SET display_text = NULL, display_json = NULL,
    active_revision_id = NULL, state = 'pending'
  WHERE v.resource_kind = 'record' AND v.entity_id = NEW.id
    AND split_part(v.field_path,'[',1) = ANY (v_changed) AND v.role = 'target'
    AND v.machine_owned;   -- human-approved text goes stale via generation, not erasure
  UPDATE search_documents SET text_ar = NULL, text_en = NULL, dirty = true, updated_at = now()
  WHERE resource_kind = 'record' AND entity_id = NEW.id;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS records_enqueue_translation ON public.records;
CREATE TRIGGER records_enqueue_translation
AFTER INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_enqueue_translation();

-- Purge on delete (no FK possible — frozen/non-record kinds; REV 4 §B8).
CREATE OR REPLACE FUNCTION public.tg_records_purge_translations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM translation_units WHERE resource_kind = 'record' AND entity_id = OLD.id;
  DELETE FROM search_documents WHERE resource_kind = 'record' AND entity_id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS records_purge_translations ON public.records;
CREATE TRIGGER records_purge_translations
AFTER DELETE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_purge_translations();

-- ── Workflow capture: skip machine twin-fill statements (REV 4 §B9) ───────
-- Re-emitted VERBATIM from the live definition (fetched 2026-08-02) with ONE
-- added guard. A twin-fill is derived machine data — it must not fire
-- workflows nor re-enter translation capture.
CREATE OR REPLACE FUNCTION public.tg_records_capture_workflow_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_model    uuid;
  v_event    text;
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[];
  v_depth    int;
  v_origin   uuid;
  v_parent   uuid;
  v_max      int := 5;
BEGIN
  -- W1 (bilingual): marked system writes (twin_fill, element_id_backfill, …)
  -- are machine-derived — they must not fire workflows.
  IF COALESCE(current_setting('wassell.system_write', true), '') <> '' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_model := OLD.model_id; v_event := 'delete'; v_old := OLD.data; v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_model := NEW.model_id; v_event := 'create'; v_old := NULL; v_new := NEW.data;
  ELSE
    v_model := NEW.model_id; v_event := 'update'; v_old := OLD.data; v_new := NEW.data;
  END IF;

  PERFORM 1 FROM public.workflow_capture_models WHERE model_id = v_model AND enabled = true;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_event = 'update' AND v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM (
      SELECT DISTINCT k FROM (
        SELECT jsonb_object_keys(COALESCE(v_old, '{}'::jsonb)) AS k
        UNION
        SELECT jsonb_object_keys(COALESCE(v_new, '{}'::jsonb))
      ) ks
      WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k)
    ) d;

  v_depth  := COALESCE(NULLIF(current_setting('wassell.workflow_depth', true), '')::int, 0);
  v_origin := NULLIF(current_setting('wassell.workflow_origin_run', true), '')::uuid;
  v_parent := NULLIF(current_setting('wassell.workflow_parent_job', true), '')::uuid;

  IF v_depth > v_max THEN
    INSERT INTO public.workflow_jobs
      (model_id, record_id, trigger_event, previous_data, new_data, changed_fields,
       actor_user_id, depth, parent_job_id, origin_run_id, status, skip_reason)
    VALUES
      (v_model, COALESCE(NEW.id, OLD.id), v_event, v_old, v_new, v_changed,
       auth.uid(), v_depth, v_parent, v_origin, 'skipped',
       'max_workflow_depth_exceeded (' || v_depth || ' > ' || v_max || ')');
    RETURN NULL;
  END IF;

  INSERT INTO public.workflow_jobs
    (model_id, record_id, trigger_event, previous_data, new_data, changed_fields,
     actor_user_id, depth, parent_job_id, origin_run_id, idempotency_key)
  VALUES
    (v_model, COALESCE(NEW.id, OLD.id), v_event, v_old, v_new, v_changed,
     auth.uid(), v_depth, v_parent, v_origin,
     md5(COALESCE(NEW.id, OLD.id)::text || ':' || v_event || ':' || v_depth::text || ':' ||
         md5(COALESCE(v_new, v_old, '{}'::jsonb)::text)));

  RETURN NULL;
END $function$;

-- ── Worker RPCs (service_role only) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.translation_job_claim_next(p_worker text)
RETURNS TABLE (job_id uuid, resource_kind text, entity_id uuid, model_id uuid,
               changed_paths text[], attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Kill switch gates the WHOLE pipeline (live gap 2026-08-02: reconcile
  -- enqueued seed-dirtied units while disabled and the worker translated
  -- ~1.5k variants pre-cutover — OFF must mean off everywhere).
  IF NOT COALESCE((SELECT is_enabled FROM translation_settings WHERE id), false) THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE translation_jobs j SET status = 'running', claimed_at = now(),
    claimed_by = p_worker, attempts = j.attempts + 1, updated_at = now()
  WHERE j.id = (
    SELECT id FROM translation_jobs
    WHERE status = 'queued' AND run_after <= now()
    ORDER BY run_after
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  RETURNING j.id, j.resource_kind, j.entity_id, j.model_id, j.changed_paths, j.attempts;
END $$;

CREATE OR REPLACE FUNCTION public.translation_job_complete(p_job uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE translation_jobs SET status = 'done', updated_at = now()
  WHERE id = p_job AND status = 'running'
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.translation_job_fail(p_job uuid, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempts int;
BEGIN
  UPDATE translation_jobs SET
    status = CASE WHEN attempts >= 5 THEN 'dead' ELSE 'failed' END,
    error = left(COALESCE(p_error,''), 500), updated_at = now()
  WHERE id = p_job AND status = 'running'
  RETURNING attempts INTO v_attempts;
  IF NOT FOUND THEN RETURN false; END IF;
  -- failed (not dead) jobs requeue with exponential backoff
  UPDATE translation_jobs SET status = 'queued',
    run_after = now() + make_interval(mins => LEAST(60, 2 ^ v_attempts)::int)
  WHERE id = p_job AND status = 'failed';
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.translation_jobs_watchdog()
RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH swept AS (
    UPDATE translation_jobs SET status = 'queued', run_after = now(), updated_at = now()
    WHERE status = 'running' AND claimed_at < now() - interval '10 minutes'
    RETURNING 1
  ) SELECT count(*)::int FROM swept;
$$;

-- Durable dirty-state reconciliation (REV 3 blocker 8): dirty units with no
-- queued/running job get a job — recovers from depth-cap refusals, provider
-- downtime, worker crashes, prompt/glossary bumps.
CREATE OR REPLACE FUNCTION public.translation_reconcile(p_limit int DEFAULT 200)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count int := 0; r record;
BEGIN
  IF NOT COALESCE((SELECT is_enabled FROM translation_settings WHERE id), false) THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT DISTINCT u.resource_kind, u.entity_id, u.model_id
    FROM translation_units u
    JOIN translation_resources tr ON tr.resource_kind = u.resource_kind AND tr.enabled
    WHERE u.dirty AND COALESCE(u.next_retry_at, now()) <= now()
      AND NOT EXISTS (SELECT 1 FROM translation_jobs j
                      WHERE j.resource_kind = u.resource_kind AND j.entity_id = u.entity_id
                        AND j.status IN ('queued','running'))
    LIMIT p_limit
  LOOP
    INSERT INTO translation_jobs (resource_kind, entity_id, model_id, changed_paths, run_after)
    VALUES (r.resource_kind, r.entity_id, r.model_id, '{}', now())
    ON CONFLICT (resource_kind, entity_id) WHERE status = 'queued' DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- ── Atomic CAS activation (REV 4 blocker 4) ───────────────────────────────
-- ONE statement: the variant activates only if the unit is STILL at the
-- worker's claimed generation and the variant is machine-owned. A save that
-- landed mid-provider-call bumped the generation → 0 rows → caller discards.
CREATE OR REPLACE FUNCTION public.translation_variant_activate(
  p_kind text, p_entity uuid, p_path text, p_lang text,
  p_revision_id uuid, p_claimed_generation bigint,
  p_text text, p_json jsonb DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hit boolean;
BEGIN
  UPDATE translation_variants v SET
    state = 'translated', generation = u.generation,
    display_text = p_text, display_json = p_json,
    active_revision_id = p_revision_id, last_error = NULL, attempts = 0
  FROM translation_units u
  WHERE u.resource_kind = v.resource_kind AND u.entity_id = v.entity_id
    AND u.field_path = v.field_path
    AND v.resource_kind = p_kind AND v.entity_id = p_entity
    AND v.field_path = p_path AND v.lang = p_lang
    AND v.role = 'target' AND v.machine_owned
    AND u.generation = p_claimed_generation
  RETURNING true INTO v_hit;
  IF NOT COALESCE(v_hit, false) THEN RETURN false; END IF;
  UPDATE translation_revisions SET status = 'active' WHERE id = p_revision_id AND status = 'candidate';
  RETURN true;
END $$;

-- Post-job completion: clear dirty ONLY for units whose machine-owned targets
-- are all resolved; failed/pending ones stay dirty with a retry backoff so
-- translation_reconcile re-queues them (REV 3 blocker 8).
CREATE OR REPLACE FUNCTION public.translation_unit_finalize(p_kind text, p_entity uuid)
RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH cleared AS (
    UPDATE translation_units u SET dirty = false, next_retry_at = NULL, updated_at = now()
    WHERE u.resource_kind = p_kind AND u.entity_id = p_entity AND u.dirty
      AND NOT EXISTS (
        SELECT 1 FROM translation_variants v
        WHERE v.resource_kind = u.resource_kind AND v.entity_id = u.entity_id
          AND v.field_path = u.field_path AND v.role = 'target' AND v.machine_owned
          AND v.state IN ('pending','failed'))
    RETURNING 1
  ), deferred AS (
    UPDATE translation_units u SET next_retry_at = now() + interval '15 minutes', updated_at = now()
    WHERE u.resource_kind = p_kind AND u.entity_id = p_entity AND u.dirty
    RETURNING 1
  )
  SELECT COALESCE((SELECT count(*) FROM cleared), 0)::int;
$$;

-- ── Twin fill (REV 4 §B9): conditional, GUC-marked, machine-owned only ────
CREATE OR REPLACE FUNCTION public.record_twin_fill(
  p_record_id uuid, p_source_path text, p_target_path text, p_value text,
  p_expected_source_rev text, p_expected_target_value text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_rec records%ROWTYPE; v_cur_src text; v_cur_tgt text;
BEGIN
  SELECT * INTO v_rec FROM records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_cur_src := btrim(COALESCE(v_rec.data->>p_source_path, ''));
  v_cur_tgt := btrim(COALESCE(v_rec.data->>p_target_path, ''));
  -- CAS 1: source unchanged since the translation was produced.
  IF encode(digest(v_cur_src, 'sha256'::text), 'hex') IS DISTINCT FROM p_expected_source_rev THEN
    RETURN false;
  END IF;
  -- CAS 2: target still machine-writable (empty or exactly the previous
  -- machine text). A human edit in the window wins; the fill is discarded.
  IF v_cur_tgt <> '' AND v_cur_tgt IS DISTINCT FROM btrim(COALESCE(p_expected_target_value,'')) THEN
    RETURN false;
  END IF;
  PERFORM set_config('wassell.system_write', 'twin_fill', true);   -- txn-local
  UPDATE records SET data = jsonb_set(data, ARRAY[p_target_path], to_jsonb(p_value), true)
  WHERE id = p_record_id;
  PERFORM set_config('wassell.system_write', '', true);
  RETURN true;
END $$;

-- ── Seed import from the legacy cache (REV 4 §A7/§D): INACTIVE candidates ─
-- SEQUENTIAL statements, not one CTE chain: data-modifying CTEs share a
-- snapshot, so a revisions insert joining units inserted in the same
-- statement sees an empty table (live incident during the 2026-08-02 W2
-- apply — first run imported 0 revisions while inserting all units/variants).
CREATE OR REPLACE FUNCTION public.record_translation_seed_from_cache(p_model_id uuid)
RETURNS TABLE (imported int, rejected int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_model_name text; v_imported int := 0; v_eligible int := 0; v_matched int := 0;
BEGIN
  SELECT name INTO v_model_name FROM models WHERE id = p_model_id;
  IF v_model_name IS NULL THEN RETURN QUERY SELECT 0, 0; RETURN; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _seed_matched (
    entity_id uuid, field_path text, src text, treatment text, translated_text text
  ) ON COMMIT DROP;
  DELETE FROM _seed_matched;

  INSERT INTO _seed_matched
  SELECT e.entity_id, e.field_path, e.src, e.treatment, t.translated_text
  FROM (
    SELECT ur.id AS entity_id, p.field_path,
           btrim(ur.data->>p.field_path) AS src, p.treatment
    FROM unified_records ur
    JOIN translation_field_policies p
      ON p.resource_kind = 'record' AND p.scope_id = p_model_id
     AND p.classification_status = 'confirmed' AND p.treatment IN ('translate','transliterate')
     AND p.field_path !~ '\[' AND p.field_path NOT LIKE 'pair:%'
    WHERE ur.model_id = p_model_id
      AND COALESCE(btrim(ur.data->>p.field_path),'') <> ''
      AND (ur.data->>p.field_path) ~ '[؀-ۿ]'
  ) e
  JOIN value_translations t
    ON t.target_lang = 'en'
   AND t.source_hash = encode(digest(e.src, 'sha256'::text), 'hex')
   AND t.model_hint = v_model_name                     -- context-bound only (REV 4 §A7)
   AND t.field_hint = e.field_path
   AND ((t.kind = 'name') = (e.treatment = 'transliterate'));  -- treatment-compatible

  SELECT count(*) INTO v_matched FROM _seed_matched;
  SELECT count(*) INTO v_eligible
  FROM unified_records ur
  JOIN translation_field_policies p
    ON p.resource_kind='record' AND p.scope_id=p_model_id
   AND p.classification_status='confirmed' AND p.treatment IN ('translate','transliterate')
   AND p.field_path !~ '\[' AND p.field_path NOT LIKE 'pair:%'
  WHERE ur.model_id = p_model_id
    AND COALESCE(btrim(ur.data->>p.field_path),'') <> ''
    AND (ur.data->>p.field_path) ~ '[؀-ۿ]';

  INSERT INTO translation_units (resource_kind, entity_id, field_path, model_id,
    source_lang, detector_version, source_rev, source_excerpt, generation, dirty)
  SELECT 'record', m.entity_id, m.field_path, p_model_id,
    'ar', 'seed-import-v1', encode(digest(m.src,'sha256'::text),'hex'),
    left(m.src, 200), 1, true
  FROM _seed_matched m
  ON CONFLICT (resource_kind, entity_id, field_path) DO NOTHING;

  INSERT INTO translation_variants (resource_kind, entity_id, field_path, lang, role, state)
  SELECT 'record', m.entity_id, m.field_path, l.lang,
    CASE WHEN l.lang = 'ar' THEN 'source' ELSE 'target' END,
    CASE WHEN l.lang = 'ar' THEN 'source' ELSE 'pending' END
  FROM _seed_matched m CROSS JOIN (VALUES ('ar'),('en')) l(lang)
  ON CONFLICT (resource_kind, entity_id, field_path, lang) DO NOTHING;

  WITH revs AS (
    INSERT INTO translation_revisions (resource_kind, entity_id, field_path, lang, generation,
      source_rev, source_lang, source_text, translated_text, origin, status, treatment, provider)
    SELECT 'record', m.entity_id, m.field_path, 'en', u.generation,
      u.source_rev, 'ar', m.src, m.translated_text, 'seed', 'candidate', m.treatment, 'cache:deepseek'
    FROM _seed_matched m
    JOIN translation_units u ON u.resource_kind = 'record'
     AND u.entity_id = m.entity_id AND u.field_path = m.field_path
    WHERE u.source_rev = encode(digest(m.src,'sha256'::text),'hex')
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO v_imported FROM revs;

  INSERT INTO translation_history (resource_kind, entity_id, field_path, reason)
  VALUES ('record', p_model_id, 'model:' || v_model_name, 'seed_import');
  RETURN QUERY SELECT v_imported, v_eligible - v_matched;
END $$;

-- ── GC + stats (REV 4 §B8/§13) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.translation_gc()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ret int; v_orphans int; v_jobs int; v_tm int;
BEGIN
  SELECT retention_days INTO v_ret FROM translation_settings WHERE id;
  -- Orphaned units (parent gone — non-FK kinds + missed purges).
  WITH del AS (
    DELETE FROM translation_units u
    WHERE (u.resource_kind = 'record'
           AND NOT EXISTS (SELECT 1 FROM unified_records ur WHERE ur.id = u.entity_id))
       OR (u.resource_kind = 'wassel_doc'
           AND NOT EXISTS (SELECT 1 FROM wassel_documents d WHERE d.file_id = u.entity_id))
    RETURNING 1
  ) SELECT count(*) INTO v_orphans FROM del;
  -- Old candidates/superseded/rejected (approved + source_snapshot kept).
  DELETE FROM translation_revisions r
  WHERE r.status IN ('candidate','superseded','rejected','failed')
    AND r.origin NOT IN ('human','official','source_snapshot')
    AND r.created_at < now() - make_interval(days => COALESCE(v_ret,180))
    AND r.id NOT IN (
      SELECT active_revision_id FROM translation_variants WHERE active_revision_id IS NOT NULL
      UNION SELECT last_approved_revision_id FROM translation_variants WHERE last_approved_revision_id IS NOT NULL);
  -- Done/dead jobs.
  WITH del AS (
    DELETE FROM translation_jobs WHERE status IN ('done','dead')
      AND updated_at < now() - interval '30 days' RETURNING 1
  ) SELECT count(*) INTO v_jobs FROM del;
  -- service_only TM retention (90 d) — 'never' classes were never stored.
  WITH del AS (
    DELETE FROM translation_memory
    WHERE sensitivity IN ('pii','financial','restricted')
      AND created_at < now() - interval '90 days' RETURNING 1
  ) SELECT count(*) INTO v_tm FROM del;
  RETURN jsonb_build_object('orphan_units', v_orphans, 'jobs_pruned', v_jobs, 'tm_purged', v_tm);
END $$;

CREATE OR REPLACE FUNCTION public.translation_stats()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
SET statement_timeout TO '60s' AS $$
  SELECT jsonb_build_object(
    'jobs', (SELECT jsonb_object_agg(status, n) FROM
             (SELECT status, count(*) n FROM translation_jobs GROUP BY status) j),
    'units_dirty', (SELECT count(*) FROM translation_units WHERE dirty),
    'variants', (SELECT jsonb_object_agg(state, n) FROM
                 (SELECT state, count(*) n FROM translation_variants WHERE role='target' GROUP BY state) v),
    'seeds_awaiting', (SELECT count(*) FROM translation_revisions
                       WHERE origin='seed' AND status='candidate'),
    'stale_approved', (SELECT count(*) FROM translation_variants v
                       JOIN translation_units u USING (resource_kind, entity_id, field_path)
                       WHERE v.state='approved' AND v.generation IS DISTINCT FROM u.generation),
    'invariant_violations', (SELECT count(*) FROM translation_variants v
                             JOIN translation_units u USING (resource_kind, entity_id, field_path)
                             WHERE v.display_text IS NOT NULL AND v.role='target'
                               AND v.generation IS DISTINCT FROM u.generation)
  );
$$;

-- TM purge for targeted erasure requests (REV 4 §B8).
CREATE OR REPLACE FUNCTION public.translation_memory_purge(p_context_scope text)
RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH del AS (DELETE FROM translation_memory WHERE context_scope = p_context_scope RETURNING 1)
  SELECT count(*)::int FROM del;
$$;

-- Grants: worker/service only for everything in this file.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'translation_job_claim_next(text)','translation_job_complete(uuid)',
    'translation_job_fail(uuid,text)','translation_jobs_watchdog()',
    'translation_reconcile(int)','record_twin_fill(uuid,text,text,text,text,text)',
    'record_translation_seed_from_cache(uuid)','translation_gc()',
    'translation_stats()','translation_memory_purge(text)',
    'translation_variant_activate(text,uuid,text,text,uuid,bigint,text,jsonb)',
    'translation_unit_finalize(text,uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;
