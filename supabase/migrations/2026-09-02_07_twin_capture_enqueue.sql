-- ════════════════════════════════════════════════════════════════════════════
-- W7 (bilingual): make the capture trigger enqueue a translation job when a
-- TWIN physical field (body_ar / body_en …) changes, so ongoing edits auto-fill
-- the other side (not just the operator backfill).
--
-- The W1 enqueue predicate tried to match twins with `'pair:' || keys.k`, which
-- can never be true — a pair policy's field_path is `pair:body`, never
-- `pair:body_ar`. So twin edits enqueued nothing and only a scalar field change
-- on the same record incidentally triggered a twin fill. This re-emits the
-- capture trigger VERBATIM from the live definition (fetched 2026-08-04) with
-- ONLY that one predicate corrected — it now matches when a changed key equals
-- either side of a pair policy's twin_counterpart_path. The scalar/element
-- match is unchanged; a non-pair policy has a NULL twin path (no false match).
--
-- Blast radius is contained to translation ENQUEUE: a predicate slip can at
-- most enqueue a harmless extra job (worker no-ops) or miss one — it can never
-- affect the record save itself. Inert on models without a confirmed pair
-- policy (chat_templates/posts_content pairs stay 'proposed' until go-live).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_records_enqueue_translation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_enabled boolean; v_res_enabled boolean; v_debounce int; v_depth int; v_changed text[];
BEGIN
  SELECT s.is_enabled, s.debounce_seconds INTO v_enabled, v_debounce
  FROM translation_settings s WHERE s.id;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NEW; END IF;
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
                  AND ( split_part(p.field_path,'[',1) = keys.k
                     OR keys.k = split_part(p.twin_counterpart_path,'|',1)
                     OR keys.k = split_part(p.twin_counterpart_path,'|',2) )
                  AND p.classification_status='confirmed' AND p.treatment <> 'skip');
  IF v_changed = '{}' THEN RETURN NEW; END IF;

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

  -- DURABLE dirty state: upsert stub units for changed scalar policy paths
  -- (the worker overwrites the stub's detection fields on first processing).
  INSERT INTO translation_units (resource_kind, entity_id, field_path, org_id, model_id,
    source_lang, source_rev, generation, dirty, next_retry_at)
  SELECT 'record', NEW.id, p.field_path, '00000000-0000-0000-0000-000000000001', NEW.model_id,
    'und', 'stub', 1, true, now()
  FROM translation_field_policies p
  WHERE p.resource_kind='record' AND p.scope_id = NEW.model_id
    AND p.classification_status='confirmed' AND p.treatment <> 'skip'
    AND p.field_path !~ '\[' AND p.field_path NOT LIKE 'pair:%'
    AND p.field_path = ANY (v_changed)
    AND COALESCE(btrim(NEW.data->>p.field_path),'') <> ''
  ON CONFLICT (resource_kind, entity_id, field_path) DO UPDATE SET
    generation = translation_units.generation + 1, dirty = true,
    next_retry_at = now(), updated_at = now();

  -- Element-path units (worker-managed) still bump on their parent's change.
  UPDATE translation_units u SET
    generation = u.generation + 1, dirty = true, next_retry_at = now(), updated_at = now()
  WHERE u.resource_kind = 'record' AND u.entity_id = NEW.id
    AND u.field_path ~ '\[' AND split_part(u.field_path,'[',1) = ANY (v_changed);

  UPDATE translation_variants v SET display_text = NULL, display_json = NULL,
    active_revision_id = NULL, state = 'pending'
  WHERE v.resource_kind = 'record' AND v.entity_id = NEW.id
    AND split_part(v.field_path,'[',1) = ANY (v_changed) AND v.role = 'target'
    AND v.machine_owned;
  UPDATE search_documents SET text_ar = NULL, text_en = NULL, dirty = true, updated_at = now()
  WHERE resource_kind = 'record' AND entity_id = NEW.id;

  RETURN NEW;
END $function$;
