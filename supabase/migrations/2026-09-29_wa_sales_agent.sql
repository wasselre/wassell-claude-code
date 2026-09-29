-- WhatsApp sales agent (Phase 2, 2026-09-29): a real qualifying conversation
-- for ad leads who ask for OTHER projects in a region («مهتم بمشاريع سكنية اخرى
-- في شمال الرياض»). The agent asks one short question at a time (unit type ->
-- bedrooms -> budget), searches our projects with the Project Finder, sends the
-- best one, and keeps going. Preferences are recorded by the EXISTING chat
-- auto-read as proposals for the rep (operator choice) — this migration only
-- adds the conversation state and a debounced turn queue.
--
-- Operator choices: the agent keeps going even after a rep replies; only the
-- global kill switch (whatsapp_ai_settings.is_enabled) and agent_mode stop it.
-- Rollout: agent_mode 'test' (only phones in agent_test_phones) -> 'on'.
--
-- Never raises SQLSTATE 40001/40P01 (see CLAUDE.md). Service-role only.

-- 1. Settings: rollout switch, test allowlist, per-conversation reply cap.
ALTER TABLE public.whatsapp_ai_settings
  ADD COLUMN IF NOT EXISTS agent_mode text NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS agent_test_phones text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS agent_max_turns int NOT NULL DEFAULT 20;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_ai_settings_agent_mode_chk') THEN
    ALTER TABLE public.whatsapp_ai_settings
      ADD CONSTRAINT whatsapp_ai_settings_agent_mode_chk CHECK (agent_mode IN ('off','test','on'));
  END IF;
END $$;

-- 2. One conversation per chat.
CREATE TABLE IF NOT EXISTS public.wa_agent_conversations (
  chat_wid         text PRIMARY KEY,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','handed_off')),
  source           text NOT NULL,                 -- 'ad_other_projects' | 'test'
  ad_project_id    uuid,                          -- the ad's project: the lead PASSED on it — never offered
  slots            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {city, zone, unit_types[], bedrooms_min, budget_max, gender}
  asked            text,                          -- last question asked: zone|unit_type|bedrooms|budget|more
  sent_project_ids uuid[] NOT NULL DEFAULT '{}',
  turns            int NOT NULL DEFAULT 0,        -- agent replies so far
  last_turn_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wa_agent_conversations ENABLE ROW LEVEL SECURITY;  -- no policies = service role only

-- 3. Debounced turn queue. At most ONE queued turn per chat (a burst of messages
--    pushes its run_after out); a running turn and a queued one may coexist, but
--    claim never starts a chat's turn while another is running.
CREATE TABLE IF NOT EXISTS public.wa_agent_turn_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_wid      text NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_after     timestamptz NOT NULL DEFAULT now(),
  first_queued  timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  error         text,
  worker_id     text,
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wa_agent_turn_jobs_one_queued
  ON public.wa_agent_turn_jobs (chat_wid) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS wa_agent_turn_jobs_claim
  ON public.wa_agent_turn_jobs (run_after) WHERE status = 'queued';
ALTER TABLE public.wa_agent_turn_jobs ENABLE ROW LEVEL SECURITY;

-- 3a. Enqueue (debounced). A new message within the window pushes the turn out,
--     but never more than 60 s past the first queued message.
CREATE OR REPLACE FUNCTION public.wa_agent_turn_enqueue(p_chat_wid text, p_delay_s int DEFAULT 8)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF coalesce(p_chat_wid, '') = '' THEN RETURN NULL; END IF;
  UPDATE public.wa_agent_turn_jobs
     SET run_after = least(now() + make_interval(secs => p_delay_s), first_queued + interval '60 seconds')
   WHERE chat_wid = p_chat_wid AND status = 'queued'
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO public.wa_agent_turn_jobs (chat_wid, run_after)
  VALUES (p_chat_wid, now() + make_interval(secs => p_delay_s))
  ON CONFLICT (chat_wid) WHERE status = 'queued' DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 3b. Claim the next due turn — never a chat that already has a running turn.
CREATE OR REPLACE FUNCTION public.wa_agent_turn_claim_next(p_worker text)
RETURNS TABLE (id uuid, chat_wid text, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.wa_agent_turn_jobs;
BEGIN
  SELECT * INTO r FROM public.wa_agent_turn_jobs j
   WHERE j.status = 'queued' AND j.run_after <= now()
     AND NOT EXISTS (SELECT 1 FROM public.wa_agent_turn_jobs x
                      WHERE x.chat_wid = j.chat_wid AND x.status = 'running')
   ORDER BY j.run_after
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.wa_agent_turn_jobs
     SET status = 'running', worker_id = p_worker, attempts = r.attempts + 1,
         started_at = now(), heartbeat_at = now()
   WHERE wa_agent_turn_jobs.id = r.id;
  RETURN QUERY SELECT r.id, r.chat_wid, r.attempts + 1;
END $$;

-- 3c. Complete / fail (only a running row). Fail requeues with backoff under 3 attempts.
CREATE OR REPLACE FUNCTION public.wa_agent_turn_complete(p_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.wa_agent_turn_jobs SET status = 'done', finished_at = now(), error = NULL
   WHERE id = p_id AND status = 'running';
$$;

CREATE OR REPLACE FUNCTION public.wa_agent_turn_fail(p_id uuid, p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempts int; v_chat text;
BEGIN
  SELECT attempts, chat_wid INTO v_attempts, v_chat
    FROM public.wa_agent_turn_jobs WHERE id = p_id AND status = 'running';
  IF NOT FOUND THEN RETURN; END IF;
  -- A retry must not collide with a newer queued turn for the same chat: if one
  -- exists, that turn will read the same unanswered messages — just fail this one.
  IF v_attempts < 3 AND NOT EXISTS (SELECT 1 FROM public.wa_agent_turn_jobs
                                      WHERE chat_wid = v_chat AND status = 'queued') THEN
    UPDATE public.wa_agent_turn_jobs
       SET status = 'queued', error = left(p_error, 500),
           run_after = now() + make_interval(secs => 15 * v_attempts),
           worker_id = NULL, heartbeat_at = NULL
     WHERE id = p_id;
  ELSE
    UPDATE public.wa_agent_turn_jobs
       SET status = 'failed', error = left(p_error, 500), finished_at = now()
     WHERE id = p_id;
  END IF;
END $$;

-- 3d. Watchdog: a crashed worker's running turn (stale > 3 min) is failed so the
--     chat is not blocked forever (claim skips chats with a running turn).
CREATE OR REPLACE FUNCTION public.wa_agent_turn_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  WITH stale AS (
    UPDATE public.wa_agent_turn_jobs
       SET status = 'failed', error = coalesce(error, '') || ' [watchdog]', finished_at = now()
     WHERE status = 'running' AND coalesce(heartbeat_at, started_at) < now() - interval '3 minutes'
    RETURNING 1)
  SELECT count(*) INTO v_n FROM stale;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.wa_agent_turn_enqueue(text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_agent_turn_claim_next(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_agent_turn_complete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_agent_turn_fail(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_agent_turn_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_agent_turn_enqueue(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_agent_turn_claim_next(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_agent_turn_complete(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_agent_turn_fail(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_agent_turn_watchdog() TO service_role;
