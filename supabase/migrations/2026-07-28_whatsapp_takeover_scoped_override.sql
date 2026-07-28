-- WA-11 — a per-chat takeover overrides the SCHEDULE, not every safety control.
--
-- The old first branch returned true for an ai_managed chat BEFORE the enabled
-- switch, working hours, human-active and the reply cap were evaluated. So
-- while takeover was on: the global kill switch did nothing, a rep typing in
-- the same thread did not stop the agent (both answered the customer, possibly
-- contradicting each other), and there was no reply ceiling at all.
--
-- Takeover now means what the rep actually asked for — "answer this chat even
-- outside working hours" — and nothing more:
--
--   kill switch     STILL APPLIES. Turning the feature off must stop every
--                   chat, including handed-over ones. That is what a kill
--                   switch is.
--   human active    STILL APPLIES. A rep who starts typing outranks their own
--                   earlier handover; the newer signal wins.
--   reply cap       STILL APPLIES. An unbounded agent on one conversation is
--                   the failure a cap exists to prevent.
--   working hours   OVERRIDDEN — the intended effect of takeover.
--
-- NOT decided here: whether a takeover should EXPIRE on its own, and after how
-- long. No existing product rule determines it, and inventing a number would be
-- a policy decision dressed as a bug fix. Takeover persists until a human turns
-- it off, as before. Flagged as an open decision.
--
-- Verified in a rolled-back transaction against production data:
--   kill switch off, managed          → disabled_globally_despite_takeover
--   kill switch on, managed, 11:00    → chat_ai_managed, should_reply = true
--   kill switch on, unmanaged, 11:00  → working_hours, should_reply = false

CREATE OR REPLACE FUNCTION public.whatsapp_ai_should_reply(
  p_chat_wid text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(should_reply boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  s            public.whatsapp_ai_settings%ROWTYPE;
  v_managed    boolean;
  v_local      timestamptz;
  v_hour       int;
  v_dow        int;
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
  IF v_dow = ANY (s.work_days) AND v_hour >= s.work_start_hour AND v_hour < s.work_end_hour THEN
    RETURN QUERY SELECT false, 'working_hours'; RETURN;
  END IF;

  RETURN QUERY SELECT true, 'ok';
END $function$;
