-- Fix: inbound_media_claim_next raised "column reference \"attempts\" is ambiguous".
-- The RETURNS TABLE (... attempts int) OUT column shadows the table column, so the
-- UPDATE's `attempts = attempts + 1` right-hand side was ambiguous and the claim
-- aborted every poll tick — the whole lane could never claim a job. Qualify the
-- increment against the record we already selected (r.attempts). Behaviour is
-- otherwise identical. Never raises SQLSTATE 40001/40P01 (see CLAUDE.md).

CREATE OR REPLACE FUNCTION public.inbound_media_claim_next(p_worker text)
RETURNS TABLE (id uuid, message_id text, chat_wid text, session text, fname text, mime text, kind text, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.inbound_media_jobs;
BEGIN
  SELECT * INTO r FROM public.inbound_media_jobs j
  WHERE j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
  ORDER BY j.next_attempt_at NULLS FIRST, j.created_at
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.inbound_media_jobs
     SET status='running', worker_id=p_worker, attempts = r.attempts + 1,
         started_at=coalesce(started_at, now()), heartbeat_at=now()
   WHERE inbound_media_jobs.id = r.id;
  RETURN QUERY SELECT r.id, r.message_id, r.chat_wid, r.session, r.fname, r.mime, r.kind, r.attempts + 1;
END $$;

REVOKE ALL ON FUNCTION public.inbound_media_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_media_claim_next(text) TO service_role;
