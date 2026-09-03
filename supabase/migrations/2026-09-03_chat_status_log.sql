-- Chat status change LOG — a diagnostic to catch the "closed chat reopened itself"
-- bug red-handed. The chats system keeps no history of open↔close changes, so we
-- have been forced to infer the cause (and got it wrong). This records EVERY
-- status transition on a chat record with enough context to name the culprit:
--   - old_status → new_status (the transition)
-- - db_role: the Postgres role (service_role = webhook/worker/server; authenticated
--     = a browser tab; postgres = admin/MCP) — tells us browser-vs-server instantly
--   - jwt_email / jwt_sub: WHICH user's tab, when it's a browser write
--   - last_flow / last_msg_at: was the reopen accompanied by a NEW inbound message
--     (legit) or carrying stale data (a bad/racing/stale-tab overwrite)?
--   - txid + statement text hint
--
-- SAFE: AFTER-UPDATE, INSERT-only, no behavior change. Selective WHEN (only fires
-- when data.status actually changed) so it costs nothing on normal writes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_status_log (
  id             bigserial PRIMARY KEY,
  chat_record_id uuid NOT NULL,
  chat_wid       text,
  old_status     text,
  new_status     text,
  last_flow      text,        -- NEW.last_message_flow at write time
  last_msg_at    text,        -- NEW.last_message_at (raw, no cast — never error)
  db_role        text,        -- current_user: service_role / authenticated / postgres
  jwt_email      text,        -- browser writes: which user's tab
  jwt_sub        text,
  jwt_role       text,
  txid           bigint,
  changed_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_status_log_chat_idx ON public.chat_status_log (chat_record_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS chat_status_log_time_idx ON public.chat_status_log (changed_at DESC);

CREATE OR REPLACE FUNCTION public.tg_log_chat_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_chats  uuid;
  v_claims json;
BEGIN
  SELECT id INTO v_chats FROM public.models WHERE name = 'chats' LIMIT 1;
  IF NEW.model_id IS DISTINCT FROM v_chats THEN RETURN NEW; END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::json;
  EXCEPTION WHEN OTHERS THEN
    v_claims := NULL;
  END;

  INSERT INTO public.chat_status_log (
    chat_record_id, chat_wid, old_status, new_status, last_flow, last_msg_at,
    db_role, jwt_email, jwt_sub, jwt_role, txid)
  VALUES (
    NEW.id,
    NEW.data->>'wid',
    OLD.data->>'status',
    NEW.data->>'status',
    NEW.data->>'last_message_flow',
    NEW.data->>'last_message_at',
    current_user,
    v_claims->>'email',
    v_claims->>'sub',
    v_claims->>'role',
    txid_current());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_log_chat_status ON public.records;
CREATE TRIGGER records_log_chat_status
  AFTER UPDATE ON public.records
  FOR EACH ROW
  WHEN ((OLD.data->>'status') IS DISTINCT FROM (NEW.data->>'status'))
  EXECUTE FUNCTION public.tg_log_chat_status_change();

COMMIT;
