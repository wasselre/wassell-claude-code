-- ============================================================================
-- Two-lane Claude runner: interactive work stops queueing behind backfill
-- (2026-08-16).
--
-- Until now ONE runner held the `marketing_intelligence` lease and ran every
-- lease-scoped kind, one session at a time. Priority tiers (2026-08-15) made the
-- competition fair but could not add capacity: while 32 enrichment jobs drained,
-- every client_study still waited for the current job to finish.
--
-- This splits the queue into two LANES, each with its own lease, so a rep's
-- study and the marketing backfill run CONCURRENTLY on separate machines:
--
--   lease 'interactive'            → ping, client_study            (a human waits)
--   lease 'marketing_intelligence' → mkt_content_enrichment,       (nobody waits)
--                                    mkt_campaign_summary
--
-- The singleton guarantee is PRESERVED PER LANE — still exactly one session per
-- lease, still enforced by the same compare-and-set lease. What changes is that
-- there are now two leases instead of one. This is a deliberate relaxation of
-- the original "no parallel Claude sessions" rule, requested explicitly.
--
-- ORPHAN ADOPTION — the property that makes this safe to apply in any order:
-- if a lane's lease has NO live holder, its kinds are claimable by any worker
-- that holds SOME lease. Consequences, all desirable:
--   * Applied BEFORE the interactive runner exists → the marketing runner keeps
--     taking studies exactly as it does today. No stall, no flag day.
--   * Interactive runner dies → marketing runner adopts studies within the 120s
--     lease TTL. Degrades to today's behaviour instead of stranding a rep.
--   * Marketing runner dies → interactive runner adopts the backfill.
--   * wa-agent holds NO lease, so it still cannot touch lease-scoped kinds and
--     still owns whatsapp_reply. Unchanged.
--
-- Ordering within a worker: adopted/own interactive first (a human is waiting),
-- then foreign kinds, then batch. Same "who is waiting" axis as 2026-08-15.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
RETURNS SETOF claude_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_interactive_kinds constant text[] := ARRAY['ping','client_study'];
  v_batch_kinds       constant text[] := ARRAY['mkt_content_enrichment','mkt_campaign_summary'];
  v_lease_kinds       constant text[] := v_interactive_kinds || v_batch_kinds;
  v_holds_interactive boolean;
  v_holds_marketing   boolean;
  v_interactive_orphan boolean;
  v_marketing_orphan   boolean;
  v_holds_any boolean;
  v_no_leases boolean;
  v_may_interactive boolean;
  v_may_batch boolean;
BEGIN
  -- Fresh database with no lease rows at all → unrestricted (legacy behaviour).
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease) INTO v_no_leases;

  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
                  WHERE l.lease_name='interactive'
                    AND l.released_at IS NULL AND l.expires_at > now()
                    AND l.owner_id = p_worker) INTO v_holds_interactive;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
                  WHERE l.lease_name='marketing_intelligence'
                    AND l.released_at IS NULL AND l.expires_at > now()
                    AND l.owner_id = p_worker) INTO v_holds_marketing;

  -- A lane is orphaned when NOBODY currently holds its lease.
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
                      WHERE l.lease_name='interactive'
                        AND l.released_at IS NULL AND l.expires_at > now())
    INTO v_interactive_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
                      WHERE l.lease_name='marketing_intelligence'
                        AND l.released_at IS NULL AND l.expires_at > now())
    INTO v_marketing_orphan;

  v_holds_any := v_holds_interactive OR v_holds_marketing;

  v_may_interactive := v_no_leases OR v_holds_interactive
                       OR (v_interactive_orphan AND v_holds_any);
  v_may_batch       := v_no_leases OR v_holds_marketing
                       OR (v_marketing_orphan AND v_holds_any);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (
      -- foreign kinds (whatsapp_reply, …) — no lease governs these
      kind <> ALL (v_lease_kinds)
      OR (kind = ANY (v_interactive_kinds) AND v_may_interactive)
      OR (kind = ANY (v_batch_kinds)       AND v_may_batch)
    )
  ORDER BY
    CASE
      WHEN kind = ANY (v_interactive_kinds) AND v_may_interactive THEN 0  -- human waiting
      WHEN kind <> ALL (v_lease_kinds)                            THEN 1  -- dedicated agent normally has these
      ELSE 2                                                              -- backfill
    END,
    created_at
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
$function$;

-- ── Health must show BOTH lanes, or the second runner is invisible ──────────
-- Deliberately a MINIMAL diff on the deployed function: same `p_lease` argument,
-- same fields, same semantics — only `leases` and `running_jobs` are added.
--
-- In particular `blocked_count` keeps its existing meaning (limit-related
-- FAILURES in the last 24h, not `status='blocked'`) and `failures_24h` keeps
-- taking the most RECENT error per kind rather than max(). Rewriting either
-- would silently change what the Settings card reports — the exact class of
-- quiet-wrong-number bug this system keeps getting bitten by.
CREATE OR REPLACE FUNCTION public.claude_runner_health(p_lease text DEFAULT 'marketing_intelligence'::text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'checked_at', now(),
    'lease', (
      SELECT jsonb_build_object(
        'name', l.lease_name, 'owner_id', l.owner_id, 'host', l.host, 'pid', l.pid,
        'acquired_at', l.acquired_at, 'heartbeat_at', l.heartbeat_at,
        'expires_at', l.expires_at, 'released_at', l.released_at,
        'is_live', (l.released_at IS NULL AND l.expires_at > now()),
        'heartbeat_age_seconds', EXTRACT(EPOCH FROM (now() - l.heartbeat_at))::int
      )
      FROM public.claude_runner_lease l WHERE l.lease_name = p_lease
    ),
    -- NEW: every lane, so a second runner is observable rather than invisible.
    'leases', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', l.lease_name, 'owner_id', l.owner_id, 'host', l.host, 'pid', l.pid,
        'acquired_at', l.acquired_at, 'heartbeat_at', l.heartbeat_at,
        'expires_at', l.expires_at, 'released_at', l.released_at,
        'is_live', (l.released_at IS NULL AND l.expires_at > now()),
        'heartbeat_age_seconds', EXTRACT(EPOCH FROM (now() - l.heartbeat_at))::int
      ) ORDER BY l.lease_name), '[]'::jsonb)
      FROM public.claude_runner_lease l
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
    -- NEW: with two lanes there can be more than one job in flight; a single
    -- `current_job` would under-report from here on.
    'running_jobs', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', j.id, 'kind', j.kind, 'started_at', j.started_at,
        'claimed_by', j.claimed_by,
        'running_seconds', EXTRACT(EPOCH FROM (now() - j.started_at))::int
      ) ORDER BY j.started_at), '[]'::jsonb)
      FROM public.claude_jobs j WHERE j.status = 'running'
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
$function$;

GRANT EXECUTE ON FUNCTION public.claude_runner_health(text) TO service_role, authenticated;
