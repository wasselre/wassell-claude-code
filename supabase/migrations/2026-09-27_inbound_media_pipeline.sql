-- Inbound WhatsApp media: durable save + voice transcription.
--
-- The webhook's hot-path mirror (api/_lib/waha.mirrorWahaHostedMedia) is bounded
-- to ~10s because it runs inline on the webhook. WAHA writes — and for voice
-- notes TRANSCODES — its /api/files copy ASYNCHRONOUSLY and evicts it within
-- minutes, so slow voice notes (and some big videos) miss the 10s window and are
-- lost forever ("تعذّر تحميل الملف"). This queue moves the save onto the Fly
-- worker with a longer retry window, and transcribes voice notes via fal wizper.
--
-- Never raises SQLSTATE 40001/40P01 (see CLAUDE.md). Service-role only.

-- 1. chat_messages: transcript + save state (read by the SPA chat thread + AI).
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS transcript        text,
  ADD COLUMN IF NOT EXISTS transcript_lang   text,
  ADD COLUMN IF NOT EXISTS transcript_status text,   -- pending | done | none | failed
  ADD COLUMN IF NOT EXISTS media_saved       boolean; -- null=unknown, true=mirrored, false=lost

-- 2. Queue.
CREATE TABLE IF NOT EXISTS public.inbound_media_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    text NOT NULL,                 -- chat_messages.id (WA message id)
  chat_wid      text,
  session       text NOT NULL,                 -- WAHA session / device
  fname         text NOT NULL,                 -- WAHA-hosted filename (stem of the wf_ ref)
  mime          text,
  kind          text,                          -- image|video|audio|document|…
  status        text NOT NULL DEFAULT 'queued',-- queued|running|done|failed
  attempts      int  NOT NULL DEFAULT 0,
  error         text,
  worker_id     text,
  next_attempt_at timestamptz,                 -- requeue backoff gate
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz
);
-- One active job per message (retry-safe: a re-delivered webhook is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS inbound_media_jobs_one_active
  ON public.inbound_media_jobs (message_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS inbound_media_jobs_claim
  ON public.inbound_media_jobs (next_attempt_at NULLS FIRST, created_at) WHERE status = 'queued';
ALTER TABLE public.inbound_media_jobs ENABLE ROW LEVEL SECURITY; -- no policies = service-role only

-- After this many failed rounds the media is treated as genuinely evicted.
-- Keep it in one place so the RPCs agree.
CREATE OR REPLACE FUNCTION public.inbound_media_max_attempts() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;

-- 3a. Enqueue (idempotent; one active per message).
CREATE OR REPLACE FUNCTION public.inbound_media_enqueue(
  p_message_id text, p_chat_wid text, p_session text, p_fname text, p_mime text, p_kind text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF coalesce(p_message_id,'') = '' OR coalesce(p_session,'') = '' OR coalesce(p_fname,'') = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.inbound_media_jobs (message_id, chat_wid, session, fname, mime, kind)
  VALUES (p_message_id, p_chat_wid, p_session, p_fname, p_mime, p_kind)
  ON CONFLICT (message_id) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 3b. Claim the next ready job (FOR UPDATE SKIP LOCKED).
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

-- 3c. Complete (only a running row).
CREATE OR REPLACE FUNCTION public.inbound_media_complete(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.inbound_media_jobs
     SET status='done', finished_at=now(), error=NULL
   WHERE id = p_id AND status='running';
END $$;

-- 3d. Fail: requeue with backoff while under the attempt cap, else terminal.
CREATE OR REPLACE FUNCTION public.inbound_media_fail(p_id uuid, p_error text, p_requeue boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempts int;
BEGIN
  SELECT attempts INTO v_attempts FROM public.inbound_media_jobs WHERE id = p_id AND status='running';
  IF NOT FOUND THEN RETURN; END IF;
  IF p_requeue AND v_attempts < public.inbound_media_max_attempts() THEN
    UPDATE public.inbound_media_jobs
       SET status='queued', error=left(p_error, 500),
           next_attempt_at = now() + (interval '8 seconds' * v_attempts), -- linear backoff
           worker_id=NULL, heartbeat_at=NULL
     WHERE id = p_id;
  ELSE
    UPDATE public.inbound_media_jobs
       SET status='failed', error=left(p_error, 500), finished_at=now()
     WHERE id = p_id;
  END IF;
END $$;

-- 3e. Watchdog: a crashed worker's running row (stale heartbeat) is requeued or failed.
CREATE OR REPLACE FUNCTION public.inbound_media_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  WITH stale AS (
    SELECT id, attempts FROM public.inbound_media_jobs
    WHERE status='running' AND coalesce(heartbeat_at, started_at) < now() - interval '5 minutes'
    FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.inbound_media_jobs j SET
      status = CASE WHEN s.attempts < public.inbound_media_max_attempts() THEN 'queued' ELSE 'failed' END,
      next_attempt_at = CASE WHEN s.attempts < public.inbound_media_max_attempts() THEN now() ELSE NULL END,
      error = coalesce(j.error,'') || ' [watchdog]',
      worker_id = NULL, heartbeat_at = NULL,
      finished_at = CASE WHEN s.attempts < public.inbound_media_max_attempts() THEN NULL ELSE now() END
    FROM stale s WHERE j.id = s.id
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM upd;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.inbound_media_enqueue(text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inbound_media_claim_next(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inbound_media_complete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inbound_media_fail(uuid,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inbound_media_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_media_enqueue(text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.inbound_media_claim_next(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.inbound_media_complete(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.inbound_media_fail(uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.inbound_media_jobs_watchdog() TO service_role;
