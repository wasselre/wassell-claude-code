-- "If a human ever replies, the agent shuts up forever" (operator rule 2026-08-24).
--
-- Until now the human-active guard was a TIME window (human_quiet_hours): a rep
-- reply silenced the agent for N hours, then it resumed. Add a boolean
-- `stop_forever_after_human` (default TRUE) — when on, ANY human reply ever seen
-- in a chat permanently keeps the autonomous agent out of it. An EXPLICIT manual
-- handover (`ai_managed`) still overrides, so a rep can deliberately hand a chat
-- back to the agent. When off, the old hours-window behavior applies.

ALTER TABLE public.whatsapp_ai_settings
  ADD COLUMN IF NOT EXISTS stop_forever_after_human boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.whatsapp_ai_should_reply(p_chat_wid text, p_now timestamptz DEFAULT now())
 RETURNS TABLE(should_reply boolean, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s            public.whatsapp_ai_settings%ROWTYPE;
  v_managed    boolean;
  v_local      timestamptz;
  v_hour       int;
  v_dow        int;
  v_in_window  boolean;
  v_ai_count   int;
  v_last_human timestamptz;
BEGIN
  SELECT COALESCE((r.data->>'ai_managed')::boolean, false) INTO v_managed
  FROM public.records r
  WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'chats')
    AND r.data->>'wid' = p_chat_wid
  LIMIT 1;
  v_managed := COALESCE(v_managed, false);

  SELECT * INTO s FROM public.whatsapp_ai_settings WHERE id LIMIT 1;
  IF NOT FOUND OR NOT s.is_enabled THEN
    RETURN QUERY SELECT false, CASE WHEN v_managed THEN 'disabled_globally_despite_takeover' ELSE 'disabled' END;
    RETURN;
  END IF;

  -- A human outbound message NOT sent by the agent = a real rep spoke here.
  SELECT max(m.date) INTO v_last_human
  FROM public.chat_messages m
  WHERE m.chat_wid = p_chat_wid
    AND m.flow = 'out'
    AND NOT EXISTS (
      SELECT 1 FROM public.whatsapp_ai_replies r
      WHERE r.message_wid = m.id
         OR (r.chat_wid = m.chat_wid
             AND r.body IS NOT NULL AND m.body IS NOT NULL
             AND r.body = m.body
             AND abs(EXTRACT(EPOCH FROM (r.sent_at - m.date))) < 600)
    );
  IF v_last_human IS NOT NULL THEN
    IF s.stop_forever_after_human THEN
      -- Permanent: a rep touched this chat, so the autonomous agent is done here.
      -- An explicit manual handover (ai_managed) is the one thing that reopens it.
      IF NOT v_managed THEN
        RETURN QUERY SELECT false, 'human_active'; RETURN;
      END IF;
    ELSIF v_last_human > p_now - make_interval(hours => s.human_quiet_hours) THEN
      -- Legacy hours-window behavior (outranks a stale handover, as before).
      RETURN QUERY SELECT false, 'human_active'; RETURN;
    END IF;
  END IF;

  SELECT count(*) INTO v_ai_count FROM public.whatsapp_ai_replies r WHERE r.chat_wid = p_chat_wid;
  IF v_ai_count >= s.max_replies_per_chat THEN
    RETURN QUERY SELECT false, 'reply_cap_reached'; RETURN;
  END IF;

  IF v_managed THEN
    RETURN QUERY SELECT true, 'chat_ai_managed'; RETURN;
  END IF;

  v_local := p_now AT TIME ZONE s.timezone;
  v_hour  := EXTRACT(HOUR  FROM v_local)::int;
  v_dow   := EXTRACT(ISODOW FROM v_local)::int;
  v_in_window := (v_dow = ANY (s.work_days) AND v_hour >= s.work_start_hour AND v_hour < s.work_end_hour);

  IF s.schedule_mode = 'always' THEN
    RETURN QUERY SELECT true, 'ok'; RETURN;
  ELSIF s.schedule_mode = 'inside_hours' THEN
    IF v_in_window THEN RETURN QUERY SELECT true, 'ok';
    ELSE RETURN QUERY SELECT false, 'outside_agent_hours'; END IF;
    RETURN;
  ELSE
    IF v_in_window THEN RETURN QUERY SELECT false, 'working_hours';
    ELSE RETURN QUERY SELECT true, 'ok'; END IF;
    RETURN;
  END IF;
END $function$;
