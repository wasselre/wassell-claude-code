-- ============================================================================
-- claude_job_claim_next: a human waiting always beats a backfill (2026-08-15).
--
-- Follow-up to 2026-08-14, which fixed the lease holder stealing whatsapp_reply
-- but left ONE priority class for everything lease-scoped. That made
-- `client_study` — which a rep triggers and then sits watching — FIFO-equal with
-- `mkt_content_enrichment` backfill.
--
-- Caught in production minutes later: a client_study enqueued at 07:23:46 was
-- still pending 5.5 minutes on, sitting behind 32 marketing jobs created at
-- 06:44. At ~81s per job it would have waited ~43 minutes for work nobody was
-- watching. After this change it was claimed on the very next poll.
--
-- Three tiers, by WHO IS WAITING rather than by subsystem:
--
--   0  interactive lease-scoped (client_study, ping) — a person is watching
--   1  foreign kinds (whatsapp_reply, …)             — dedicated agent normally
--                                                      takes these; the holder
--                                                      helps rather than starting
--                                                      backfill, so a dead
--                                                      sibling degrades instead
--                                                      of stalling customers
--   2  batch lease-scoped (mkt_content_enrichment,   — nobody is watching; may
--      mkt_campaign_summary)                           wait indefinitely
--
-- Still ordering only — who MAY claim what is unchanged, and FIFO still applies
-- within each tier. The lesson worth keeping: "which subsystem owns this job" is
-- the wrong axis for scheduling. "Is somebody waiting for it" is the right one.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
RETURNS SETOF claude_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_holds_lease boolean;
  -- Lease-scoped, INTERACTIVE: a human is sitting there waiting for the result.
  v_interactive_kinds constant text[] := ARRAY['ping','client_study'];
  -- Lease-scoped, BATCH: backfill. Nobody is watching; may wait indefinitely.
  v_batch_kinds       constant text[] := ARRAY['mkt_content_enrichment','mkt_campaign_summary'];
  v_lease_kinds       constant text[] := ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary'];
BEGIN
  SELECT (l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker)
    INTO v_holds_lease
  FROM public.claude_runner_lease l
  WHERE l.lease_name = 'marketing_intelligence';

  -- No lease row configured at all → unrestricted (unchanged).
  v_holds_lease := coalesce(v_holds_lease, true);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (v_holds_lease OR kind <> ALL (v_lease_kinds))
  ORDER BY
    CASE
      WHEN v_holds_lease AND kind = ANY (v_interactive_kinds) THEN 0
      WHEN v_holds_lease AND kind = ANY (v_batch_kinds)       THEN 2
      ELSE 1
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
