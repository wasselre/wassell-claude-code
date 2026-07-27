-- ============================================================================
-- claude_job_claim_next: the lease holder must drain its OWN kinds first
-- (2026-08-14).
--
-- `claude_jobs` is a SHARED queue with more than one consumer:
--   * wassel-claude-runner (sin) — holds the `marketing_intelligence` singleton
--     lease. It is the ONLY consumer permitted to run the lease-scoped kinds.
--   * wassel-wa-agent (bom)      — dedicated to `whatsapp_reply`.
--
-- The gate was `(v_holds_lease OR kind NOT IN (...))`, which for the lease
-- holder evaluates TRUE for every row — so the singleton claimed whatever was
-- oldest, including work another machine was sitting idle waiting to do.
--
-- Observed in production 2026-07-27: with 49 `mkt_content_enrichment` jobs
-- pending, the marketing runner claimed two `whatsapp_reply` jobs back to back
-- (12.7 min and 14.0 min) while wassel-wa-agent was up and idle. Marketing
-- backfill stalled ~27 minutes for work that was never its to do.
--
-- The fix is a PREFERENCE, not an exclusion, and the distinction matters:
--
--   * Exclusion (lease holder may ONLY take lease-scoped kinds) would make a
--     dead wassel-wa-agent stall `whatsapp_reply` forever — turning a
--     throughput problem into a customer-facing outage. Customer replies must
--     degrade, never stop.
--   * Preference (lease-scoped kinds sort first FOR THE LEASE HOLDER) removes
--     the starvation while keeping the singleton as a fallback for everything
--     else once its own queue is empty.
--
-- Nothing about WHO MAY claim what changes — only the order in which the lease
-- holder picks. Non-lease-holders are unaffected: they still cannot see
-- lease-scoped kinds at all, so they were never the source of the problem.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
RETURNS SETOF claude_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_holds_lease boolean;
  -- Kinds that REQUIRE the marketing_intelligence singleton lease. Keep this in
  -- sync with the runner's handler list; adding a kind here makes it invisible
  -- to every non-lease-holder.
  v_lease_kinds constant text[] :=
    ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary'];
BEGIN
  SELECT (l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker)
    INTO v_holds_lease
  FROM public.claude_runner_lease l
  WHERE l.lease_name = 'marketing_intelligence';

  -- No lease row configured at all → unrestricted (unchanged from before).
  v_holds_lease := coalesce(v_holds_lease, true);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (v_holds_lease OR kind <> ALL (v_lease_kinds))
  ORDER BY
    -- Lease holder: its own kinds first, because it is the only consumer that
    -- can run them. Everything else has a dedicated agent. This is a TIE-BREAK,
    -- not a filter — with no lease-scoped work pending the lease holder still
    -- picks up the rest, so a dead sibling agent degrades throughput rather
    -- than stalling a customer-facing queue.
    CASE WHEN v_holds_lease AND kind = ANY (v_lease_kinds) THEN 0 ELSE 1 END,
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
