-- Carry project_id through the scheduled-WhatsApp queue so a QUEUED project
-- message (the bot's aiSendProject text, and any scheduled rep project send)
-- can be linked to its project at DELIVERY — the only moment the real message
-- wid exists. The worker calls link_message_project(realWid, chat_wid,
-- project_id) after the send, and the thread then shows the action buttons.
--
-- Immediate rep sends already link at send time (sendChatMessage); this closes
-- the scheduled/bot path. Never raises SQLSTATE 40001/40P01 (see CLAUDE.md).

ALTER TABLE public.scheduled_whatsapp_jobs
  ADD COLUMN IF NOT EXISTS project_id uuid;

-- enqueue: add optional p_project_id (DEFAULT NULL so no existing named-arg
-- caller breaks). Drop the 8-arg form so there is ONE candidate for PostgREST.
DROP FUNCTION IF EXISTS public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid);

CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_enqueue(
  p_device_id  text,
  p_chat_wid   text,
  p_phone      text,
  p_body       text,
  p_media      jsonb,
  p_reference  text,
  p_deliver_at timestamptz,
  p_user_id    uuid,
  p_project_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.scheduled_whatsapp_jobs
    (device_id, chat_wid, phone, body, media, reference, deliver_at, created_by_user_id, project_id)
  VALUES
    (p_device_id, p_chat_wid, p_phone, p_body, COALESCE(p_media, '[]'::jsonb),
     p_reference, p_deliver_at, p_user_id, p_project_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid, uuid) TO service_role;

-- claim_due: also return project_id (RETURNS TABLE shape change → DROP first).
DROP FUNCTION IF EXISTS public.scheduled_whatsapp_claim_due(text, int);

CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_claim_due(p_worker_id text, p_limit int DEFAULT 5)
RETURNS TABLE (
  job_id     uuid,
  device_id  text,
  chat_wid   text,
  phone      text,
  body       text,
  media      jsonb,
  reference  text,
  attempts   int,
  project_id uuid
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.scheduled_whatsapp_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = scheduled_whatsapp_jobs.attempts + 1
   WHERE id IN (
     SELECT id
       FROM public.scheduled_whatsapp_jobs
      WHERE status = 'queued'
        AND deliver_at <= now()
      ORDER BY deliver_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(p_limit, 1)
   )
   RETURNING id, device_id, chat_wid, phone, body, media, reference, attempts, project_id;
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_claim_due(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_claim_due(text, int) TO service_role;
