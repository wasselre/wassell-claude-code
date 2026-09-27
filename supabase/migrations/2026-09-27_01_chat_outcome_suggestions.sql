-- ============================================================================
-- AI chat-outcome suggestions — the WhatsApp twin of call_result_suggestions.
--
-- WHY
--   Measured 2026-09-27 over the last 30 days: 704 follow-ups closed, and only
--   100 of them closed with an outcome a rep chose. Reps work on WhatsApp; the
--   outcome picker lives on a separate screen, so the outcome — the thing every
--   sales workflow triggers on — is almost never recorded, and clients stop
--   moving through the stages (314 still «جديد»).
--
--   This lane reads the conversation after the client writes, proposes the
--   outcome for the client's open follow-up, and the chat screen shows it on a
--   task bar. The rep confirms with one tap (or changes it). NOTHING is applied
--   without a human: a 'ready' row is a proposal, and the follow-up is completed
--   through the app's normal completion path so the outcome workflows fire
--   exactly once, from one place — same posture as call_result_suggestions.
--
-- FLOW
--   client message (chat_messages INSERT, flow='in')  ─┐
--   voice-note transcript lands (UPDATE OF transcript) ─┴→ enqueue: one QUEUED
--     row per client, not_before = now()+3 min. Every further message pushes
--     not_before out again, so a burst of five messages is read ONCE, after the
--     client stops typing.
--   worker claims (not_before passed) → matches the client's open follow-up AT
--     CLAIM TIME (tasks change during the quiet window) → DeepSeek → ready /
--     no_signal. A newer ready row supersedes older ready rows for the client.
--   rep confirms / dismisses from the chat → confirmed / dismissed.
--
-- STATUS
--   queued → running → ready → confirmed | dismissed | superseded
--                    ↘ no_signal  (conversation has no decision in it yet)
--                    ↘ skipped    (no open follow-up to attach to)
--                    ↘ failed     (worker error; watchdog sweeps stragglers)
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_outcome_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL,
  chat_record_id     uuid,                        -- the chats record (conversation)
  chat_wid           text,
  rep_user_id        uuid,                        -- client owner at enqueue time

  -- Filled at CLAIM time: the follow-up this proposal completes.
  followup_id        uuid,
  followup_type      text,

  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','ready','confirmed','dismissed',
                                         'superseded','no_signal','skipped','failed')),
  not_before         timestamptz NOT NULL DEFAULT now(),
  last_message_at    timestamptz,                 -- newest message the worker read

  -- What the AI proposed.
  suggested_outcome  text,
  confidence         int,
  reasoning          text,
  summary            text,
  suggested_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  quoted_phrase      text,
  model              text,

  -- What the human chose — the accuracy ledger (suggested vs confirmed).
  confirmed_outcome  text,
  confirmed_fields   jsonb,
  confirmed_by       uuid,
  confirmed_at       timestamptz,

  attempts           int NOT NULL DEFAULT 0,
  error              text,
  worker_id          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

-- One waiting job per client: further messages extend its quiet window.
CREATE UNIQUE INDEX IF NOT EXISTS cos_one_queued_per_client_idx
  ON public.chat_outcome_suggestions (client_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS cos_claimable_idx
  ON public.chat_outcome_suggestions (not_before) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS cos_running_idx
  ON public.chat_outcome_suggestions (started_at) WHERE status = 'running';
-- The chat task bar's query: this client's live proposal.
CREATE INDEX IF NOT EXISTS cos_client_ready_idx
  ON public.chat_outcome_suggestions (client_id, created_at DESC) WHERE status = 'ready';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Whoever can see the CLIENT can see and act on the proposal — the sub-select
-- runs with the caller's rights, so the records-table policies decide. (A chat
-- is often worked by someone other than the client's owner, so owner-only
-- visibility, as on call suggestions, would hide it from the person replying.)
-- Workers write with service_role. The browser can only flip a READY row to
-- confirmed/dismissed, and only those columns.

ALTER TABLE public.chat_outcome_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cos_select ON public.chat_outcome_suggestions;
CREATE POLICY cos_select ON public.chat_outcome_suggestions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.records r WHERE r.id = chat_outcome_suggestions.client_id));

DROP POLICY IF EXISTS cos_resolve ON public.chat_outcome_suggestions;
CREATE POLICY cos_resolve ON public.chat_outcome_suggestions
  FOR UPDATE TO authenticated
  USING (status = 'ready'
         AND EXISTS (SELECT 1 FROM public.records r WHERE r.id = chat_outcome_suggestions.client_id))
  WITH CHECK (status IN ('confirmed', 'dismissed'));

REVOKE ALL ON public.chat_outcome_suggestions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.chat_outcome_suggestions TO authenticated;
GRANT UPDATE (status, confirmed_outcome, confirmed_fields, confirmed_by, confirmed_at)
  ON public.chat_outcome_suggestions TO authenticated;
GRANT ALL ON public.chat_outcome_suggestions TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'chat_outcome_suggestions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_outcome_suggestions;
  END IF;
END $$;
ALTER TABLE public.chat_outcome_suggestions REPLICA IDENTITY FULL;

-- ── matching ────────────────────────────────────────────────────────────────

/**
 * The client's open follow-up a chat outcome belongs to.
 * A WhatsApp task first (it is the chat channel's own task); otherwise the
 * newest open task of any type — e.g. a booking call that is still open because
 * the CLIENT wrote first and nobody has messaged them yet.
 */
CREATE OR REPLACE FUNCTION public._cos_match_open_followup(p_client uuid)
RETURNS TABLE (followup_id uuid, followup_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT f.id, COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type')
  FROM public.records f
  WHERE f.model_id = public._sales_followups_model_id()
    AND public._followup_client_id_of(f.data) = p_client::text
    AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
  ORDER BY (COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'whatsapp_follow_up') DESC,
           f.created_at DESC
  LIMIT 1;
$fn$;

-- ── enqueue ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_enqueue(
  p_client uuid, p_chat_record uuid, p_chat_wid text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_stage text;
  v_owner text;
  v_rep   uuid;
  v_id    uuid;
BEGIN
  IF p_client IS NULL THEN RETURN NULL; END IF;
  SELECT data->>'client_stage',
         CASE jsonb_typeof(data->'client_owner')
           WHEN 'array' THEN data->'client_owner'->>0 ELSE data->>'client_owner' END
    INTO v_stage, v_owner
  FROM public.records WHERE id = p_client;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Same terminal/suspended list the WhatsApp reconcilers skip.
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب') THEN RETURN NULL; END IF;
  IF v_owner ~* '^[0-9a-f-]{36}$' THEN v_rep := v_owner::uuid; END IF;

  INSERT INTO public.chat_outcome_suggestions
    (client_id, chat_record_id, chat_wid, rep_user_id, not_before)
  VALUES (p_client, p_chat_record, p_chat_wid, v_rep, now() + interval '3 minutes')
  ON CONFLICT (client_id) WHERE status = 'queued' DO UPDATE
     SET not_before     = EXCLUDED.not_before,
         chat_record_id = COALESCE(EXCLUDED.chat_record_id, chat_outcome_suggestions.chat_record_id),
         chat_wid       = COALESCE(EXCLUDED.chat_wid, chat_outcome_suggestions.chat_wid)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

/**
 * Trigger on chat_messages. Must NEVER break message ingest: any failure is
 * turned into a WARNING in the Postgres log (the ingest row still lands, and a
 * missed suggestion only means the rep picks the outcome by hand as today).
 */
CREATE OR REPLACE FUNCTION public.tg_chat_messages_enqueue_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_client text;
  v_digits text;
BEGIN
  IF NEW.flow IS DISTINCT FROM 'in' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT'
     AND COALESCE(NULLIF(btrim(NEW.body), ''), NULLIF(btrim(NEW.media_caption), ''), NULLIF(btrim(NEW.transcript), '')) IS NULL
     AND COALESCE(NEW.media_mime, '') NOT LIKE 'audio/%' THEN
    RETURN NEW;   -- sticker / bare image: nothing to read. Voice notes re-fire on transcript.
  END IF;

  BEGIN
    -- The operations line (project officers) is outside the sales funnel.
    IF EXISTS (SELECT 1 FROM public.whatsapp_numbers w
               WHERE w.device_id = NEW.device_id AND w.is_operations IS TRUE) THEN
      RETURN NEW;
    END IF;

    IF NEW.conversation_record_id IS NOT NULL THEN
      SELECT data->>'client_link' INTO v_client FROM public.records WHERE id = NEW.conversation_record_id;
    END IF;
    -- A brand-new conversation is linked by the ingest AFTER this insert; use
    -- the same phone matcher it uses so the first message is not missed.
    IF NULLIF(v_client, '') IS NULL THEN
      v_digits := substring(COALESCE(NEW.chat_wid, '') FROM '^(\d{8,15})@');
      IF v_digits IS NOT NULL THEN
        v_client := public.find_client_id_by_phone('+' || v_digits)::text;
      END IF;
    END IF;
    IF v_client IS NULL OR v_client !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;

    PERFORM public.chat_outcome_suggestion_enqueue(v_client::uuid, NEW.conversation_record_id, NEW.chat_wid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_outcome enqueue failed for message % (%): %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS chat_messages_enqueue_outcome ON public.chat_messages;
CREATE TRIGGER chat_messages_enqueue_outcome
AFTER INSERT ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION public.tg_chat_messages_enqueue_outcome();

DROP TRIGGER IF EXISTS chat_messages_enqueue_outcome_transcript ON public.chat_messages;
CREATE TRIGGER chat_messages_enqueue_outcome_transcript
AFTER UPDATE OF transcript ON public.chat_messages
FOR EACH ROW
WHEN (NEW.transcript IS NOT NULL AND OLD.transcript IS DISTINCT FROM NEW.transcript)
EXECUTE FUNCTION public.tg_chat_messages_enqueue_outcome();

-- ── worker RPCs ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_claim_next(p_worker_id text)
RETURNS TABLE (
  id uuid, client_id uuid, chat_record_id uuid, chat_wid text,
  followup_id uuid, followup_type text, attempts int
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_id    uuid;
  v_fu    uuid;
  v_type  text;
  v_cl    uuid;
BEGIN
  SELECT s.id, s.client_id INTO v_id, v_cl
  FROM public.chat_outcome_suggestions s
  WHERE s.status = 'queued' AND s.not_before <= now()
  ORDER BY s.not_before
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  SELECT m.followup_id, m.followup_type INTO v_fu, v_type
  FROM public._cos_match_open_followup(v_cl) m;

  RETURN QUERY
  UPDATE public.chat_outcome_suggestions s
     SET status = 'running', worker_id = p_worker_id, started_at = now(),
         attempts = s.attempts + 1, followup_id = v_fu, followup_type = v_type
   WHERE s.id = v_id
  RETURNING s.id, s.client_id, s.chat_record_id, s.chat_wid, s.followup_id, s.followup_type, s.attempts;
END;
$fn$;

/**
 * Worker finished. p_outcome NULL = the conversation holds no decision yet
 * (status 'no_signal', never shown). A READY row retires the client's older
 * ready rows, so the chat only ever shows the newest reading.
 */
CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_ready(
  p_id uuid, p_outcome text, p_confidence int, p_reasoning text, p_summary text,
  p_fields jsonb, p_quoted text, p_model text, p_last_message_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_client uuid;
BEGIN
  UPDATE public.chat_outcome_suggestions
     SET status = CASE WHEN p_outcome IS NULL THEN 'no_signal' ELSE 'ready' END,
         finished_at = now(), error = NULL,
         suggested_outcome = p_outcome, confidence = p_confidence,
         reasoning = p_reasoning, summary = p_summary,
         suggested_fields = COALESCE(p_fields, '{}'::jsonb),
         quoted_phrase = p_quoted, model = p_model, last_message_at = p_last_message_at
   WHERE id = p_id AND status = 'running'
  RETURNING client_id INTO v_client;
  IF v_client IS NULL THEN RETURN false; END IF;

  -- Only a NEW proposal replaces an older one. A no_signal reading («still
  -- chatting») leaves an earlier, still-unanswered proposal on screen.
  IF p_outcome IS NOT NULL THEN
    UPDATE public.chat_outcome_suggestions
       SET status = 'superseded', finished_at = now()
     WHERE client_id = v_client AND status = 'ready' AND id <> p_id;
  END IF;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_skip(p_id uuid, p_reason text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH u AS (
    UPDATE public.chat_outcome_suggestions
       SET status = 'skipped', finished_at = now(), error = p_reason
     WHERE id = p_id AND status = 'running' RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$fn$;

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_fail(p_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH u AS (
    UPDATE public.chat_outcome_suggestions
       SET status = 'failed', finished_at = now(), error = p_error
     WHERE id = p_id AND status = 'running' RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$fn$;

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestions_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_n int;
BEGIN
  UPDATE public.chat_outcome_suggestions
     SET status = 'failed', finished_at = now(),
         error = 'chat-outcome worker did not finish within 10 minutes'
   WHERE status = 'running' AND started_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

-- ── the rep's decision (caller's rights — RLS decides) ──────────────────────

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_resolve(
  p_id uuid, p_action text, p_outcome text DEFAULT NULL, p_fields jsonb DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_action NOT IN ('confirmed', 'dismissed') THEN
    RAISE EXCEPTION 'chat_outcome_suggestion_resolve: action must be confirmed or dismissed, got %', p_action
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.chat_outcome_suggestions
     SET status = p_action,
         confirmed_outcome = CASE WHEN p_action = 'confirmed' THEN p_outcome END,
         confirmed_fields  = CASE WHEN p_action = 'confirmed' THEN COALESCE(p_fields, '{}'::jsonb) END,
         confirmed_by = public.wassell_app_user_id(auth.uid()),
         confirmed_at = now()
   WHERE id = p_id AND status = 'ready';
  RETURN FOUND;
END;
$fn$;

-- ── grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public._cos_match_open_followup(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_enqueue(uuid, uuid, text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_chat_messages_enqueue_outcome()                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_claim_next(text)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_ready(uuid, text, int, text, text, jsonb, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_skip(uuid, text)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_fail(uuid, text)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestions_watchdog()                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_resolve(uuid, text, text, jsonb)         FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public._cos_match_open_followup(uuid)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_enqueue(uuid, uuid, text)             TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_claim_next(text)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_ready(uuid, text, int, text, text, jsonb, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_skip(uuid, text)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_fail(uuid, text)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestions_watchdog()                           TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_resolve(uuid, text, text, jsonb)      TO authenticated, service_role;

COMMIT;
