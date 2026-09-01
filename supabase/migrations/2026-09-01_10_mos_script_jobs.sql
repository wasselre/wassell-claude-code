-- Background queue for the in-app «اكتب سكربت» video-script generator.
--
-- The AI write is a ~30–40s Anthropic call. Per the codebase rule (decks /
-- image-chats / documents), no HTTP request may be held open for it: the button
-- ENQUEUES a job and returns instantly, the Fly worker's script lane drains it,
-- inserts the generated scenes into mos_scenes, and emits a completion
-- notification. The SPA shows a progress bar driven by this row's status and
-- survives navigating away (the job lives in the DB, not the tab).
--
-- Storage shape mirrors the other single-owner queues (deck_jobs): claim via
-- FOR UPDATE SKIP LOCKED, complete/fail only touch 'running' rows, a watchdog
-- sweeps crashes. Reads/writes from the browser go through the endpoint's
-- service client; the worker uses service_role. RLS is enabled with NO policies
-- so a bare browser JWT can never touch the table directly.

CREATE TABLE IF NOT EXISTS public.mos_script_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id    uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  recipe        text NOT NULL,
  requested_by  uuid,   -- public.users.id (notify target); nullable defensively
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','completed','failed')),
  worker_id     text,
  attempts      int  NOT NULL DEFAULT 0,
  scene_count   int,
  hooks         jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- At most ONE active (queued|running) job per content item, so a double-click
-- or a poll race can never fan out duplicate generations.
CREATE UNIQUE INDEX IF NOT EXISTS mos_script_jobs_one_active
  ON public.mos_script_jobs (content_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS mos_script_jobs_claim
  ON public.mos_script_jobs (created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS mos_script_jobs_content
  ON public.mos_script_jobs (content_id, created_at DESC);

ALTER TABLE public.mos_script_jobs ENABLE ROW LEVEL SECURITY;
-- No policies by design: the endpoint (service client) and the worker
-- (service_role) are the only writers/readers; both bypass RLS.

-- ── worker RPCs (service_role) ───────────────────────────────────────────────

-- Claim the oldest queued job. FOR UPDATE SKIP LOCKED guarantees no two of the
-- 5 worker machines ever claim the same row.
CREATE OR REPLACE FUNCTION public.mos_script_job_claim_next(p_worker_id text)
RETURNS TABLE (job_id uuid, content_id uuid, recipe text, requested_by uuid, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r public.mos_script_jobs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.mos_script_jobs
   WHERE status = 'queued'
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.mos_script_jobs
     SET status = 'running', started_at = now(), worker_id = p_worker_id,
         attempts = r.attempts + 1  -- qualify: bare `attempts` is ambiguous with the OUT param
   WHERE id = r.id;

  job_id := r.id; content_id := r.content_id; recipe := r.recipe;
  requested_by := r.requested_by; attempts := r.attempts + 1;
  RETURN NEXT;
END;
$$;

-- Complete only touches a 'running' row — a late finish after a watchdog fail is
-- a harmless no-op (same guard as every other queue).
CREATE OR REPLACE FUNCTION public.mos_script_job_complete(
  p_job_id uuid, p_scene_count int, p_hooks jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_script_jobs
     SET status = 'completed', scene_count = p_scene_count, hooks = p_hooks,
         error = NULL, finished_at = now()
   WHERE id = p_job_id AND status = 'running';
$$;

CREATE OR REPLACE FUNCTION public.mos_script_job_fail(p_job_id uuid, p_error text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_script_jobs
     SET status = 'failed', error = LEFT(COALESCE(p_error, 'unknown'), 2000),
         finished_at = now()
   WHERE id = p_job_id AND status = 'running';
$$;

-- Sweep jobs stuck 'running' > 5 min (the AI write is ~40s; 5 min covers a
-- crash / OOM / machine stop mid-job). Returns the count swept.
CREATE OR REPLACE FUNCTION public.mos_script_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE n int;
BEGIN
  UPDATE public.mos_script_jobs
     SET status = 'failed', error = 'watchdog: stuck running > 5 min', finished_at = now()
   WHERE status = 'running' AND started_at < now() - interval '5 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.mos_script_job_claim_next(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mos_script_job_complete(uuid, int, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mos_script_job_fail(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mos_script_jobs_watchdog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_script_job_claim_next(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_script_job_complete(uuid, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_script_job_fail(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_script_jobs_watchdog() TO service_role;
