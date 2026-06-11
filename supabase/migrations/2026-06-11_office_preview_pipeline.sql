-- ============================================================================
-- 2026-06-11: Office document preview pipeline (DOC/DOCX/PPT/PPTX/XLS/XLSX)
-- ----------------------------------------------------------------------------
-- Inline preview for office documents WITHOUT sending bytes to a third-party
-- viewer (Microsoft/Google embed viewers were rejected — they require handing
-- a fetchable URL of the file to an external service, contradicting the Files
-- system's private-by-default posture; see docs/prd/files.md).
--
-- Architecture (same queue pattern as deck_jobs / generation_jobs):
--   1. /api/files/office-preview (authenticated) or /api/share/view (anon,
--      token-validated) calls file_preview_enqueue() via service-role.
--   2. The Fly.io worker's preview poll loop claims via
--      file_preview_claim_next (FOR UPDATE SKIP LOCKED), downloads the
--      original from wassel-files, converts with headless LibreOffice
--      (soffice --convert-to pdf), uploads the artifact to
--      <uploader_auth_uid>/<file_id>.preview.pdf in the SAME private bucket,
--      and calls file_preview_complete.
--   3. The SPA polls /api/files/office-preview until status='ready', then
--      renders the cached PDF through the existing PDF iframe path.
--      Conversion happens ONCE per file (bytes are immutable — no
--      re-upload-in-place exists in this system), so every later preview is
--      instant.
--   4. file_preview_watchdog() sweeps jobs stuck 'running' >10 min (worker
--      crash / fly machine stop) — invoked by the worker on its watchdog
--      interval, same as the other queues (pg_cron is NOT enabled here).
--
-- Race-protection posture (mirrors deck_jobs rules 3+4):
--   - complete/fail only touch status='running' jobs.
--   - fail/watchdog never clobber files.preview_status='ready'.
--   - ONE active job per file is enforced by a partial unique index;
--     file_preview_enqueue is the single, atomic enqueue path.
-- ============================================================================

BEGIN;

-- ─── 1. Preview cache state on files ───────────────────────────────────────
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS preview_status text NULL
    CHECK (preview_status IN ('pending','ready','failed')),
  ADD COLUMN IF NOT EXISTS preview_storage_path text NULL,
  ADD COLUMN IF NOT EXISTS preview_error text NULL,
  ADD COLUMN IF NOT EXISTS preview_generated_at timestamptz NULL;

-- ─── 2. Job queue ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.file_preview_jobs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: deleting the file removes any queued/running conversion with it.
  file_id     uuid        NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','completed','failed')),
  attempts    int         NOT NULL DEFAULT 0,
  worker_id   text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- Worker claim hot path (queued tail only).
CREATE INDEX IF NOT EXISTS file_preview_jobs_queued_by_age_idx
  ON public.file_preview_jobs (created_at)
  WHERE status = 'queued';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS file_preview_jobs_running_by_started_idx
  ON public.file_preview_jobs (started_at)
  WHERE status = 'running';

-- Per-file lookup + the ONE-ACTIVE-JOB-PER-FILE guarantee. file_preview_enqueue
-- relies on this index to make concurrent enqueues collapse into one job.
CREATE UNIQUE INDEX IF NOT EXISTS file_preview_jobs_one_active_per_file_idx
  ON public.file_preview_jobs (file_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS file_preview_jobs_file_idx
  ON public.file_preview_jobs (file_id, created_at DESC);

-- Service-role only — the SPA never touches this table directly (it polls the
-- /api/files/office-preview endpoint, which reads files.preview_* after the
-- access check). RLS enabled with NO policies = deny-all for anon/authenticated.
ALTER TABLE public.file_preview_jobs ENABLE ROW LEVEL SECURITY;

-- ─── 3. RPC: file_preview_enqueue ──────────────────────────────────────────
-- The single enqueue path. Returns the resulting preview state:
--   'ready'   — cached preview already exists, nothing enqueued
--   'pending' — a job is queued/running (newly inserted or already in flight)
--   'failed'  — a previous attempt failed and p_force=false (caller may retry
--               with p_force=true, which clears the failure and re-enqueues)
--   NULL      — file not found
CREATE OR REPLACE FUNCTION public.file_preview_enqueue(p_file_id uuid, p_force boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  f public.files%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF f.preview_status = 'ready' AND f.preview_storage_path IS NOT NULL THEN
    RETURN 'ready';
  END IF;
  IF f.preview_status = 'failed' AND NOT p_force THEN
    RETURN 'failed';
  END IF;

  -- Insert unless an active job already exists (partial unique index makes
  -- this race-safe: a concurrent insert collapses into DO NOTHING).
  INSERT INTO public.file_preview_jobs (file_id)
  VALUES (p_file_id)
  ON CONFLICT (file_id) WHERE status IN ('queued','running') DO NOTHING;

  UPDATE public.files
     SET preview_status = 'pending', preview_error = NULL
   WHERE id = p_file_id;

  RETURN 'pending';
END $$;

REVOKE ALL ON FUNCTION public.file_preview_enqueue(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_preview_enqueue(uuid, boolean) TO service_role;

-- ─── 4. RPC: file_preview_claim_next ───────────────────────────────────────
-- Atomically claims the oldest queued job. Joins the file row so the worker
-- gets everything it needs in one round-trip.
CREATE OR REPLACE FUNCTION public.file_preview_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id        uuid,
  file_id       uuid,
  attempts      int,
  storage_bucket text,
  storage_path  text,
  mime_type     text,
  size_bytes    bigint,
  original_name text
) LANGUAGE sql SECURITY DEFINER AS $$
  WITH claimed AS (
    UPDATE public.file_preview_jobs j
       SET status     = 'running',
           worker_id  = p_worker_id,
           started_at = now(),
           attempts   = j.attempts + 1
     WHERE j.id = (
       SELECT id FROM public.file_preview_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING j.id, j.file_id, j.attempts
  )
  SELECT c.id, c.file_id, c.attempts,
         f.storage_bucket, f.storage_path, f.mime_type, f.size_bytes, f.original_name
    FROM claimed c
    JOIN public.files f ON f.id = c.file_id;
$$;

REVOKE ALL ON FUNCTION public.file_preview_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_preview_claim_next(text) TO service_role;

-- ─── 5. RPC: file_preview_complete ─────────────────────────────────────────
-- Marks a running job completed AND flips the file to ready, atomically.
-- status='running' guard: a late finish after the watchdog already failed the
-- job is a no-op (the artifact upload is harmless — it just sits cached for
-- the retry to claim instantly).
CREATE OR REPLACE FUNCTION public.file_preview_complete(p_job_id uuid, p_preview_path text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_file uuid;
BEGIN
  UPDATE public.file_preview_jobs
     SET status = 'completed', finished_at = now(), error = NULL
   WHERE id = p_job_id AND status = 'running'
  RETURNING file_id INTO v_file;
  IF v_file IS NULL THEN RETURN false; END IF;

  UPDATE public.files
     SET preview_status = 'ready',
         preview_storage_path = p_preview_path,
         preview_generated_at = now(),
         preview_error = NULL
   WHERE id = v_file;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.file_preview_complete(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_preview_complete(uuid, text) TO service_role;

-- ─── 6. RPC: file_preview_fail ─────────────────────────────────────────────
-- Same running-only guard. Never clobbers a 'ready' file state (deck rule #4):
-- if a racing path already produced a usable preview, the failure is moot.
CREATE OR REPLACE FUNCTION public.file_preview_fail(p_job_id uuid, p_error text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_file uuid;
BEGIN
  UPDATE public.file_preview_jobs
     SET status = 'failed', finished_at = now(), error = p_error
   WHERE id = p_job_id AND status = 'running'
  RETURNING file_id INTO v_file;
  IF v_file IS NULL THEN RETURN false; END IF;

  UPDATE public.files
     SET preview_status = 'failed', preview_error = p_error
   WHERE id = v_file
     AND preview_status IS DISTINCT FROM 'ready';
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.file_preview_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_preview_fail(uuid, text) TO service_role;

-- ─── 7. Watchdog ────────────────────────────────────────────────────────────
-- Conversions are seconds, not minutes — 10 min of 'running' means a crashed
-- worker / stopped machine. Sweep to failed so the UI exits its spinner and
-- offers retry. Invoked by the Fly worker on its watchdog interval.
CREATE OR REPLACE FUNCTION public.file_preview_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
  v_msg   text := 'watchdog: preview conversion did not finish within 10 minutes — likely crashed mid-run.';
BEGIN
  WITH stale AS (
    UPDATE public.file_preview_jobs
       SET status = 'failed', finished_at = now(), error = v_msg
     WHERE status = 'running'
       AND started_at < now() - interval '10 minutes'
    RETURNING file_id
  ),
  flipped AS (
    UPDATE public.files f
       SET preview_status = 'failed', preview_error = v_msg
      FROM stale s
     WHERE f.id = s.file_id
       AND f.preview_status IS DISTINCT FROM 'ready'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM stale;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.file_preview_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_preview_watchdog() TO service_role;

COMMIT;
