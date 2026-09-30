-- WhatsApp sales agent — going live for every chat (operator, 2026-09-30).
--
-- 1. A per-chat STOP switch. The agent answers every customer chat unless a rep
--    pressed «إيقاف المساعد» in it: `chats.data.ai_paused = true`. A rep typing
--    in the chat does NOT stop the agent — only the button does.
-- 2. `wa_agent_questions` — when the agent cannot answer, it asks the client's
--    rep. The rep either types the answer (the agent relays it) or answers the
--    customer directly (the question closes itself).
-- 3. The reply gate honours the stop switch for the basic bot too.
--
-- Nothing here turns the agent on: `whatsapp_ai_settings.agent_mode` stays as
-- it is. Backward compatible with the deployed code.

-- ── 1. The stop switch ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whatsapp_ai_set_chat_paused(
  p_chat_record_id uuid, p_paused boolean, p_user_id uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_wid text;
BEGIN
  UPDATE public.records r
     SET data = CASE WHEN p_paused
                  THEN r.data || jsonb_build_object(
                         'ai_paused', true, 'ai_paused_at', now()::text,
                         'ai_paused_by', p_user_id, 'ai_paused_reason', coalesce(p_reason, 'rep'))
                  ELSE (r.data - 'ai_paused_at' - 'ai_paused_by' - 'ai_paused_reason')
                       || jsonb_build_object('ai_paused', false, 'ai_resumed_at', now()::text)
                END
   WHERE r.id = p_chat_record_id
     AND r.model_id = (SELECT id FROM public.models WHERE name = 'chats')
  RETURNING r.data->>'wid' INTO v_wid;
  IF v_wid IS NULL THEN RAISE EXCEPTION 'chat record % not found', p_chat_record_id; END IF;

  IF p_paused THEN
    -- The agent's conversation ends and nothing it queued to think about runs.
    UPDATE public.wa_agent_conversations
       SET status = 'handed_off', updated_at = now()
     WHERE chat_wid = v_wid AND status = 'active';
    UPDATE public.wa_agent_turn_jobs
       SET status = 'failed', error = 'paused by rep', finished_at = now()
     WHERE chat_wid = v_wid AND status = 'queued';
  END IF;
  RETURN jsonb_build_object('ai_paused', p_paused, 'chat_wid', v_wid);
END $function$;

REVOKE ALL ON FUNCTION public.whatsapp_ai_set_chat_paused(uuid, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_ai_set_chat_paused(uuid, boolean, uuid, text) TO service_role;

-- ── 2. Questions the agent asks a rep ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_agent_questions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_wid                text NOT NULL,
  conversation_record_id  uuid,
  client_id               uuid,
  project_id              uuid,
  rep_user_id             uuid,
  question                text NOT NULL,          -- what the customer asked, as the agent understood it
  note                    text,                   -- context for the rep
  status                  text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'answered', 'answered_directly', 'dismissed')),
  answer                  text,
  answered_by_user_id     uuid,
  save_as_fact            boolean NOT NULL DEFAULT false,   -- reuse the answer for this project next time
  created_at              timestamptz NOT NULL DEFAULT now(),
  answered_at             timestamptz,
  relayed_at              timestamptz
);
CREATE INDEX IF NOT EXISTS wa_agent_questions_chat_idx ON public.wa_agent_questions (chat_wid, created_at DESC);
CREATE INDEX IF NOT EXISTS wa_agent_questions_open_idx ON public.wa_agent_questions (rep_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS wa_agent_questions_fact_idx ON public.wa_agent_questions (project_id) WHERE save_as_fact AND status = 'answered';

ALTER TABLE public.wa_agent_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_agent_questions FROM anon, authenticated;
GRANT SELECT ON public.wa_agent_questions TO authenticated;

-- Whoever can see the chat can see its questions (same rule as tracked_links).
DROP POLICY IF EXISTS wa_agent_questions_select ON public.wa_agent_questions;
CREATE POLICY wa_agent_questions_select ON public.wa_agent_questions
  FOR SELECT TO authenticated
  USING (
    CASE public.wassell_chat_scope_class()
      WHEN 'all' THEN true
      WHEN 'none' THEN false
      ELSE EXISTS (SELECT 1 FROM public.records r WHERE r.id = wa_agent_questions.conversation_record_id)
    END
  );

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'wa_agent_questions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_agent_questions;
  END IF;
END $pub$;

-- A rep who answers the customer from the app's composer has answered the
-- question: close it, so the agent does not relay a second answer. Positive
-- match on the app's own send sources — a row tagged 'ai' (or not tagged yet)
-- never closes anything. Never fails the message insert.
CREATE OR REPLACE FUNCTION public.tg_wa_agent_questions_close_on_rep_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.wa_agent_questions
     SET status = 'answered_directly', answered_at = COALESCE(NEW.date, now())
   WHERE chat_wid = NEW.chat_wid AND status = 'open' AND created_at <= COALESCE(NEW.date, now());
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'wa_agent_questions close failed for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS chat_messages_close_agent_questions ON public.chat_messages;
CREATE TRIGGER chat_messages_close_agent_questions
  AFTER INSERT OR UPDATE OF send_source ON public.chat_messages
  FOR EACH ROW
  WHEN (new.flow = 'out' AND new.send_source IN ('composer', 'media_batch', 'new_chat'))
  EXECUTE FUNCTION public.tg_wa_agent_questions_close_on_rep_reply();

-- ── 3. The reply gate honours the stop switch ────────────────────────────────
-- Re-emitted from the live definition with ONE change: a paused chat returns
-- (false, 'paused_by_rep') before anything else.
CREATE OR REPLACE FUNCTION public.whatsapp_ai_should_reply(p_chat_wid text, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(should_reply boolean, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s            public.whatsapp_ai_settings%ROWTYPE;
  v_managed    boolean;
  v_paused     boolean;
  v_local      timestamptz;
  v_hour       int;
  v_dow        int;
  v_in_window  boolean;
  v_ai_count   int;
  v_last_human timestamptz;
BEGIN
  SELECT COALESCE((r.data->>'ai_managed')::boolean, false), COALESCE((r.data->>'ai_paused')::boolean, false)
    INTO v_managed, v_paused
  FROM public.records r
  WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'chats')
    AND r.data->>'wid' = p_chat_wid
  LIMIT 1;
  v_managed := COALESCE(v_managed, false);

  IF COALESCE(v_paused, false) THEN
    RETURN QUERY SELECT false, 'paused_by_rep'; RETURN;
  END IF;

  SELECT * INTO s FROM public.whatsapp_ai_settings WHERE id LIMIT 1;
  IF NOT FOUND OR NOT s.is_enabled THEN
    RETURN QUERY SELECT false, CASE WHEN v_managed THEN 'disabled_globally_despite_takeover' ELSE 'disabled' END;
    RETURN;
  END IF;

  SELECT max(m.date) INTO v_last_human
  FROM public.chat_messages m
  WHERE m.chat_wid = p_chat_wid
    AND m.flow = 'out'
    AND coalesce(m.send_source, '') <> 'ai'
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
