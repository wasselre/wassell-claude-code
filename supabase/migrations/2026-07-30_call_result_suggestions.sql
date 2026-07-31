-- ============================================================================
-- AI call-result suggestions — the queue AND the result, in one table.
--
-- WHAT THIS IS
--   A rep works a call task, dials, hangs up, and moves on to the next task
--   WITHOUT completing the one they just did. Hatif delivers the recording +
--   transcript a few seconds later; a worker asks DeepSeek to read the
--   conversation and propose the outcome; the rep gets a full-page popup that
--   reminds them who the client was, lets them play the recording, and asks
--   them to confirm one pre-selected answer.
--
--   Nothing is ever applied without a human. A row reaching status='ready' is a
--   PROPOSAL. Only `call_result_suggestion_confirm` records what the rep chose,
--   and the actual follow-up completion still goes through the app's normal
--   write path so the outcome workflows fire exactly as they do today.
--
-- WHY ONE TABLE INSTEAD OF A QUEUE + A RESULT TABLE
--   The terminal state of this job IS "awaiting a human", so the queue row and
--   the suggestion are the same object. Keeping both halves together also gives
--   the audit trail that makes the model measurable: every row stores what the
--   AI proposed AND what the human actually chose, so
--   `suggested_outcome <> confirmed_outcome` is a standing accuracy metric
--   rather than a one-off benchmark.
--
-- STATUS FLOW
--   queued → running → ready → confirmed
--                    ↘ failed        (worker error; watchdog sweeps stragglers)
--                    ↘ cancelled     (follow-up completed by hand meanwhile)
--
-- KIND
--   confirm_followup — the call matched an open call-type follow-up. Confirming
--                      completes that follow-up.
--   log_interaction  — the rep called someone with no open call task (a client
--                      ringing back, dialling ahead). Confirming creates AND
--                      completes a follow-up, same as the existing chat
--                      Log-interaction path, so the client history stays true.
--
-- Measured on wassell-prod 2026-07-30, and the reason for several choices here:
--   • 98.4% of connected outbound calls carry a transcript; 100% are diarized,
--     but only 3.6% carry Hatif's Agent/Customer ROLE labels (July onward). The
--     worker must infer roles, never require them.
--   • `agent_user_id` is populated on 1,070/1,328 calls — enough to route a
--     suggestion to the rep who actually dialled.
--   • 55% of call-type follow-ups end `no_answer`, and those calls have no
--     recording and no transcript at all. The worker resolves those
--     DETERMINISTICALLY from Hatif's own status and never spends a token.
-- ============================================================================

BEGIN;

-- ── table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.call_result_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was analysed.
  call_record_id     uuid NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  call_log_id        uuid,                       -- call_logs row (same id as the phone_calls record)
  client_id          uuid,
  rep_user_id        uuid,                       -- public.users.id — who sees the popup

  -- What it completes.
  followup_id        uuid,                       -- NULL for kind='log_interaction'
  followup_type      text,
  kind               text NOT NULL DEFAULT 'confirm_followup'
                       CHECK (kind IN ('confirm_followup', 'log_interaction')),

  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','ready','confirmed','failed','cancelled')),

  -- What the AI proposed.
  suggested_outcome  text,
  confidence         int,
  reasoning          text,                       -- short Arabic rationale shown to the rep
  summary            text,                       -- Arabic call summary
  -- Prefilled required fields: reschedule_contact_date / outcome_notes /
  -- lost_reason. The rep edits these in the popup before confirming.
  suggested_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The customer's own words that produced a proposed date («بعد نص ساعة»), so
  -- the rep can sanity-check the extraction at a glance instead of trusting a
  -- bare timestamp. Date extraction is the likeliest thing to be wrong.
  quoted_phrase      text,
  model              text,
  source             text,                       -- 'deepseek' | 'deterministic'

  -- What the human actually chose. The accuracy ledger.
  confirmed_outcome  text,
  confirmed_fields   jsonb,
  confirmed_by       uuid,
  confirmed_at       timestamptz,

  -- Queue plumbing.
  attempts           int NOT NULL DEFAULT 0,
  error              text,
  worker_id          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

-- ── indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS crs_queued_by_age_idx
  ON public.call_result_suggestions (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS crs_running_by_started_idx
  ON public.call_result_suggestions (started_at) WHERE status = 'running';

-- One live suggestion per call — the trigger fires on every phone_calls write
-- (Hatif sends several per call as the recording and transcript land), and
-- without this a single call would queue three or four analyses.
CREATE UNIQUE INDEX IF NOT EXISTS crs_one_active_per_call_idx
  ON public.call_result_suggestions (call_record_id)
  WHERE status IN ('queued','running','ready');

-- The popup's own query: this rep's pending confirmations, oldest first.
CREATE INDEX IF NOT EXISTS crs_rep_pending_idx
  ON public.call_result_suggestions (rep_user_id, created_at) WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS crs_followup_idx ON public.call_result_suggestions (followup_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- A rep reads only their own suggestions. Every write is service-role: the
-- worker fills them in, and confirmation goes through the SECURITY DEFINER RPC
-- below so a browser can never fabricate "the AI said so".

ALTER TABLE public.call_result_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crs_own_select ON public.call_result_suggestions;
CREATE POLICY crs_own_select ON public.call_result_suggestions
  FOR SELECT TO authenticated
  USING (rep_user_id = public.wassell_app_user_id((SELECT auth.uid())));

-- Realtime so the popup arrives without polling.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'call_result_suggestions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.call_result_suggestions;
  END IF;
END $$;
ALTER TABLE public.call_result_suggestions REPLICA IDENTITY FULL;

-- ── matching: which open follow-up did this call complete? ──────────────────

/**
 * The client's open CALL-type follow-up nearest this call in time.
 *
 * Deliberately different from the ±15-minute EVIDENCE window used when a rep
 * completes a task by hand (see 2026-07-30_tighten_call_followup_link_window):
 * there the anchor is the completion timestamp, here the follow-up is still
 * OPEN and has no completion time, so the anchor is `scheduled_datetime`. The
 * bound is a day rather than minutes because a rep legitimately works a task
 * hours after it was scheduled — the tight guard is that the follow-up must be
 * OPEN, CALL-channel, and belong to this client.
 */
CREATE OR REPLACE FUNCTION public._crs_match_open_followup(p_client uuid, p_call_time timestamptz, p_rep uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT f.id
  FROM public.records f
  WHERE f.model_id = public._sales_followups_model_id()
    AND public._followup_client_id_of(f.data) = p_client::text
    AND COALESCE(f.data->>'followup_status', 'open') IN ('open', 'in_progress')
    AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type')
        IS DISTINCT FROM 'whatsapp_follow_up'
    -- Unassigned tasks count as this rep's (same rule the Sales queue uses).
    AND (
      p_rep IS NULL
      OR NULLIF(COALESCE(f.data->'sales_rep'->>0, f.data->>'sales_rep'), '') IS NULL
      OR NULLIF(COALESCE(f.data->'sales_rep'->>0, f.data->>'sales_rep'), '') = p_rep::text
    )
  ORDER BY abs(extract(epoch FROM (
             COALESCE(public.try_timestamptz(f.data->>'scheduled_datetime'), p_call_time) - p_call_time
           ))) ASC,
           f.created_at ASC
  LIMIT 1;
$fn$;

-- ── enqueue ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.call_result_suggestion_enqueue(p_call_record_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_calls   uuid := public._sales_phone_calls_model_id();
  v_rec     public.records%ROWTYPE;
  v_client  uuid;
  v_rep     uuid;
  v_when    timestamptz;
  v_match   uuid;
  v_ftype   text;
  v_id      uuid;
BEGIN
  SELECT * INTO v_rec FROM public.records WHERE id = p_call_record_id;
  IF NOT FOUND OR v_rec.model_id IS DISTINCT FROM v_calls THEN RETURN NULL; END IF;
  IF v_rec.data->>'direction' IS DISTINCT FROM 'outbound' THEN RETURN NULL; END IF;

  v_client := NULLIF(v_rec.data->>'client_link', '')::uuid;
  IF v_client IS NULL THEN RETURN NULL; END IF;   -- nothing to remind the rep about

  -- `agent_name` is an assignee field: bare string on some paths, single-element
  -- array on others. Accept both rather than depending on the writer.
  v_rep := NULLIF(
    CASE jsonb_typeof(v_rec.data->'agent_name')
      WHEN 'array'  THEN v_rec.data->'agent_name'->>0
      WHEN 'string' THEN v_rec.data->>'agent_name'
    END, '')::uuid;
  IF v_rep IS NULL THEN
    SELECT agent_user_id INTO v_rep FROM public.call_logs WHERE id = p_call_record_id;
  END IF;
  IF v_rep IS NULL THEN RETURN NULL; END IF;      -- nobody to show the popup to

  v_when := COALESCE(public.try_timestamptz(v_rec.data->>'call_time'), v_rec.created_at, now());
  v_match := public._crs_match_open_followup(v_client, v_when, v_rep);

  IF v_match IS NOT NULL THEN
    SELECT COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') INTO v_ftype
    FROM public.records f WHERE f.id = v_match;
  END IF;

  INSERT INTO public.call_result_suggestions
    (call_record_id, call_log_id, client_id, rep_user_id, followup_id, followup_type, kind)
  VALUES
    (p_call_record_id, p_call_record_id, v_client, v_rep, v_match, v_ftype,
     CASE WHEN v_match IS NULL THEN 'log_interaction' ELSE 'confirm_followup' END)
  ON CONFLICT (call_record_id) WHERE status IN ('queued','running','ready') DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- ── trigger: a finished outbound call enqueues one analysis ─────────────────

CREATE OR REPLACE FUNCTION public.tg_records_enqueue_call_analysis()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_terminal CONSTANT text[] := ARRAY['completed','no_answer','missed','rejected_by_callee','rejected_by_caller','failed','cancelled'];
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_phone_calls_model_id() THEN RETURN NEW; END IF;
  IF NEW.data->>'direction' IS DISTINCT FROM 'outbound' THEN RETURN NEW; END IF;
  -- Only once the call is over. Hatif writes the row while it is still ringing.
  IF NOT (COALESCE(NEW.data->>'status','') = ANY (v_terminal)) THEN RETURN NEW; END IF;
  -- Nothing meaningful changed → don't re-enqueue (the weekly-reconcile shape).
  IF TG_OP = 'UPDATE'
     AND OLD.data->>'status' IS NOT DISTINCT FROM NEW.data->>'status'
     AND OLD.data->>'transcription_text' IS NOT DISTINCT FROM NEW.data->>'transcription_text'
     AND OLD.data->>'client_link' IS NOT DISTINCT FROM NEW.data->>'client_link'
  THEN RETURN NEW; END IF;

  PERFORM public.call_result_suggestion_enqueue(NEW.id);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_enqueue_call_analysis ON public.records;
CREATE TRIGGER records_enqueue_call_analysis
AFTER INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_enqueue_call_analysis();

-- ── worker RPCs ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.call_result_suggestion_claim_next(p_worker_id text)
RETURNS TABLE (
  id uuid, call_record_id uuid, call_log_id uuid, client_id uuid,
  rep_user_id uuid, followup_id uuid, followup_type text, kind text, attempts int
) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.call_result_suggestions
     SET status = 'running', worker_id = p_worker_id, started_at = now(),
         attempts = call_result_suggestions.attempts + 1
   WHERE id = (
     SELECT s.id FROM public.call_result_suggestions s
      WHERE s.status = 'queued' ORDER BY s.created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
   )
   RETURNING id, call_record_id, call_log_id, client_id,
             rep_user_id, followup_id, followup_type, kind, attempts;
$fn$;

/** Worker finished: the row becomes a PROPOSAL awaiting a human. */
CREATE OR REPLACE FUNCTION public.call_result_suggestion_ready(
  p_id uuid, p_outcome text, p_confidence int, p_reasoning text, p_summary text,
  p_fields jsonb, p_quoted text, p_model text, p_source text
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH updated AS (
    UPDATE public.call_result_suggestions
       SET status = 'ready', finished_at = now(), error = NULL,
           suggested_outcome = p_outcome, confidence = p_confidence,
           reasoning = p_reasoning, summary = p_summary,
           suggested_fields = COALESCE(p_fields, '{}'::jsonb),
           quoted_phrase = p_quoted, model = p_model, source = p_source
     WHERE id = p_id AND status = 'running'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

CREATE OR REPLACE FUNCTION public.call_result_suggestion_fail(p_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH updated AS (
    UPDATE public.call_result_suggestions
       SET status = 'failed', finished_at = now(), error = p_error
     WHERE id = p_id AND status = 'running'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

/**
 * The rep confirmed (or overrode) the proposal.
 *
 * This ONLY records the decision — it deliberately does NOT write
 * `call_result` on the follow-up. The app completes the follow-up through its
 * existing path so the outcome workflows fire exactly once, from one place.
 * A second write path here is how you get a client moved twice.
 *
 * Callable by the authenticated rep who owns the row, hence SECURITY DEFINER
 * with an explicit ownership check.
 */
CREATE OR REPLACE FUNCTION public.call_result_suggestion_confirm(
  p_id uuid, p_outcome text, p_fields jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_me uuid := public.wassell_app_user_id(auth.uid());
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  UPDATE public.call_result_suggestions
     SET status = 'confirmed', confirmed_outcome = p_outcome,
         confirmed_fields = COALESCE(p_fields, '{}'::jsonb),
         confirmed_by = v_me, confirmed_at = now()
   WHERE id = p_id AND rep_user_id = v_me AND status = 'ready';
  RETURN FOUND;
END;
$fn$;

/** Someone completed the follow-up by hand — retire the pending proposal. */
CREATE OR REPLACE FUNCTION public.call_result_suggestion_cancel_for_followup(p_followup_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_n int;
BEGIN
  UPDATE public.call_result_suggestions
     SET status = 'cancelled', finished_at = now()
   WHERE followup_id = p_followup_id AND status IN ('queued','running','ready');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.call_result_suggestions_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_n int;
BEGIN
  UPDATE public.call_result_suggestions
     SET status = 'failed', finished_at = now(),
         error = 'analysis worker did not finish within 10 minutes'
   WHERE status = 'running' AND started_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

-- ── grants: service-role only, except the rep's own confirm ─────────────────

REVOKE ALL ON FUNCTION public._crs_match_open_followup(uuid, timestamptz, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestion_enqueue(uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestion_claim_next(text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestion_ready(uuid, text, int, text, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestion_fail(uuid, text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestions_watchdog()                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestion_cancel_for_followup(uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_result_suggestion_confirm(uuid, text, jsonb)       FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public._crs_match_open_followup(uuid, timestamptz, uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.call_result_suggestion_enqueue(uuid)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.call_result_suggestion_claim_next(text)               TO service_role;
GRANT EXECUTE ON FUNCTION public.call_result_suggestion_ready(uuid, text, int, text, text, jsonb, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.call_result_suggestion_fail(uuid, text)               TO service_role;
GRANT EXECUTE ON FUNCTION public.call_result_suggestions_watchdog()                    TO service_role;
GRANT EXECUTE ON FUNCTION public.call_result_suggestion_cancel_for_followup(uuid)      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.call_result_suggestion_confirm(uuid, text, jsonb)     TO authenticated, service_role;

COMMIT;
