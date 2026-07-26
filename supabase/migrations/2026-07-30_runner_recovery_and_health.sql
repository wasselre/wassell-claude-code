-- ============================================================================
-- 2026-07-30 — Always-on runner: crash recovery + operational health surface.
--
-- The runner now lives on Fly (app "wassel-claude-runner"), not a developer
-- laptop. Two gaps surfaced while proving that deployment:
--
-- 1. CRASH RECOVERY. claude_jobs_watchdog() is invoked BY THE RUNNER every 5
--    minutes — so when the runner dies mid-job, nothing sweeps until it comes
--    back, and even then the job must age 45 minutes before the watchdog frees
--    it. A hard machine loss therefore stalled that job for ~45 minutes.
--    claude_jobs_recover_orphaned() closes this: the runner calls it once at
--    boot, right after winning the lease. Winning the lease PROVES the previous
--    owner stopped heartbeating for a full TTL, so any job still 'running' under
--    a different owner is abandoned and safe to requeue. Recovery is seconds
--    instead of 45 minutes; the watchdog stays as the backstop for the case
--    where the runner never returns.
--
-- 2. OPERATIONAL VISIBILITY. Nothing in the app could answer "is the runner
--    alive, where does it run, what is it doing, how deep is the queue".
--    claude_runner_health() returns that in one read-only call, safe for the
--    UI: no OAuth token, no credentials, no job payloads, no evidence — only
--    identifiers, states, counts and ages.
-- ============================================================================

-- ── 1. Boot-time recovery of jobs orphaned by a runner crash ────────────────
-- Only touches jobs claimed by a DIFFERENT owner: a job this same process is
-- legitimately running must never be yanked out from under it. The started_at
-- floor is a second belt — it must stay above claude_runner_lease's TTL (120s)
-- so a merely-slow heartbeat can never look like a death.
CREATE OR REPLACE FUNCTION public.claude_jobs_recover_orphaned(
  p_owner text,
  p_min_age_seconds int DEFAULT 180,
  p_max_attempts int DEFAULT 3
)
RETURNS TABLE(job_id uuid, kind text, prior_owner text, action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH orphaned AS (
    SELECT j.id, j.kind AS j_kind, j.claimed_by, j.attempts
    FROM public.claude_jobs j
    WHERE j.status = 'running'
      AND j.claimed_by IS DISTINCT FROM p_owner
      AND j.started_at < now() - make_interval(secs => p_min_age_seconds)
    FOR UPDATE
  ),
  -- Under the attempt ceiling: hand it back to the queue.
  requeued AS (
    UPDATE public.claude_jobs j
    SET status = 'pending', claimed_by = NULL, started_at = NULL,
        error = format('recovered: runner %s died mid-job (attempt %s)', o.claimed_by, o.attempts)
    FROM orphaned o
    WHERE j.id = o.id AND o.attempts < p_max_attempts
    RETURNING j.id, o.j_kind, o.claimed_by, 'requeued'::text AS act
  ),
  -- At/over the ceiling: a job that kills the runner every time would otherwise
  -- crash-loop forever. Fail it loudly instead so it shows up in health.
  failed AS (
    UPDATE public.claude_jobs j
    SET status = 'failed', finished_at = now(),
        error = format('recovered: runner %s died mid-job %s times — not retried', o.claimed_by, o.attempts)
    FROM orphaned o
    WHERE j.id = o.id AND o.attempts >= p_max_attempts
    RETURNING j.id, o.j_kind, o.claimed_by, 'failed'::text AS act
  )
  SELECT r.id, r.j_kind, r.claimed_by, r.act FROM requeued r
  UNION ALL
  SELECT f.id, f.j_kind, f.claimed_by, f.act FROM failed f;
END;
$$;

-- ── 2. Read-only health surface for the Operations UI ───────────────────────
-- Deliberately excludes payload/result/error-detail of individual jobs: those
-- can carry customer evidence. Failure MESSAGES are exposed only in aggregate
-- form (kind + count) plus the single most recent message, truncated — enough
-- to triage, not enough to leak an evidence package.
CREATE OR REPLACE FUNCTION public.claude_runner_health(p_lease text DEFAULT 'marketing_intelligence')
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $$
  SELECT jsonb_build_object(
    'checked_at', now(),
    'lease', (
      SELECT jsonb_build_object(
        'name', l.lease_name,
        'owner_id', l.owner_id,
        'host', l.host,
        'pid', l.pid,
        'acquired_at', l.acquired_at,
        'heartbeat_at', l.heartbeat_at,
        'expires_at', l.expires_at,
        'released_at', l.released_at,
        'is_live', (l.released_at IS NULL AND l.expires_at > now()),
        'heartbeat_age_seconds', EXTRACT(EPOCH FROM (now() - l.heartbeat_at))::int
      )
      FROM public.claude_runner_lease l WHERE l.lease_name = p_lease
    ),
    'queue', (
      SELECT coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
      FROM (SELECT status, count(*)::int AS n FROM public.claude_jobs GROUP BY status) s
    ),
    'oldest_pending_age_seconds', (
      SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::int
      FROM public.claude_jobs WHERE status = 'pending'
    ),
    'current_job', (
      SELECT jsonb_build_object(
        'id', j.id, 'kind', j.kind, 'started_at', j.started_at,
        'claimed_by', j.claimed_by, 'attempts', j.attempts,
        'running_seconds', EXTRACT(EPOCH FROM (now() - j.started_at))::int
      )
      FROM public.claude_jobs j WHERE j.status = 'running'
      ORDER BY j.started_at LIMIT 1
    ),
    'failures_24h', (
      SELECT coalesce(jsonb_agg(f), '[]'::jsonb) FROM (
        SELECT kind, count(*)::int AS n,
               left(coalesce((array_agg(error ORDER BY finished_at DESC))[1], ''), 200) AS last_error
        FROM public.claude_jobs
        WHERE status = 'failed' AND finished_at > now() - interval '24 hours'
        GROUP BY kind
      ) f
    ),
    'blocked_count', (
      SELECT count(*)::int FROM public.claude_jobs
      WHERE status = 'failed' AND error ILIKE '%limit%' AND finished_at > now() - interval '24 hours'
    ),
    'last_completed_at', (
      SELECT max(finished_at) FROM public.claude_jobs WHERE status = 'ready'
    ),
    'awaiting_intelligence_posts', (
      SELECT count(*)::int FROM public.mkt_content_posts
      WHERE processing_status = 'awaiting_intelligence'
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.claude_jobs_recover_orphaned(text,int,int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claude_jobs_recover_orphaned(text,int,int) TO service_role;
GRANT  EXECUTE ON FUNCTION public.claude_runner_health(text) TO service_role, authenticated;
