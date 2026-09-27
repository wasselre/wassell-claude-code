-- Phase 2 of the inbound-media pipeline: let a transcribed voice note DRIVE the
-- basic bot, the same way a typed message does.
--
-- WHY a flag on the job. Transcription is async (the worker, seconds later), but
-- the decision "should the bot answer this inbound at all" belongs to the webhook
-- (it alone knows isNew / isOps / counterpartyPhone). So the webhook records that
-- decision on the job (trigger_bot) at enqueue time; after the worker writes the
-- transcript it POSTs /api/whatsapp/basic-reply with the transcript as the
-- trigger_message. For a voice note the webhook now SKIPS its own immediate
-- basic-reply call (which would only ever hand off with "we got your media") and
-- lets the transcript drive the real answer; on a failed/empty transcript the
-- worker still fires basic-reply with a null message, reproducing the old media
-- hand-off so the customer is never left without a reply.
--
-- Never raises SQLSTATE 40001/40P01 (see CLAUDE.md). Service-role only.

ALTER TABLE public.inbound_media_jobs
  ADD COLUMN IF NOT EXISTS trigger_bot boolean NOT NULL DEFAULT false;

-- enqueue: add p_trigger_bot. Drop the 6-arg form so PostgREST has ONE candidate
-- (an overload set with overlapping named args resolves ambiguously).
DROP FUNCTION IF EXISTS public.inbound_media_enqueue(text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.inbound_media_enqueue(
  p_message_id text, p_chat_wid text, p_session text, p_fname text, p_mime text, p_kind text,
  p_trigger_bot boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF coalesce(p_message_id,'') = '' OR coalesce(p_session,'') = '' OR coalesce(p_fname,'') = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.inbound_media_jobs (message_id, chat_wid, session, fname, mime, kind, trigger_bot)
  VALUES (p_message_id, p_chat_wid, p_session, p_fname, p_mime, p_kind, coalesce(p_trigger_bot, false))
  ON CONFLICT (message_id) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- claim_next: also return trigger_bot. RETURNS TABLE shape change needs a DROP.
DROP FUNCTION IF EXISTS public.inbound_media_claim_next(text);

CREATE OR REPLACE FUNCTION public.inbound_media_claim_next(p_worker text)
RETURNS TABLE (id uuid, message_id text, chat_wid text, session text, fname text, mime text, kind text, attempts int, trigger_bot boolean)
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
  RETURN QUERY SELECT r.id, r.message_id, r.chat_wid, r.session, r.fname, r.mime, r.kind, r.attempts + 1, r.trigger_bot;
END $$;

REVOKE ALL ON FUNCTION public.inbound_media_enqueue(text,text,text,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inbound_media_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_media_enqueue(text,text,text,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.inbound_media_claim_next(text) TO service_role;
