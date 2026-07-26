-- ============================================================================
-- 2026-08-02 — Marketing-intelligence jobs may only be claimed by the lease
-- holder. Other job kinds are left alone.
--
-- The singleton lease was advisory: it stopped a second RUNNER PROCESS from
-- starting, but nothing stopped an unrelated worker from calling
-- claude_job_claim_next() directly. On 2026-07-26 that happened for real — a
-- separate Fly app (`wassel-wa-agent`, worker id `wa-agent-48e71eea972308`,
-- which runs the /whatsapp-reply skill) claimed a `mkt_campaign_summary` job
-- while the marketing runner was down. It claims with no kind filter, so it took
-- whatever was pending. The job sat 'running' in a process that does not
-- implement that Skill.
--
-- The fix is SCOPED, not global. Requiring the lease for EVERY kind would break
-- that sibling feature, which is a deliberate separate product running its own
-- Claude Code sessions. Instead:
--
--   * A worker that HOLDS the marketing_intelligence lease may claim anything.
--   * A worker that does not hold it simply cannot SEE the marketing kinds —
--     they are filtered out of the candidate set, so it claims its own work and
--     ours is structurally unreachable.
--
-- Filtering (rather than raising) is right here because a sibling worker polling
-- this queue is not an error — it is expected. The cross-claim it caused is now
-- impossible by construction rather than by good behaviour.
--
-- NOTE for whoever owns wassel-wa-agent: `claude_jobs_kind_check` still allows
-- only ping / client_study / mkt_content_enrichment / mkt_campaign_summary. It
-- never allowed a whatsapp kind — inserting one will fail loudly. Add your kind
-- in your own migration, and give your claim call a kind filter so it never
-- competes for another vertical's jobs again.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
RETURNS SETOF public.claude_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
  v_holds_lease boolean;
BEGIN
  SELECT (l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker)
    INTO v_holds_lease
  FROM public.claude_runner_lease l
  WHERE l.lease_name = 'marketing_intelligence';

  -- No lease row at all = brand-new database; the runner acquires before its
  -- first tick, so treat "no row" as permissive rather than deadlocking.
  v_holds_lease := coalesce(v_holds_lease, true);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (v_holds_lease
         OR kind NOT IN ('ping','client_study','mkt_content_enrichment','mkt_campaign_summary'))
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
