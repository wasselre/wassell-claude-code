-- WhatsApp sales agent v2 — the "brain" (2026-09-29).
--
-- The v1 agent understood the customer with an LLM but spoke only in ~10 fixed
-- sentences and sent the Finder's single best match. The operator found it cold
-- and asked for a real agent: one that writes its own replies (in the reps'
-- voice), narrows a large result set with more questions before sending, answers
-- questions from real project facts, and can take ALL chats.
--
-- The brain is a Claude tool-use loop (api/_lib/salesAgent/brain.ts). v1 stays as
-- the fallback whenever the brain fails or its reply fails the guard twice. Every
-- knob is DATA so the operator can change model / cost / reach without a deploy.
--
--   agent_brain  'llm'   → the brain, v1 as fallback      (default)
--                'rules' → v1 only (the fixed-sentence agent)
--   agent_model  Anthropic model id for the brain            (default claude-opus-5-5)
--   agent_effort low | medium | high                         (default low — chat)
--   agent_scope  'other_projects' → only ad leads asking for other projects (v1 reach)
--                'all'            → any inbound customer message
--                In agent_mode='test' the allowlisted phones always get 'all'.
--
-- Backward compatible: additive columns with defaults. Service-role table.

ALTER TABLE public.whatsapp_ai_settings
  ADD COLUMN IF NOT EXISTS agent_brain  text NOT NULL DEFAULT 'llm',
  ADD COLUMN IF NOT EXISTS agent_model  text NOT NULL DEFAULT 'claude-opus-5-5',
  ADD COLUMN IF NOT EXISTS agent_effort text NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS agent_scope  text NOT NULL DEFAULT 'other_projects';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_ai_settings_agent_brain_chk') THEN
    ALTER TABLE public.whatsapp_ai_settings
      ADD CONSTRAINT whatsapp_ai_settings_agent_brain_chk CHECK (agent_brain IN ('llm', 'rules'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_ai_settings_agent_effort_chk') THEN
    ALTER TABLE public.whatsapp_ai_settings
      ADD CONSTRAINT whatsapp_ai_settings_agent_effort_chk CHECK (agent_effort IN ('low', 'medium', 'high'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_ai_settings_agent_scope_chk') THEN
    ALTER TABLE public.whatsapp_ai_settings
      ADD CONSTRAINT whatsapp_ai_settings_agent_scope_chk CHECK (agent_scope IN ('other_projects', 'all'));
  END IF;
END $$;
