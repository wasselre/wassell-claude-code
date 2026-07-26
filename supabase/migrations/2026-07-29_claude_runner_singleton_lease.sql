-- ============================================================================
-- Singleton lease for the Claude Code runner + clean-shutdown job interruption.
--
-- Operator discipline is not enough: two runners raced during the first live
-- validation (both drained the same queue concurrently). Ownership is now
-- enforced in the DB — ONE row, atomic compare-and-set acquisition, heartbeat
-- renewal, expiry-based takeover. Every time comparison uses the DATABASE clock
-- (now()), so client clock skew can never produce two simultaneous owners.
--
-- claude_job_interrupt lets a cleanly-shutting-down runner hand its in-flight job
-- straight back to the queue instead of leaving it 'running' for the full
-- 45-minute crash watchdog. The watchdog remains the safety net for hard crashes
-- and machine loss.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.claude_runner_lease (
  lease_name   text PRIMARY KEY,
  owner_id     text NOT NULL,
  host         text,
  pid          integer,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  released_at  timestamptz
);
ALTER TABLE public.claude_runner_lease ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claude_runner_lease_read ON public.claude_runner_lease;
CREATE POLICY claude_runner_lease_read ON public.claude_runner_lease FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.claude_runner_lease_acquire(
  p_lease text, p_owner text, p_host text, p_pid int, p_ttl_seconds int DEFAULT 120)
RETURNS TABLE(acquired boolean, current_owner text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.claude_runner_lease;
BEGIN
  INSERT INTO public.claude_runner_lease AS l (lease_name, owner_id, host, pid, acquired_at, heartbeat_at, expires_at, released_at)
  VALUES (p_lease, p_owner, p_host, p_pid, now(), now(), now() + make_interval(secs => p_ttl_seconds), NULL)
  ON CONFLICT (lease_name) DO UPDATE
    SET owner_id = p_owner, host = p_host, pid = p_pid,
        acquired_at = CASE WHEN l.owner_id = p_owner THEN l.acquired_at ELSE now() END,
        heartbeat_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds),
        released_at = NULL
    WHERE l.owner_id = p_owner OR l.expires_at < now() OR l.released_at IS NOT NULL
  RETURNING * INTO v_row;

  IF v_row.lease_name IS NOT NULL THEN
    RETURN QUERY SELECT true, v_row.owner_id, v_row.expires_at; RETURN;
  END IF;
  SELECT * INTO v_row FROM public.claude_runner_lease WHERE lease_name = p_lease;
  RETURN QUERY SELECT false, v_row.owner_id, v_row.expires_at;
END $$;

CREATE OR REPLACE FUNCTION public.claude_runner_lease_release(p_lease text, p_owner text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.claude_runner_lease SET released_at = now(), expires_at = now()
   WHERE lease_name = p_lease AND owner_id = p_owner;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION public.claude_runner_lease_status(p_lease text DEFAULT 'marketing_intelligence')
RETURNS TABLE(lease_name text, owner_id text, host text, pid int, acquired_at timestamptz,
              heartbeat_at timestamptz, expires_at timestamptz, is_live boolean, heartbeat_age_seconds int)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT l.lease_name, l.owner_id, l.host, l.pid, l.acquired_at, l.heartbeat_at, l.expires_at,
         (l.released_at IS NULL AND l.expires_at > now()) AS is_live,
         EXTRACT(EPOCH FROM (now() - l.heartbeat_at))::int AS heartbeat_age_seconds
  FROM public.claude_runner_lease l WHERE l.lease_name = p_lease;
$$;

-- compare-and-set: only the claiming runner, only while still 'running'
CREATE OR REPLACE FUNCTION public.claude_job_interrupt(p_job_id uuid, p_owner text, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.claude_jobs
     SET status='pending', claimed_by=NULL, started_at=NULL,
         error = coalesce(p_reason,'interrupted by runner shutdown')
   WHERE id = p_job_id AND status='running' AND claimed_by = p_owner;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n > 0;
END $$;

GRANT EXECUTE ON FUNCTION public.claude_runner_lease_acquire(text,text,text,int,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.claude_runner_lease_release(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claude_runner_lease_status(text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.claude_job_interrupt(uuid,text,text) TO service_role;
