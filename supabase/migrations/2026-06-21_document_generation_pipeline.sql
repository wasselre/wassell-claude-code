-- ============================================================================
-- 2026-06-21: document generation pipeline (template → DOCX → PDF on the worker)
-- ----------------------------------------------------------------------------
-- The SIXTH queue on the Fly worker (after deck_jobs / generation_jobs /
-- file_preview_jobs / pdf_compress_jobs / scheduled reports). Turns a CRM
-- record into a branded A4 PDF generated from an authored template:
--
--   1. /api/generate-document (authenticated) resolves the template + the
--      record's linked client/unit/project ids, then calls
--      document_job_enqueue() via service-role.
--   2. The worker's document poll loop claims via document_job_claim_next
--      (FOR UPDATE SKIP LOCKED), which JOINs the template's wassel_documents
--      body (content_json + page settings) so the worker gets everything in
--      one round-trip. The worker resolves {{tokens}} from the record +
--      linked records, builds a DOCX (logo embedded), converts it to PDF with
--      LibreOffice (the SAME engine the office-preview queue uses), uploads the
--      PDF to wassel-files, INSERTs a first-class `files` row (kind='pdf'), and
--      links it to the client/unit/project records via document_links. It then
--      calls document_job_complete with the new file id.
--   3. The SPA polls /api/document-status until the job reaches completed/failed
--      (never holds HTTP open for the render — same hard rule as every queue).
--   4. document_jobs_watchdog() sweeps jobs stuck 'running' >10 min.
--
-- Race-protection posture (mirrors the office-preview / compress queues):
--   - complete/fail only touch status='running' jobs.
--   - ONE active job per (record, template) via a partial unique index;
--     document_job_enqueue is the single, atomic enqueue path.
-- ============================================================================

BEGIN;

-- ─── 1. Job queue ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_jobs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Soft pointer — the source record may live in a frozen model's dedicated
  -- table outside public.records (same posture as document_links.record_id).
  source_record_id  uuid        NOT NULL,
  source_model_id   uuid        NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  -- The template binding + its underlying wassel_doc (denormalized so the claim
  -- can join straight to wassel_documents for the body).
  template_id       uuid        NOT NULL REFERENCES public.document_templates(id) ON DELETE CASCADE,
  template_file_id  uuid        NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  -- Where the generated PDF lands + who owns it. owner_user_id is the
  -- public.users id (→ files.uploaded_by_user_id, so RLS recognises the owner);
  -- owner_auth_uid is auth.uid() (the storage-path prefix, keeping the bucket's
  -- path convention coherent). Getting these two confused makes the file
  -- invisible to its owner — they are deliberately BOTH carried.
  target_folder_id  uuid        NULL REFERENCES public.folders(id) ON DELETE SET NULL,
  owner_user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_auth_uid    uuid        NOT NULL,
  -- Linked-record ids resolved from the source record (all nullable/soft).
  client_record_id  uuid        NULL,
  unit_record_id    uuid        NULL,
  project_record_id uuid        NULL,
  status            text        NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued','running','completed','failed')),
  attempts          int         NOT NULL DEFAULT 0,
  worker_id         text,
  error             text,
  -- The generated PDF. SET NULL so deleting the PDF later doesn't break history.
  result_file_id    uuid        NULL REFERENCES public.files(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

-- Worker claim hot path (queued tail only).
CREATE INDEX IF NOT EXISTS document_jobs_queued_by_age_idx
  ON public.document_jobs (created_at)
  WHERE status = 'queued';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS document_jobs_running_by_started_idx
  ON public.document_jobs (started_at)
  WHERE status = 'running';

-- ONE active job per (record, template); document_job_enqueue relies on this to
-- collapse concurrent "Generate" clicks into one job.
CREATE UNIQUE INDEX IF NOT EXISTS document_jobs_one_active_idx
  ON public.document_jobs (source_record_id, template_id)
  WHERE status IN ('queued','running');

-- The panel's "generated documents for this record" list + status poll.
CREATE INDEX IF NOT EXISTS document_jobs_source_idx
  ON public.document_jobs (source_model_id, source_record_id, created_at DESC);

-- Service-role only — the SPA never touches this table directly (it goes through
-- /api/generate-document + /api/document-status). RLS on with NO policies =
-- deny-all for anon/authenticated.
ALTER TABLE public.document_jobs ENABLE ROW LEVEL SECURITY;

-- ─── 2. RPC: document_job_enqueue ───────────────────────────────────────────
-- The single, atomic enqueue path. Returns the active job id (newly inserted or
-- the already-in-flight one) so the endpoint can hand the SPA a poll handle.
CREATE OR REPLACE FUNCTION public.document_job_enqueue(
  p_source_record_id  uuid,
  p_source_model_id   uuid,
  p_template_id       uuid,
  p_template_file_id  uuid,
  p_target_folder_id  uuid,
  p_owner_user_id     uuid,
  p_owner_auth_uid    uuid,
  p_client_record_id  uuid,
  p_unit_record_id    uuid,
  p_project_record_id uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.document_jobs (
    source_record_id, source_model_id, template_id, template_file_id,
    target_folder_id, owner_user_id, owner_auth_uid,
    client_record_id, unit_record_id, project_record_id
  )
  VALUES (
    p_source_record_id, p_source_model_id, p_template_id, p_template_file_id,
    p_target_folder_id, p_owner_user_id, p_owner_auth_uid,
    p_client_record_id, p_unit_record_id, p_project_record_id
  )
  ON CONFLICT (source_record_id, template_id) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;

  -- A concurrent click already had an active job — return that one.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
      FROM public.document_jobs
     WHERE source_record_id = p_source_record_id
       AND template_id = p_template_id
       AND status IN ('queued','running')
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.document_job_enqueue(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_enqueue(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid) TO service_role;

-- ─── 3. RPC: document_job_claim_next ────────────────────────────────────────
-- Atomically claims the oldest queued job and JOINs the template binding (for
-- its label, used in the PDF filename) + the template's wassel_documents body
-- (content_json + page settings) so the worker has the template in one trip.
CREATE OR REPLACE FUNCTION public.document_job_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id            uuid,
  source_record_id  uuid,
  source_model_id   uuid,
  template_id       uuid,
  template_file_id  uuid,
  target_folder_id  uuid,
  owner_user_id     uuid,
  owner_auth_uid    uuid,
  client_record_id  uuid,
  unit_record_id    uuid,
  project_record_id uuid,
  attempts          int,
  template_label_ar text,
  template_label_en text,
  content_json      jsonb,
  settings          jsonb
) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH claimed AS (
    UPDATE public.document_jobs j
       SET status     = 'running',
           worker_id  = p_worker_id,
           started_at = now(),
           attempts   = j.attempts + 1
     WHERE j.id = (
       SELECT id FROM public.document_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING j.id, j.source_record_id, j.source_model_id, j.template_id,
               j.template_file_id, j.target_folder_id, j.owner_user_id,
               j.owner_auth_uid, j.client_record_id, j.unit_record_id,
               j.project_record_id, j.attempts
  )
  SELECT c.id, c.source_record_id, c.source_model_id, c.template_id,
         c.template_file_id, c.target_folder_id, c.owner_user_id,
         c.owner_auth_uid, c.client_record_id, c.unit_record_id,
         c.project_record_id, c.attempts,
         dt.label_ar, dt.label_en,
         wd.content_json, wd.settings
    FROM claimed c
    JOIN public.document_templates dt ON dt.id = c.template_id
    JOIN public.wassel_documents   wd ON wd.file_id = dt.file_id;
$$;

REVOKE ALL ON FUNCTION public.document_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_claim_next(text) TO service_role;

-- ─── 4. RPC: document_job_complete ──────────────────────────────────────────
-- status='running' guard: a late finish after the watchdog already failed the
-- job is a no-op (the worker's already-inserted PDF row is real and usable).
CREATE OR REPLACE FUNCTION public.document_job_complete(p_job_id uuid, p_result_file_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.document_jobs
     SET status = 'completed',
         finished_at = now(),
         error = NULL,
         result_file_id = p_result_file_id
   WHERE id = p_job_id AND status = 'running'
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.document_job_complete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_complete(uuid, uuid) TO service_role;

-- ─── 5. RPC: document_job_fail ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.document_job_fail(p_job_id uuid, p_error text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.document_jobs
     SET status = 'failed', finished_at = now(), error = p_error
   WHERE id = p_job_id AND status = 'running'
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.document_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_fail(uuid, text) TO service_role;

-- ─── 6. Watchdog ────────────────────────────────────────────────────────────
-- A render is bounded at 240s in the worker (soffice ceiling). 10 min of
-- 'running' means a crashed worker / stopped machine. Sweep to failed so the
-- UI exits its spinner and offers retry. Invoked by the worker's watchdog tick.
CREATE OR REPLACE FUNCTION public.document_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH stale AS (
    UPDATE public.document_jobs
       SET status = 'failed',
           finished_at = now(),
           error = 'watchdog: generation did not finish within 10 minutes — likely crashed mid-run.'
     WHERE status = 'running'
       AND started_at < now() - interval '10 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM stale;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.document_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_jobs_watchdog() TO service_role;

COMMIT;
