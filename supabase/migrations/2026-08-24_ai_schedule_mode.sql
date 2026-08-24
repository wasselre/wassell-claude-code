-- Let the operator decide WHEN the WhatsApp AI agent replies, instead of the
-- schedule only ever meaning "reps cover these hours, agent is silent then".
--
-- schedule_mode:
--   'outside_hours' (default, legacy)  — agent replies OUTSIDE the days/hours
--                                        (reps cover the window). What it did before.
--   'inside_hours'                     — the days/hours ARE the agent's active
--                                        window; it replies DURING them (incl. work
--                                        hours) and is silent outside.
--   'always'                           — agent may reply any time (24/7); the
--                                        days/hours are ignored.
--
-- The basic first-touch skill only answers simple messages and hands the rest to
-- a human, and the human-active + reply-cap guards still apply — so running it
-- 'always' / 'inside_hours' during work hours is safe: it clears the canned
-- ad-lead greetings instantly while reps take the real conversations.

ALTER TABLE public.whatsapp_ai_settings
  ADD COLUMN IF NOT EXISTS schedule_mode text NOT NULL DEFAULT 'outside_hours';

ALTER TABLE public.whatsapp_ai_settings
  DROP CONSTRAINT IF EXISTS whatsapp_ai_settings_schedule_mode_chk;
ALTER TABLE public.whatsapp_ai_settings
  ADD CONSTRAINT whatsapp_ai_settings_schedule_mode_chk
  CHECK (schedule_mode IN ('outside_hours', 'inside_hours', 'always'));

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

  -- The kill switch is absolute — checked BEFORE the takeover branch.
  SELECT * INTO s FROM public.whatsapp_ai_settings WHERE id LIMIT 1;
  IF NOT FOUND OR NOT s.is_enabled THEN
    RETURN QUERY SELECT false, CASE WHEN v_managed THEN 'disabled_globally_despite_takeover' ELSE 'disabled' END;
    RETURN;
  END IF;

  -- A human who has spoken since the agent last did outranks the handover.
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
  IF v_last_human IS NOT NULL AND v_last_human > p_now - make_interval(hours => s.human_quiet_hours) THEN
    RETURN QUERY SELECT false, 'human_active'; RETURN;
  END IF;

  -- A ceiling applies to every chat.
  SELECT count(*) INTO v_ai_count FROM public.whatsapp_ai_replies r WHERE r.chat_wid = p_chat_wid;
  IF v_ai_count >= s.max_replies_per_chat THEN
    RETURN QUERY SELECT false, 'reply_cap_reached'; RETURN;
  END IF;

  -- Manual takeover skips the schedule entirely.
  IF v_managed THEN
    RETURN QUERY SELECT true, 'chat_ai_managed'; RETURN;
  END IF;

  -- Schedule check, per schedule_mode.
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
  ELSE  -- 'outside_hours' (legacy default): reps cover the window, agent covers the rest.
    IF v_in_window THEN RETURN QUERY SELECT false, 'working_hours';
    ELSE RETURN QUERY SELECT true, 'ok'; END IF;
    RETURN;
  END IF;
END $function$;
