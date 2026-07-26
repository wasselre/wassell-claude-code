-- ──────────────────────────────────────────────────────────────────────
-- WhatsApp AI replies — handled by REAL Claude Code sessions (2026-07-26)
--
-- Explicit product decision: the WhatsApp agent is NOT an Anthropic-API bot
-- embedded in the app. An inbound message enqueues a `claude_jobs` row and the
-- local runner (scripts/claude-study-runner.mjs) spawns a full headless Claude
-- Code session that reads the conversation, uses the real CRM tools, writes the
-- reply itself, and sends it. Same posture as client studies — the session runs
-- on the owner's Claude account, one job at a time.
--
-- This migration adds ONLY the data layer:
--   1. 'whatsapp_reply' as a claude_jobs kind
--   2. whatsapp_ai_settings — singleton config, FAIL-CLOSED (disabled by default)
--   3. whatsapp_ai_replies — audit of every message the AI sent (also what makes
--      "a human replied" detectable: an outbound message NOT in this table)
--   4. whatsapp_ai_should_reply() — the single gate both webhook and runner use
--   5. whatsapp_ai_enqueue() — debounced enqueue (one live job per chat)
--
-- Idempotent.
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. New job kind ------------------------------------------------------------
ALTER TABLE public.claude_jobs DROP CONSTRAINT IF EXISTS claude_jobs_kind_check;
ALTER TABLE public.claude_jobs ADD CONSTRAINT claude_jobs_kind_check
  CHECK (kind IN ('ping', 'client_study', 'mkt_content_enrichment', 'whatsapp_reply'));

-- 2. Settings (singleton, fail-closed) ---------------------------------------
-- Deliberately NOT feature_flags: that table is fail-OPEN (a missing row means
-- enabled), which is the wrong default for something that auto-messages
-- customers. Here, absent config = OFF.
CREATE TABLE IF NOT EXISTS public.whatsapp_ai_settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  is_enabled          boolean NOT NULL DEFAULT false,
  -- Working hours = when HUMANS cover the line. The AI answers OUTSIDE these.
  work_start_hour     int     NOT NULL DEFAULT 9    CHECK (work_start_hour BETWEEN 0 AND 23),
  work_end_hour       int     NOT NULL DEFAULT 18   CHECK (work_end_hour   BETWEEN 1 AND 24),
  -- ISO dow: 1=Mon … 7=Sun. Saudi week Sun–Thu = {7,1,2,3,4}.
  work_days           int[]   NOT NULL DEFAULT ARRAY[7,1,2,3,4],
  timezone            text    NOT NULL DEFAULT 'Asia/Riyadh',
  -- Stop after this many AI messages in one conversation → hand to a human.
  max_replies_per_chat int    NOT NULL DEFAULT 12,
  -- If a HUMAN sent anything in the chat within this window, the AI stays out
  -- of the way even outside working hours (a rep is clearly on it).
  human_quiet_hours   int     NOT NULL DEFAULT 6,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.whatsapp_ai_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.whatsapp_ai_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_ai_settings_select ON public.whatsapp_ai_settings;
CREATE POLICY whatsapp_ai_settings_select ON public.whatsapp_ai_settings
  FOR SELECT TO authenticated USING (true);
-- Writes: service-role / SQL only (admin UI can come later).

-- 3. Audit of AI-sent messages ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_ai_replies (
  message_wid  text PRIMARY KEY,               -- the WAHA message id we sent
  chat_wid     text NOT NULL,
  job_id       uuid REFERENCES public.claude_jobs(id) ON DELETE SET NULL,
  body         text,
  sent_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_ai_replies_chat_idx
  ON public.whatsapp_ai_replies (chat_wid, sent_at DESC);

ALTER TABLE public.whatsapp_ai_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_ai_replies_select ON public.whatsapp_ai_replies;
CREATE POLICY whatsapp_ai_replies_select ON public.whatsapp_ai_replies
  FOR SELECT TO authenticated USING (true);

-- 4. The gate ----------------------------------------------------------------
-- Returns (should_reply, reason). ONE implementation so the webhook's decision
-- and the runner's re-check can never disagree.
CREATE OR REPLACE FUNCTION public.whatsapp_ai_should_reply(
  p_chat_wid text,
  p_now      timestamptz DEFAULT now()
) RETURNS TABLE (should_reply boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  s            public.whatsapp_ai_settings%ROWTYPE;
  v_local      timestamptz;
  v_hour       int;
  v_dow        int;
  v_ai_count   int;
  v_last_human timestamptz;
BEGIN
  SELECT * INTO s FROM public.whatsapp_ai_settings WHERE id LIMIT 1;
  IF NOT FOUND OR NOT s.is_enabled THEN
    RETURN QUERY SELECT false, 'disabled'; RETURN;
  END IF;

  v_local := p_now AT TIME ZONE s.timezone;
  v_hour  := EXTRACT(HOUR  FROM v_local)::int;
  v_dow   := EXTRACT(ISODOW FROM v_local)::int;

  -- Inside working hours on a working day → humans handle it.
  IF v_dow = ANY (s.work_days) AND v_hour >= s.work_start_hour AND v_hour < s.work_end_hour THEN
    RETURN QUERY SELECT false, 'working_hours'; RETURN;
  END IF;

  -- A human touched this chat recently → don't talk over the rep.
  SELECT max(m.date) INTO v_last_human
  FROM public.chat_messages m
  WHERE m.chat_wid = p_chat_wid
    AND m.flow = 'out'
    AND NOT EXISTS (SELECT 1 FROM public.whatsapp_ai_replies r WHERE r.message_wid = m.id);
  IF v_last_human IS NOT NULL AND v_last_human > p_now - make_interval(hours => s.human_quiet_hours) THEN
    RETURN QUERY SELECT false, 'human_active'; RETURN;
  END IF;

  -- Conversation cap → force a handoff instead of an endless bot thread.
  SELECT count(*) INTO v_ai_count FROM public.whatsapp_ai_replies r WHERE r.chat_wid = p_chat_wid;
  IF v_ai_count >= s.max_replies_per_chat THEN
    RETURN QUERY SELECT false, 'reply_cap_reached'; RETURN;
  END IF;

  RETURN QUERY SELECT true, 'ok';
END $$;

GRANT EXECUTE ON FUNCTION public.whatsapp_ai_should_reply(text, timestamptz) TO service_role, authenticated;

-- 5. Debounced enqueue -------------------------------------------------------
-- A customer firing three messages in a row must produce ONE session (which
-- will see all three in the history), not three racing sessions.
CREATE OR REPLACE FUNCTION public.whatsapp_ai_enqueue(
  p_chat_wid         text,
  p_chat_record_id   uuid,
  p_phone            text,
  p_device_id        text,
  p_trigger_message  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_ok   boolean;
  v_id   uuid;
BEGIN
  SELECT should_reply INTO v_ok FROM public.whatsapp_ai_should_reply(p_chat_wid);
  IF NOT v_ok THEN RETURN NULL; END IF;

  -- Already a live session for this chat → let it pick the new message up.
  SELECT id INTO v_id FROM public.claude_jobs
   WHERE kind = 'whatsapp_reply'
     AND status IN ('pending', 'running')
     AND payload->>'chat_wid' = p_chat_wid
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO public.claude_jobs (kind, payload)
  VALUES ('whatsapp_reply', jsonb_build_object(
    'chat_wid',        p_chat_wid,
    'chat_record_id',  p_chat_record_id,
    'phone',           p_phone,
    'device_id',       p_device_id,
    'trigger_message', left(coalesce(p_trigger_message, ''), 500)
  ))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.whatsapp_ai_enqueue(text, uuid, text, text, text) TO service_role;

COMMIT;
