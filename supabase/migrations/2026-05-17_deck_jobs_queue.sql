-- ============================================================================
-- 2026-05-17: deck_jobs queue for the Fly.io worker pipeline
-- ----------------------------------------------------------------------------
-- Replaces the long-running Vercel Edge function with a Postgres-backed job
-- queue processed by an always-on Fly.io Node worker. Architecture:
--
--   1. POST /api/generate-deck (slim Edge function) validates auth + the
--      request, inserts one `deck_jobs` row with status='pending', and
--      returns 200 immediately. No SSE, no Anthropic call.
--   2. The Fly.io worker polls every ~3 seconds via deck_job_claim_next(),
--      atomically claims a pending row (FOR UPDATE SKIP LOCKED), runs the
--      generation pipeline (Anthropic Skills + code_execution → bytes →
--      Supabase Storage upload → signed URL), and at each phase writes the
--      result into the corresponding `decks` record.
--   3. The SPA receives those record updates via Supabase Realtime
--      (already wired in appStore) — no SSE stream, no held HTTP request.
--   4. A pg_cron watchdog runs every 5 minutes and flips any job stuck in
--      'running' for >20 minutes to 'failed', also updating the deck
--      record so the UI swaps spinner → "Try again" instead of being
--      stuck forever (which is what motivated this whole refactor).
--
-- Auth: the worker authenticates with the Supabase service-role key
-- (writes bypass RLS). It enforces ownership by reading user_id from the
-- `deck_jobs` row and matching against the deck record's owner before
-- writing back. JWT-in-DB is avoided (no expiry risk, no secret-in-DB
-- smell). See worker/src/runDeckJob.ts.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deck_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The `decks` record (in public.records) this job produces output into.
  -- CASCADE so deleting the deck cancels any pending/running job for it.
  deck_record_id  uuid        NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  -- auth.users id of the submitter. Worker uses this to validate ownership
  -- before writing back to the deck record.
  user_id         uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','running','done','failed')),
  attempts        int         NOT NULL DEFAULT 0,
  -- Frozen snapshot of the request body. Worker reads everything it
  -- needs from here so the user editing the record between enqueue and
  -- claim doesn't cause drift.
  --   { brief, language, model, size, attachments }
  payload         jsonb       NOT NULL,
  -- Identifier of the worker process that claimed this job. Useful for
  -- debugging when multiple Fly.io machines are running.
  worker_id       text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────
-- Hot path: the worker's claim query —
--   SELECT ... WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED
-- Partial index keeps it tiny (only the in-flight tail of the queue).
CREATE INDEX IF NOT EXISTS deck_jobs_pending_by_age_idx
  ON public.deck_jobs (created_at)
  WHERE status = 'pending';

-- Watchdog hot path: find stale running jobs every 5 minutes.
CREATE INDEX IF NOT EXISTS deck_jobs_running_by_started_at_idx
  ON public.deck_jobs (started_at)
  WHERE status = 'running';

-- Per-user lookup (debugging / future "my jobs" admin view).
CREATE INDEX IF NOT EXISTS deck_jobs_user_id_created_at_idx
  ON public.deck_jobs (user_id, created_at DESC);

-- Per-record lookup (find the latest job for a given deck).
CREATE INDEX IF NOT EXISTS deck_jobs_record_id_idx
  ON public.deck_jobs (deck_record_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.deck_jobs ENABLE ROW LEVEL SECURITY;

-- Users can only SELECT their own jobs. They cannot insert/update/delete
-- directly — the API endpoint (service role) inserts, the worker
-- (service role) updates, and CASCADE on the deck record handles delete.
DROP POLICY IF EXISTS "deck_jobs_owner_select" ON public.deck_jobs;
CREATE POLICY "deck_jobs_owner_select"
  ON public.deck_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- RPC: deck_job_claim_next
-- ----------------------------------------------------------------------
-- Atomically claims the oldest pending job for the calling worker.
-- Uses FOR UPDATE SKIP LOCKED so multiple worker processes/machines
-- never claim the same row. Returns 0 rows if the queue is empty.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.deck_job_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id          uuid,
  deck_record_id  uuid,
  user_id         uuid,
  payload         jsonb,
  attempts        int
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.deck_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = deck_jobs.attempts + 1
   WHERE id = (
     SELECT id
       FROM public.deck_jobs
      WHERE status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING id, deck_record_id, user_id, payload, attempts;
$$;

REVOKE ALL ON FUNCTION public.deck_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deck_job_claim_next(text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: deck_job_complete
-- ----------------------------------------------------------------------
-- Marks a running job as done. Guarded by `status='running'` so if the
-- watchdog has already marked it failed (worker took >20 min), we don't
-- overwrite that — the worker logs a warning and moves on.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.deck_job_complete(p_job_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.deck_jobs
       SET status       = 'done',
           completed_at = now(),
           error        = NULL
     WHERE id = p_job_id
       AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.deck_job_complete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deck_job_complete(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: deck_job_fail
-- ----------------------------------------------------------------------
-- Marks a running job as permanently failed with an error message.
-- Same `status='running'` guard as complete — see above.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.deck_job_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.deck_jobs
       SET status       = 'failed',
           completed_at = now(),
           error        = p_error
     WHERE id = p_job_id
       AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.deck_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deck_job_fail(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Watchdog
-- ----------------------------------------------------------------------
-- Flips any job stuck in 'running' for >20 min to 'failed' AND reflects
-- that on the corresponding deck record so the UI exits its spinner via
-- Realtime. 20 min is well above any realistic Opus+skills generation
-- (typical 3-7 min; pathological ~12 min); the worker also self-times
-- at internal step boundaries, so 20 min is a backstop for crashes.
--
-- Race protection: only updates the deck record if its status is still
-- 'generating' — if the worker raced ahead and wrote 'ready' first,
-- we leave that alone.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.deck_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count int := 0;
  v_msg   text := 'watchdog: worker did not finish within 20 minutes — likely crashed mid-run. Press Try again to retry.';
BEGIN
  WITH stale AS (
    UPDATE public.deck_jobs
       SET status       = 'failed',
           completed_at = now(),
           error        = v_msg
     WHERE status = 'running'
       AND started_at < now() - interval '20 minutes'
     RETURNING id, deck_record_id
  ),
  -- Reflect on the deck record so the UI swaps spinner → Try again.
  recs AS (
    UPDATE public.records r
       SET data = r.data || jsonb_build_object(
             'status', 'failed',
             'error_message', v_msg
           ),
           updated_at = now()
      FROM stale s
     WHERE r.id = s.deck_record_id
       AND COALESCE(r.data->>'status','') = 'generating'
  )
  SELECT COUNT(*) INTO v_count FROM stale;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.deck_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deck_jobs_watchdog() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- pg_cron schedule (best-effort — extension not enabled on this Supabase)
-- ----------------------------------------------------------------------
-- Runs every 5 minutes IF pg_cron is available. On the wassell-prod
-- project the extension is NOT installed, so this block is a no-op and
-- the Fly.io worker's main loop runs deck_jobs_watchdog() every 5
-- minutes instead (see worker/src/index.ts). The function is also
-- callable manually from psql / Supabase SQL editor for ad-hoc cleanup.
-- ────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Idempotent: unschedule first, ignore if it doesn't exist yet.
    BEGIN
      PERFORM cron.unschedule('deck_jobs_watchdog');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule(
      'deck_jobs_watchdog',
      '*/5 * * * *',
      $cmd$SELECT public.deck_jobs_watchdog();$cmd$
    );
  END IF;
END $$;

COMMIT;
