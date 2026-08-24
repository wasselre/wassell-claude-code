-- ============================================================================
-- File AI enrichment pipeline — the AUTO-suggest lane (posture A).
-- ----------------------------------------------------------------------------
-- A model reads each media/doc file and PROPOSES metadata; the safe layers
-- (description, tags, subjects, asset_nature) are AUTO-APPLIED with an
-- ai_suggested provenance badge (undoable), and relationship suggestions are
-- STAGED in files.ai_suggestions for a human to confirm (never auto-linked).
--
-- Same queue pattern as file_preview_jobs / generation_jobs: enqueue → the Fly
-- worker claims (FOR UPDATE SKIP LOCKED) → analysis (no held HTTP) → complete.
-- Ships DARK: file_enrichment_settings.is_enabled = false, so the trigger and
-- claim are no-ops until deliberately turned on. Existing files are NOT swept
-- automatically — a throttled operator backfill enqueues them later.
--
-- Foundations already exist (Phase A/B): files.ai_description, files.ai_suggestions,
-- the four axis columns, file_subjects, file_metadata_provenance, and the
-- allowlists (file_document_types / file_vocabularies) the model must pick from.
-- ============================================================================

BEGIN;

-- ─── 0. Global settings / kill switch ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.file_enrichment_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),   -- single row
  is_enabled      boolean NOT NULL DEFAULT false,                -- ship dark
  max_queue_depth int     NOT NULL DEFAULT 500                   -- flood guard
);
INSERT INTO public.file_enrichment_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.file_enrichment_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_enrichment_settings_read ON public.file_enrichment_settings;
CREATE POLICY file_enrichment_settings_read ON public.file_enrichment_settings
  FOR SELECT TO authenticated USING (true);

-- ─── 1. Job queue ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.file_enrichment_jobs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid        NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','completed','failed')),
  reason      text,        -- 'upload' | 'backfill' | 'manual'
  attempts    int         NOT NULL DEFAULT 0,
  worker_id   text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS file_enrichment_jobs_queued_idx
  ON public.file_enrichment_jobs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS file_enrichment_jobs_running_idx
  ON public.file_enrichment_jobs (started_at) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS file_enrichment_jobs_one_active_per_file_idx
  ON public.file_enrichment_jobs (file_id) WHERE status IN ('queued','running');
ALTER TABLE public.file_enrichment_jobs ENABLE ROW LEVEL SECURITY;  -- deny-all; worker uses service_role

-- ─── 2. Enqueue RPC (atomic, honours kill switch + depth guard) ──────────────
CREATE OR REPLACE FUNCTION public.file_enrichment_enqueue(p_file_id uuid, p_reason text DEFAULT 'manual')
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_enabled boolean;
  v_max     int;
  v_depth   int;
  v_kind    text;
BEGIN
  SELECT is_enabled, max_queue_depth INTO v_enabled, v_max FROM public.file_enrichment_settings WHERE id;
  IF NOT coalesce(v_enabled, false) THEN RETURN false; END IF;

  SELECT kind INTO v_kind FROM public.files WHERE id = p_file_id;
  IF v_kind IS NULL OR v_kind NOT IN ('image','pdf','document','video','audio') THEN RETURN false; END IF;

  -- Turning a file away costs nothing: the backlog lives in the DATA (unenriched
  -- files), picked up by the next backfill run — same posture as the listing mirror.
  SELECT count(*) INTO v_depth FROM public.file_enrichment_jobs WHERE status IN ('queued','running');
  IF v_depth >= v_max THEN RETURN false; END IF;

  INSERT INTO public.file_enrichment_jobs (file_id, reason)
  VALUES (p_file_id, coalesce(p_reason, 'manual'))
  ON CONFLICT (file_id) WHERE status IN ('queued','running') DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.file_enrichment_enqueue(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_enrichment_enqueue(uuid, text) TO service_role;

-- ─── 3. Auto-enqueue on upload (AFTER INSERT) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_files_enqueue_enrichment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.file_enrichment_enqueue(NEW.id, 'upload');  -- no-op while disabled
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS files_enqueue_enrichment ON public.files;
CREATE TRIGGER files_enqueue_enrichment
  AFTER INSERT ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_enqueue_enrichment();

-- ─── 4. Claim ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.file_enrichment_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id uuid, file_id uuid, attempts int,
  storage_bucket text, storage_path text, mime_type text, kind text,
  size_bytes bigint, original_name text, document_type text
) LANGUAGE sql SECURITY DEFINER AS $$
  WITH claimed AS (
    UPDATE public.file_enrichment_jobs j
       SET status='running', worker_id=p_worker_id, started_at=now(), attempts=j.attempts+1
     WHERE j.id = (SELECT id FROM public.file_enrichment_jobs
                    WHERE status='queued' ORDER BY created_at
                    FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING j.id, j.file_id, j.attempts
  )
  SELECT c.id, c.file_id, c.attempts,
         f.storage_bucket, f.storage_path, f.mime_type, f.kind,
         f.size_bytes, f.original_name, f.document_type
    FROM claimed c JOIN public.files f ON f.id = c.file_id;
$$;
REVOKE ALL ON FUNCTION public.file_enrichment_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_enrichment_claim_next(text) TO service_role;

-- ─── 5. Complete — auto-apply the SAFE layers + stage relationships ──────────
-- p_result shape (all optional):
--   { "description": text,
--     "tags": [text],
--     "subjects": [text],          -- must be existing file_document_types values
--     "asset_nature": text,        -- must be an existing asset_nature vocab value
--     "relationship_suggestions": jsonb,   -- staged, never applied
--     "model": text, "raw": jsonb }
-- Auto-apply is SKIPPED per-field when a human_modified provenance row exists —
-- your edits always win. Everything applied is stamped ai_suggested.
CREATE OR REPLACE FUNCTION public.file_enrichment_complete(p_job_id uuid, p_result jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_file  uuid;
  v_model text := p_result->>'model';
  v_desc  text := nullif(btrim(coalesce(p_result->>'description','')), '');
  v_nature text := nullif(p_result->>'asset_nature','');
  v_tags  text[] := CASE WHEN p_result ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'tags')) END;
  v_subs  text[] := CASE WHEN p_result ? 'subjects' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'subjects')) END;
  v_edited boolean;
  s text;
BEGIN
  UPDATE public.file_enrichment_jobs
     SET status='completed', finished_at=now(), error=NULL
   WHERE id=p_job_id AND status='running'
  RETURNING file_id INTO v_file;
  IF v_file IS NULL THEN RETURN false; END IF;

  -- ai_description (safe, auto-apply unless a human edited it)
  IF v_desc IS NOT NULL THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='ai_description';
    IF v_edited IS NOT TRUE THEN
      UPDATE public.files SET ai_description=v_desc WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'ai_description','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- asset_nature (only when unset + valid vocab + not human-edited)
  IF v_nature IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_vocabularies WHERE dimension='asset_nature' AND value=v_nature) THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='asset_nature';
    IF v_edited IS NOT TRUE AND (SELECT asset_nature IS NULL FROM public.files WHERE id=v_file) THEN
      UPDATE public.files SET asset_nature=v_nature WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'asset_nature','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- tags (additive union; add-only, never remove)
  IF v_tags IS NOT NULL AND array_length(v_tags,1) > 0 THEN
    UPDATE public.files
       SET tags = ARRAY(SELECT DISTINCT unnest(coalesce(tags,'{}') || v_tags))
     WHERE id=v_file;
    INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
    VALUES (v_file,'tags','ai_suggested',v_model,now())
    ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
      WHERE public.file_metadata_provenance.state <> 'human_modified';
  END IF;

  -- subjects (add valid ones to file_subjects; skip unknown vocab values)
  IF v_subs IS NOT NULL THEN
    FOREACH s IN ARRAY v_subs LOOP
      IF EXISTS (SELECT 1 FROM public.file_document_types WHERE value=s) THEN
        INSERT INTO public.file_subjects(file_id, subject) VALUES (v_file, s)
          ON CONFLICT (file_id, subject) DO NOTHING;
        INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
        VALUES (v_file,'subject:'||s,'ai_suggested',v_model,now())
        ON CONFLICT (file_id, field_path) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  -- relationship suggestions → STAGING only (never auto-linked)
  IF p_result ? 'relationship_suggestions' THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('relationships', p_result->'relationship_suggestions',
                                                  'model', v_model, 'at', now())
     WHERE id=v_file;
  END IF;

  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.file_enrichment_complete(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_enrichment_complete(uuid, jsonb) TO service_role;

-- ─── 6. Fail + watchdog ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.file_enrichment_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_file uuid;
BEGIN
  UPDATE public.file_enrichment_jobs SET status='failed', finished_at=now(), error=p_error
   WHERE id=p_job_id AND status='running' RETURNING file_id INTO v_file;
  RETURN v_file IS NOT NULL;  -- an un-enriched file is a valid file; nothing else to flip
END $$;
REVOKE ALL ON FUNCTION public.file_enrichment_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_enrichment_fail(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.file_enrichment_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count int := 0;
BEGIN
  WITH stale AS (
    UPDATE public.file_enrichment_jobs
       SET status='failed', finished_at=now(),
           error='watchdog: enrichment did not finish within 30 minutes — likely crashed mid-run.'
     WHERE status='running' AND started_at < now() - interval '30 minutes'
    RETURNING 1)
  SELECT COUNT(*) INTO v_count FROM stale;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.file_enrichment_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_enrichment_watchdog() TO service_role;

COMMIT;
