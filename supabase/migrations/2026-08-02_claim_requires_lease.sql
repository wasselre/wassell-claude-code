-- ============================================================================
-- 2026-08-02 — Only the lease holder may claim a claude_job.
--
-- The singleton lease was advisory: it stopped a second RUNNER PROCESS from
-- starting, but nothing stopped an unrelated worker from calling
-- claude_job_claim_next() directly. On 2026-07-26 that happened for real — a
-- separate Fly app (`wassel-wa-agent`, worker id `wa-agent-48e71eea972308`)
-- claimed a `mkt_campaign_summary` job while the marketing runner was down. The
-- job was taken by a process that does not implement that Skill, so it sat
-- 'running' and would have burned the full watchdog window.
--
-- Two Claude Code sessions running concurrently against one subscription is
-- exactly what the lease exists to prevent, so the invariant belongs in the
-- database, not in the goodwill of every caller: a claim now REQUIRES a live
-- lease owned by the claiming worker.
--
-- Failure mode is loud on purpose. A non-owner does not silently get NULL (that
-- would look like "queue empty" and hide the misconfiguration for weeks) — it
-- gets an exception naming the real owner.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
RETURNS SETOF public.claude_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
  v_owner text;
  v_live boolean;
BEGIN
  SELECT l.owner_id, (l.released_at IS NULL AND l.expires_at > now())
    INTO v_owner, v_live
  FROM public.claude_runner_lease l
  WHERE l.lease_name = 'marketing_intelligence';

  -- No lease row at all = first-ever boot; the runner acquires before ticking,
  -- so this only happens on a brand-new database. Allow it rather than deadlock.
  IF v_owner IS NOT NULL AND NOT (v_live AND v_owner = p_worker) THEN
    RAISE EXCEPTION
      'claude_job_claim_next refused: worker % does not hold the marketing_intelligence lease (owner=%, live=%). Exactly one Claude Code runner may drain this queue.',
      p_worker, v_owner, coalesce(v_live, false)
      USING ERRCODE = '42501';
  END IF;

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
