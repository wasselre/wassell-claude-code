-- ============================================================================
-- A SECOND marketing-intelligence runner (2026-07-28)
--
-- 2,302 posts sit at 'awaiting_intelligence'. The enrichment lane reads 15 per
-- job at a median of 134s, one session at a time, so the backlog is ~6 hours of
-- wall clock. Requested: run two.
--
-- `fly scale count 2` on wassel-claude-runner does NOT do this. claude_runner_lease
-- has lease_name as its PRIMARY KEY, so a second machine asking for
-- 'marketing_intelligence' waits out the TTL and exits 0 by design. Capacity on
-- this lane is a function of how many lease NAMES may claim batch kinds, not how
-- many machines exist.
--
-- So: 'marketing_intelligence_2' becomes a second name that may claim the same
-- kinds. What does NOT change:
--   * each lease_name is still exactly one live session (PK + CAS acquire)
--   * claims are still FOR UPDATE SKIP LOCKED — two runners cannot take one job
--   * a worker holding no lease still cannot claim lease-scoped work
--   * orphan adoption still works, and now triggers only when NEITHER marketing
--     lease has a live holder, so a second runner booting is not mistaken for an
--     outage
--
-- Deploy the machine with RUNNER_LEASE=marketing_intelligence_2. To go back to
-- one, stop that machine — no migration needed; an unheld lease name is inert.
--
-- Written against the LIVE definition (pg_get_functiondef), not the repo copy,
-- because this function has been edited in production more than once.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
 RETURNS SETOF claude_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_interactive_kinds constant text[] := ARRAY['ping','client_study'];
  v_batch_kinds       constant text[] := ARRAY['mkt_content_enrichment','mkt_campaign_summary'];
  v_ocr_kinds         constant text[] := ARRAY['mkt_visual_ocr'];
  v_lease_kinds       constant text[] := ARRAY['ping','client_study','mkt_content_enrichment',
                                               'mkt_campaign_summary','mkt_visual_ocr'];
  -- The marketing lane may now be held by MORE THAN ONE lease name, so two
  -- runners can enrich concurrently. Every other guarantee is unchanged: each
  -- lease_name is still a singleton (PRIMARY KEY on claude_runner_lease), the
  -- claim below is still FOR UPDATE SKIP LOCKED so two claimers never take the
  -- same job, and a worker holding no lease still cannot touch lease-scoped work.
  v_marketing_leases  constant text[] := ARRAY['marketing_intelligence','marketing_intelligence_2'];
  v_holds_interactive boolean; v_holds_marketing boolean; v_holds_ocr boolean;
  v_interactive_orphan boolean; v_marketing_orphan boolean; v_ocr_orphan boolean;
  v_holds_any boolean; v_no_leases boolean;
  v_may_interactive boolean; v_may_batch boolean; v_may_ocr boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease) INTO v_no_leases;

  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_interactive;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name = ANY (v_marketing_leases)
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_marketing;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_ocr;

  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_interactive_orphan;
  -- Orphaned only when NO marketing lease at all has a live holder — otherwise a
  -- second runner starting up would look like an outage and let other lanes adopt.
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name = ANY (v_marketing_leases)
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_marketing_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_ocr_orphan;

  v_holds_any := v_holds_interactive OR v_holds_marketing OR v_holds_ocr;

  v_may_interactive := v_no_leases OR v_holds_interactive OR (v_interactive_orphan AND v_holds_any);
  v_may_batch       := v_no_leases OR v_holds_marketing   OR (v_marketing_orphan   AND v_holds_any);
  v_may_ocr         := v_no_leases OR v_holds_ocr         OR (v_ocr_orphan         AND v_holds_any);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (
      kind <> ALL (v_lease_kinds)
      OR (kind = ANY (v_interactive_kinds) AND v_may_interactive)
      OR (kind = ANY (v_batch_kinds)       AND v_may_batch)
      OR (kind = ANY (v_ocr_kinds)         AND v_may_ocr)
    )
  ORDER BY
    CASE
      WHEN kind = ANY (v_interactive_kinds) AND v_may_interactive THEN 0  -- human waiting
      WHEN kind <> ALL (v_lease_kinds)                            THEN 1  -- foreign, dedicated agent
      ELSE 2                                                              -- batch + ocr
    END,
    created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.claude_jobs
  SET status='running', claimed_by=p_worker, started_at=now(), attempts=attempts+1
  WHERE id = v_id
  RETURNING *;
END;
$function$

