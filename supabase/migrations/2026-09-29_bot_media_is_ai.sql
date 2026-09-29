-- The bot must never mistake its OWN messages for a human (2026-09-29).
--
-- whatsapp_ai_should_reply treats any outbound message it cannot match to a
-- whatsapp_ai_replies audit row as "a human replied". The bot's project TEXT is
-- audited, but the brochure / photos / video that follow it are not: the worker
-- persists them with send_source='media_batch' (only an `ai:` reference was
-- tagged 'ai'; the project media use `ai-project:`), no body, no audit row. With
-- stop_forever_after_human = true that permanently muted the bot in EVERY chat it
-- ever sent a project package to — measured 2026-09-29: 65 of 65 package chats
-- muted, 26 of them with no human reply at all. Reps' own scheduled file sends
-- also use 'media_batch', so the fix is NOT "ignore media_batch":
--   1. backfill: the bot's delivered `ai:` / `ai-project:` messages get send_source='ai'
--      (the worker now writes 'ai' for both prefixes going forward);
--   2. the gate ignores send_source='ai' rows when looking for a human.
-- chat_messages has no UPDATE trigger beyond updated_at (checked), so the
-- backfill is side-effect free. Never raises SQLSTATE 40001/40P01.

-- 1. Backfill (no-op on a fresh database).
UPDATE public.chat_messages m
   SET send_source = 'ai'
 WHERE m.flow = 'out'
   AND coalesce(m.send_source, '') <> 'ai'
   AND m.id IN (
     SELECT jsonb_array_elements_text(j.result->'ids')
       FROM public.scheduled_whatsapp_jobs j
      WHERE (j.reference LIKE 'ai:%' OR j.reference LIKE 'ai-project:%')
        AND j.result ? 'ids'
   );

-- 2. The gate — re-emitted VERBATIM from the live definition with ONE change:
--    `AND coalesce(m.send_source, '') <> 'ai'` in the human lookup.
CREATE OR REPLACE FUNCTION public.whatsapp_ai_should_reply(p_chat_wid text, p_now timestamp with time zone DEFAULT now())
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

  SELECT max(m.date) INTO v_last_human
  FROM public.chat_messages m
  WHERE m.chat_wid = p_chat_wid
    AND m.flow = 'out'
    AND coalesce(m.send_source, '') <> 'ai'   -- the bot's own messages are never "a human"
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
      IF NOT v_managed THEN
        RETURN QUERY SELECT false, 'human_active'; RETURN;
      END IF;
    ELSIF v_last_human > p_now - make_interval(hours => s.human_quiet_hours) THEN
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
