-- ============================================================================
-- Slot-based capacity for the marketing-intelligence lane (2026-07-28)
--
-- claude_runner_lease has lease_name as its PRIMARY KEY, so one name is one live
-- session, always. Capacity on a lane is therefore NOT how many machines exist —
-- it is how many lease NAMES may claim that lane's kinds. Scaling a single-lease
-- app to N machines produces one worker and N-1 processes that wait out the TTL
-- and exit 0: it looks like capacity in the Fly dashboard and is not.
--
-- This makes the marketing lane match a FAMILY of names — the original plus any
-- 'marketing_intelligence#<machine-id>' slot. A runner started with
-- RUNNER_LEASE='marketing_intelligence#' appends its own machine id, so every
-- machine gets a distinct lease with no coordination, no slot registry and no
-- race. Fleet size becomes `fly scale count N`, and changing it never needs
-- another migration.
--
-- The escape in LIKE 'marketing\_intelligence#%' is deliberate: an unescaped _
-- is a single-character wildcard, which would also match names this lane must
-- not own.
--
-- UNCHANGED, and load-bearing:
--   * one live session per lease name (PK + compare-and-set acquire)
--   * claims are FOR UPDATE SKIP LOCKED, so two slots never take the same job
--   * a worker holding no lease still cannot claim lease-scoped work
--   * orphan adoption now fires only when NO slot is live, so a slot restarting
--     is not read as an outage
--
-- CAPACITY WARNING. Slots share one Claude subscription with the lanes that
-- serve people: 'whatsapp_reply' (customers) and 'interactive' (reps' client
-- studies). There is no per-lane quota. A large marketing fleet that exhausts
-- the subscription parks those lanes too — jobs stop politely via
-- claude_job_block rather than failing, but they stop. Raise the fleet on
-- evidence: watch claude_jobs.status='blocked_subscription_limit' across a full
-- drain before increasing it.
--
-- Written against the LIVE pg_get_functiondef, not the repo copy — this function
-- has been edited in production more than once.
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
  -- A lease NAME is the unit of capacity, not a machine. The marketing lane now
  -- matches a FAMILY of names: the original plus any 'marketing_intelligence#<id>'
  -- slot. Fleet size therefore lives in `fly scale count`, and growing or
  -- shrinking it never needs another migration.
  v_holds_interactive boolean; v_holds_marketing boolean; v_holds_ocr boolean;
  v_interactive_orphan boolean; v_marketing_orphan boolean; v_ocr_orphan boolean;
  v_holds_any boolean; v_no_leases boolean;
  v_may_interactive boolean; v_may_batch boolean; v_may_ocr boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease) INTO v_no_leases;

  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_interactive;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'marketing_intelligence' OR l.lease_name LIKE 'marketing\_intelligence#%')
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_marketing;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_ocr;

  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_interactive_orphan;
  -- Orphaned only when NO slot at all is live, so one slot restarting is never
  -- mistaken for the lane being down.
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'marketing_intelligence' OR l.lease_name LIKE 'marketing\_intelligence#%')
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

