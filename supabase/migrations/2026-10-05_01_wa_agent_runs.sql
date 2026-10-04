-- One row per WhatsApp agent turn — what the AI read, searched, found, did and
-- said (operator, 2026-10-05: "cards showing what the AI has done in this
-- chat, the runs it made, the preferences it had, the search it made, what it
-- found, what it has done, what it has changed"). Until now a turn left only a
-- console line; the chat's AI activity cards and the client's AI timeline read
-- this table. Written by api/_lib/salesAgent/turn.ts (service role) after the
-- turn; a failed insert never fails the turn (logged).
--
-- Service-role only; read through /api/chat-ai-activity, which checks the
-- caller can see the chat / client. No 40001/40P01.

BEGIN;

CREATE TABLE IF NOT EXISTS public.wa_agent_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_wid       text NOT NULL,
  client_id      uuid,
  kind           text NOT NULL CHECK (kind IN ('brain', 'rules', 'holding')),
  model          text,
  ms             integer,
  customer_text  text,
  -- The shared preference reader's reading of the customer (prefReading.ts).
  reading        jsonb,
  -- [{criteria, total, relaxed, top:[{id,name,district,price_from}], area_understood, overrides}]
  searches       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- {sent_project, sent_units, booked, handoff, asked, ended}
  actions        jsonb NOT NULL DEFAULT '{}'::jsonb,
  reply          text,
  reply_sent     boolean,
  reply_failed   boolean NOT NULL DEFAULT false,
  guard_problems text[] NOT NULL DEFAULT '{}',
  tool_trace     text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_agent_runs_chat_idx ON public.wa_agent_runs (chat_wid, created_at DESC);
CREATE INDEX IF NOT EXISTS wa_agent_runs_client_idx ON public.wa_agent_runs (client_id, created_at DESC);

ALTER TABLE public.wa_agent_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_agent_runs FROM anon, authenticated;
GRANT ALL ON public.wa_agent_runs TO service_role;

COMMIT;
