-- ============================================================================
-- 2026-06-11: PDF compression pipeline (Ghostscript on the Fly worker)
-- ----------------------------------------------------------------------------
-- "Compress PDF" action in the Files system. Self-hosted with Ghostscript on
-- the existing Fly worker — the iLovePDF API was evaluated and rejected for
-- the same reason the office-preview pipeline rejected Microsoft/Google
-- viewers: file bytes must never leave Wassel infrastructure (plus a
-- 250-files/month cap that dies instantly under bulk compression).
--
-- Architecture (FOURTH queue on the worker, same pattern as deck_jobs /
-- generation_jobs / file_preview_jobs):
--   1. /api/files/compress-pdf (authenticated, start=true) calls
--      pdf_compress_enqueue() via service-role after the caller's edit check.
--   2. The Fly worker's compress poll loop claims via pdf_compress_claim_next
--      (FOR UPDATE SKIP LOCKED), downloads the original from wassel-files,
--      runs `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook`, uploads the result
--      as a NEW storage object, INSERTs a NEW files row ("<name> (مضغوط).pdf",
--      same folder / record link / owner as the source — originals are never
--      replaced; file bytes are immutable in this system), and calls
--      pdf_compress_complete with the new file id + before/after sizes.
--      If compression saves <5%, the job completes with result_file_id NULL
--      ("no gain") and no copy is created.
--   3. The SPA polls /api/files/compress-pdf (no start flag) until the latest
--      job for the file reaches completed/failed.
--   4. pdf_compress_watchdog() sweeps jobs stuck 'running' >10 min — invoked
--      by the worker on its watchdog interval (pg_cron is NOT enabled here).
--
-- Race-protection posture (mirrors deck_jobs rules 3+4):
--   - complete/fail only touch status='running' jobs.
--   - ONE active job per file via a partial unique index; pdf_compress_enqueue
--     is the single, atomic enqueue path (concurrent clicks collapse).
-- ============================================================================

BEGIN;

-- ─── 1. Job queue ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pdf_compress_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: deleting the source file removes any queued/running job with it.
  file_id          uuid        NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  status           text        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued','running','completed','failed')),
  attempts         int         NOT NULL DEFAULT 0,
  worker_id        text,
  error            text,
  -- The compressed COPY created by the worker. NULL on a completed job means
  -- "no gain" — the source was already well-optimized and no copy was made.
  -- SET NULL: the result row being deleted later must not break job history.
  result_file_id   uuid        NULL REFERENCES public.files(id) ON DELETE SET NULL,
  original_bytes   bigint,
  compressed_bytes bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

-- Worker claim hot path (queued tail only).
CREATE INDEX IF NOT EXISTS pdf_compress_jobs_queued_by_age_idx
  ON public.pdf_compress_jobs (created_at)
  WHERE status = 'queued';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS pdf_compress_jobs_running_by_started_idx
  ON public.pdf_compress_jobs (started_at)
  WHERE status = 'running';

-- Per-file lookup + the ONE-ACTIVE-JOB-PER-FILE guarantee. pdf_compress_enqueue
-- relies on this index to make concurrent enqueues collapse into one job.
CREATE UNIQUE INDEX IF NOT EXISTS pdf_compress_jobs_one_active_per_file_idx
  ON public.pdf_compress_jobs (file_id)
  WHERE status IN ('queued','running');

-- The endpoint's poll path: latest job for a file.
CREATE INDEX IF NOT EXISTS pdf_compress_jobs_file_idx
  ON public.pdf_compress_jobs (file_id, created_at DESC);

-- Service-role only — the SPA never touches this table directly (it polls the
-- /api/files/compress-pdf endpoint, which reads the latest job after the
-- access check). RLS enabled with NO policies = deny-all for anon/authenticated.
ALTER TABLE public.pdf_compress_jobs ENABLE ROW LEVEL SECURITY;

-- ─── 2. RPC: pdf_compress_enqueue ───────────────────────────────────────────
-- The single enqueue path. Unlike file_preview_enqueue there is no file-level
-- result cache (each compress request is a fresh job — the user may compress,
-- delete the copy, and compress again), so this only collapses concurrent
-- requests into the one active job. Returns:
--   'pending' — a job is queued/running (newly inserted or already in flight)
--   NULL      — file not found
CREATE OR REPLACE FUNCTION public.pdf_compress_enqueue(p_file_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Insert unless an active job already exists (partial unique index makes
  -- this race-safe: a concurrent insert collapses into DO NOTHING).
  INSERT INTO public.pdf_compress_jobs (file_id)
  VALUES (p_file_id)
  ON CONFLICT (file_id) WHERE status IN ('queued','running') DO NOTHING;

  RETURN 'pending';
END $$;

REVOKE ALL ON FUNCTION public.pdf_compress_enqueue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pdf_compress_enqueue(uuid) TO service_role;

-- ─── 3. RPC: pdf_compress_claim_next ────────────────────────────────────────
-- Atomically claims the oldest queued job. Joins the file row so the worker
-- gets everything it needs in one round-trip — including folder/record links
-- and the uploader, which the worker copies onto the NEW files row so the
-- compressed copy lands next to the original with identical visibility.
CREATE OR REPLACE FUNCTION public.pdf_compress_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id              uuid,
  file_id             uuid,
  attempts            int,
  storage_bucket      text,
  storage_path        text,
  mime_type           text,
  size_bytes          bigint,
  original_name       text,
  folder_id           uuid,
  model_id            uuid,
  record_id           uuid,
  uploaded_by_user_id uuid
) LANGUAGE sql SECURITY DEFINER AS $$
  WITH claimed AS (
    UPDATE public.pdf_compress_jobs j
       SET status     = 'running',
           worker_id  = p_worker_id,
           started_at = now(),
           attempts   = j.attempts + 1
     WHERE j.id = (
       SELECT id FROM public.pdf_compress_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING j.id, j.file_id, j.attempts
  )
  SELECT c.id, c.file_id, c.attempts,
         f.storage_bucket, f.storage_path, f.mime_type, f.size_bytes, f.original_name,
         f.folder_id, f.model_id, f.record_id, f.uploaded_by_user_id
    FROM claimed c
    JOIN public.files f ON f.id = c.file_id;
$$;

REVOKE ALL ON FUNCTION public.pdf_compress_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pdf_compress_claim_next(text) TO service_role;

-- ─── 4. RPC: pdf_compress_complete ──────────────────────────────────────────
-- status='running' guard: a late finish after the watchdog already failed the
-- job is a no-op (the worker's already-inserted files row is real and usable —
-- it just isn't pointed at by the job; harmless duplicate at worst).
CREATE OR REPLACE FUNCTION public.pdf_compress_complete(
  p_job_id uuid,
  p_result_file_id uuid,
  p_original_bytes bigint,
  p_compressed_bytes bigint
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_file uuid;
BEGIN
  UPDATE public.pdf_compress_jobs
     SET status = 'completed',
         finished_at = now(),
         error = NULL,
         result_file_id = p_result_file_id,
         original_bytes = p_original_bytes,
         compressed_bytes = p_compressed_bytes
   WHERE id = p_job_id AND status = 'running'
  RETURNING file_id INTO v_file;
  RETURN v_file IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.pdf_compress_complete(uuid, uuid, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pdf_compress_complete(uuid, uuid, bigint, bigint) TO service_role;

-- ─── 5. RPC: pdf_compress_fail ──────────────────────────────────────────────
-- Same running-only guard.
CREATE OR REPLACE FUNCTION public.pdf_compress_fail(p_job_id uuid, p_error text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_file uuid;
BEGIN
  UPDATE public.pdf_compress_jobs
     SET status = 'failed', finished_at = now(), error = p_error
   WHERE id = p_job_id AND status = 'running'
  RETURNING file_id INTO v_file;
  RETURN v_file IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.pdf_compress_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pdf_compress_fail(uuid, text) TO service_role;

-- ─── 5b. RPC: pdf_compress_requeue ──────────────────────────────────────────
-- Timeout self-heal. Fly shared-cpu machines throttle to 1/16 vCPU once their
-- burst credits drain (live 2026-06-11: a 19 MB brochure needs ~95 s of CPU —
-- 2m50s on a credit-fresh machine, >9 min on a drained one). When a gs run
-- times out, the worker requeues the job (attempts < 3) instead of failing it,
-- so a different — likely fresh — machine claims it. Running-only guard, same
-- as complete/fail. attempts is NOT reset; claim_next increments it.
CREATE OR REPLACE FUNCTION public.pdf_compress_requeue(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_file uuid;
BEGIN
  UPDATE public.pdf_compress_jobs
     SET status = 'queued', worker_id = NULL, started_at = NULL
   WHERE id = p_job_id AND status = 'running'
  RETURNING file_id INTO v_file;
  RETURN v_file IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.pdf_compress_requeue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pdf_compress_requeue(uuid) TO service_role;

-- ─── 6. Watchdog ────────────────────────────────────────────────────────────
-- A gs run is bounded at 540s in the worker (raised from 240s after a live
-- 19 MB brochure — the primary use case — hit the shared-cpu ceiling on
-- 2026-06-11) — 15 min of 'running' means a crashed worker / stopped machine.
-- Sweep to failed so the UI exits its spinner and offers retry. Invoked by
-- the Fly worker on its watchdog interval.
CREATE OR REPLACE FUNCTION public.pdf_compress_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH stale AS (
    UPDATE public.pdf_compress_jobs
       SET status = 'failed',
           finished_at = now(),
           error = 'watchdog: compression did not finish within 15 minutes — likely crashed mid-run.'
     WHERE status = 'running'
       AND started_at < now() - interval '15 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM stale;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.pdf_compress_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pdf_compress_watchdog() TO service_role;

COMMIT;
