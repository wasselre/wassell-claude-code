-- 2026-07-22 — claude_jobs: app-triggered Claude Code sessions (client studies v1)
-- ---------------------------------------------------------------------------
-- The chats UI gets a «توليد دراسة» button that enqueues a row here; a local
-- runner daemon (scripts/claude-study-runner.mjs, service-role) claims the job,
-- runs a FULL headless Claude Code session (`claude -p "/client-study <url>"`),
-- uploads the produced PDF to storage, and completes the job with a signed URL
-- + the WhatsApp draft. The SPA watches the row via Realtime/poll and shows a
-- review card. Same enqueue/claim/complete posture as the other seven queues:
-- complete/fail only touch running jobs; a watchdog sweeps stuck runners.
--
-- The runner executes ONE job at a time by design (shares the owner's Claude
-- account — sequential keeps interactive sessions unaffected).

CREATE TABLE IF NOT EXISTS public.claude_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('ping', 'client_study')),
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','running','ready','failed','cancelled')),
  result               jsonb,
  error                text,
  requested_by_user_id uuid,
  claimed_by           text,
  attempts             int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz
);

CREATE INDEX IF NOT EXISTS claude_jobs_status_idx  ON public.claude_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS claude_jobs_payload_chat_idx
  ON public.claude_jobs ((payload->>'chat_record_id'), created_at DESC);

ALTER TABLE public.claude_jobs ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can enqueue a study and see jobs (the card shows who
-- requested it). Updates/deletes are service-role only (no policies).
DROP POLICY IF EXISTS claude_jobs_insert ON public.claude_jobs;
CREATE POLICY claude_jobs_insert ON public.claude_jobs
  FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS claude_jobs_select ON public.claude_jobs;
CREATE POLICY claude_jobs_select ON public.claude_jobs
  FOR SELECT TO authenticated USING (true);

-- Realtime for the SPA card.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.claude_jobs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Runner RPCs (service-role only) ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
RETURNS SETOF public.claude_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.claude_jobs
  SET status = 'running', claimed_by = p_worker,
      started_at = now(), attempts = attempts + 1
  WHERE id = v_id
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.claude_job_complete(p_job_id uuid, p_result jsonb)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.claude_jobs
  SET status = 'ready', result = p_result, finished_at = now(), error = NULL
  WHERE id = p_job_id AND status = 'running'
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.claude_job_fail(p_job_id uuid, p_error text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.claude_jobs
  SET status = 'failed', error = left(coalesce(p_error, 'unknown'), 4000), finished_at = now()
  WHERE id = p_job_id AND status = 'running'
  RETURNING true;
$$;

-- Stuck sweep: a study session should finish well under 30 min; 45 min running
-- means the runner died mid-job.
CREATE OR REPLACE FUNCTION public.claude_jobs_watchdog()
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH swept AS (
    UPDATE public.claude_jobs
    SET status = 'failed', error = 'watchdog: runner did not finish within 45 minutes',
        finished_at = now()
    WHERE status = 'running' AND started_at < now() - interval '45 minutes'
    RETURNING 1
  )
  SELECT count(*)::int FROM swept;
$$;

REVOKE EXECUTE ON FUNCTION public.claude_job_claim_next(text)          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claude_job_complete(uuid, jsonb)     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claude_job_fail(uuid, text)          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claude_jobs_watchdog()               FROM anon, authenticated;
