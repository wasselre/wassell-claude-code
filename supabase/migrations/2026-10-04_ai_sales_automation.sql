-- AI sales automation (2026-10-04): high interest → portal registration
-- (automatic) + officer notices and follow-up messages written by AI and held
-- for the operator's approval in the Work Queue's AI tab.
--
-- Operator decisions this encodes:
--   · HIGH INTEREST has two sources and no human: the tracked-link interest
--     score of a (chat, project) at or above a threshold (40), or the outcome
--     agent reading the follow-up result as interested AND choosing the
--     client's main project. Both land in client_project_interest.
--   · Registering in portals is the ONLY automatic action. Everything else the
--     AI does (messages to clients, messages to officers, follow-up results,
--     the main-project choice) waits in ai_actions / chat_outcome_suggestions
--     until the operator approves it.
--   · A registration with a company covers ALL its projects, so "already
--     registered in this portal" means nothing more to register.
--   · An officer is told only when the client is highly interested.
--
-- Sending: an approved action is queued on scheduled_whatsapp_jobs with
--   reference 'ai:followup:<followup_id>:<round>' (customer, sales line) or
--   'officer_notice:<action_id>' (officer, operations line). One unique index
--   makes a double approval unable to queue a second message. When a follow-up
--   message is DELIVERED, tg_ai_actions_job_sync arms that one follow-up as
--   «waiting for reply» (as if the rep had sent it) and cancels nothing — the
--   'ai:' prefix keeps reconcile_outbound_whatsapp a no-op, so call tasks stay.
--
-- No function here raises SQLSTATE 40001/40P01. Both triggers catch their own
-- errors (RAISE WARNING) so a delivery or a message insert can never fail on
-- bookkeeping.

BEGIN;

-- ── 1. Settings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_automation_settings (
  id                       int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  interest_score_threshold int NOT NULL DEFAULT 40 CHECK (interest_score_threshold BETWEEN 1 AND 100),
  portal_on_interest       boolean NOT NULL DEFAULT true,
  officer_notice_drafts    boolean NOT NULL DEFAULT true,
  followup_drafts          boolean NOT NULL DEFAULT true,
  followup_drafts_per_day  int NOT NULL DEFAULT 30 CHECK (followup_drafts_per_day >= 0),
  officer_cooldown_days    int NOT NULL DEFAULT 30 CHECK (officer_cooldown_days >= 0),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ai_automation_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.ai_automation_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_automation_settings_admin_select ON public.ai_automation_settings;
CREATE POLICY ai_automation_settings_admin_select ON public.ai_automation_settings
  FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));
REVOKE ALL ON public.ai_automation_settings FROM anon;

-- ── 2. High-interest events ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_project_interest (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL,
  project_id      uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('link_score', 'ai_outcome')),
  score           int,
  chat_wid        text,
  suggestion_id   uuid,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  -- Set once the portal step has decided (registered / covered / failed / skipped).
  portal_done_at  timestamptz,
  portal_result   jsonb,
  -- Set once the officer step has decided (drafted / no officer / cooldown …).
  officer_done_at timestamptz,
  officer_result  jsonb,
  UNIQUE (client_id, project_id, source)
);
CREATE INDEX IF NOT EXISTS client_project_interest_portal_todo ON public.client_project_interest (detected_at) WHERE portal_done_at IS NULL;
CREATE INDEX IF NOT EXISTS client_project_interest_officer_todo ON public.client_project_interest (detected_at) WHERE officer_done_at IS NULL;
ALTER TABLE public.client_project_interest ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_project_interest_admin_select ON public.client_project_interest;
CREATE POLICY client_project_interest_admin_select ON public.client_project_interest
  FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));
REVOKE ALL ON public.client_project_interest FROM anon;

-- An interest-started portal run points at its event (one interest attempt per
-- client × portal; see api/_lib/portalAutoEnqueue.ts).
ALTER TABLE public.portal_registration_jobs
  ADD COLUMN IF NOT EXISTS interest_id uuid REFERENCES public.client_project_interest(id) ON DELETE SET NULL;

-- ── 3. The outcome agent picks the client's main project ───────────────────
ALTER TABLE public.chat_outcome_suggestions
  ADD COLUMN IF NOT EXISTS suggested_main_project_id   uuid,
  ADD COLUMN IF NOT EXISTS suggested_main_project_name text,
  ADD COLUMN IF NOT EXISTS main_project_decision       text CHECK (main_project_decision IN ('approved', 'rejected'));

-- Same body as 2026-09-27_01 plus the main project. The two new parameters are
-- DEFAULTed, so the worker's existing 9-argument call resolves to this one
-- (the old signature is dropped in the same transaction — no second overload).
DROP FUNCTION IF EXISTS public.chat_outcome_suggestion_ready(uuid, text, integer, text, text, jsonb, text, text, timestamptz);
CREATE FUNCTION public.chat_outcome_suggestion_ready(
  p_id uuid, p_outcome text, p_confidence integer, p_reasoning text, p_summary text,
  p_fields jsonb, p_quoted text, p_model text, p_last_message_at timestamptz,
  p_main_project_id uuid DEFAULT NULL, p_main_project_name text DEFAULT NULL
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_client uuid; v_chat text;
BEGIN
  UPDATE public.chat_outcome_suggestions
     SET status = CASE WHEN p_outcome IS NULL THEN 'no_signal' ELSE 'ready' END,
         finished_at = now(), error = NULL,
         suggested_outcome = p_outcome, confidence = p_confidence,
         reasoning = p_reasoning, summary = p_summary,
         suggested_fields = COALESCE(p_fields, '{}'::jsonb),
         quoted_phrase = p_quoted, model = p_model, last_message_at = p_last_message_at,
         suggested_main_project_id = p_main_project_id,
         suggested_main_project_name = NULLIF(btrim(p_main_project_name), '')
   WHERE id = p_id AND status = 'running'
  RETURNING client_id, chat_wid INTO v_client, v_chat;
  IF v_client IS NULL THEN RETURN false; END IF;

  IF p_outcome IS NOT NULL THEN
    UPDATE public.chat_outcome_suggestions
       SET status = 'superseded', finished_at = now()
     WHERE client_id = v_client AND status = 'ready' AND id <> p_id;
  END IF;

  -- HIGH INTEREST from the AI: a positive result with a chosen main project.
  -- Bookkeeping must never lose the reading itself.
  IF p_outcome IN ('interested', 'appointment_booked', 'request_offer') AND p_main_project_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.client_project_interest (client_id, project_id, source, chat_wid, suggestion_id)
      VALUES (v_client, p_main_project_id, 'ai_outcome', v_chat, p_id)
      ON CONFLICT (client_id, project_id, source) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'chat_outcome_suggestion_ready: interest insert failed for %: %', p_id, SQLERRM;
    END;
  END IF;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_ready(uuid, text, integer, text, text, jsonb, text, text, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_ready(uuid, text, integer, text, text, jsonb, text, text, timestamptz, uuid, text) TO service_role;

-- ── 4. High interest from the links ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.client_interest_detect_links(p_threshold int)
 RETURNS int
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  WITH hot AS (
    SELECT v.chat_wid, v.project_id, v.score,
           COALESCE(
             v.client_id,
             CASE WHEN c.data->>'client_link' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (c.data->>'client_link')::uuid END,
             public.find_client_id_by_phone('+' || split_part(v.chat_wid, '@', 1))
           ) AS client_id
      FROM public.v_project_interest v
      LEFT JOIN public.records c ON c.id = v.conversation_record_id
     WHERE v.score >= p_threshold
       AND v.project_id IS NOT NULL
  )
  INSERT INTO public.client_project_interest (client_id, project_id, source, score, chat_wid)
  SELECT h.client_id, h.project_id, 'link_score', h.score, h.chat_wid
    FROM hot h
    JOIN public.records cl ON cl.id = h.client_id
   WHERE h.client_id IS NOT NULL
     -- Lost, closed-won and rent clients are not registered anywhere.
     AND COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'يريد إيجار')
  ON CONFLICT (client_id, project_id, source) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.client_interest_detect_links(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_interest_detect_links(int) TO service_role;

-- ── 5. Actions awaiting the operator ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('followup_message', 'officer_notice')),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'failed', 'expired')),
  client_id        uuid NOT NULL,
  -- followup_message: the customer's chat. officer_notice: the officer's chat.
  chat_wid         text,
  followup_id      uuid,
  round_key        text,
  project_id       uuid,
  officer_id       uuid,
  interest_id      uuid REFERENCES public.client_project_interest(id) ON DELETE SET NULL,
  phone            text,
  device_id        text,
  body             text NOT NULL,
  original_body    text NOT NULL,
  -- Display + audit: client/project/officer names, the brief, guard warnings.
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference        text UNIQUE,
  scheduled_job_id uuid,
  decided_by       uuid,
  decided_at       timestamptz,
  sent_at          timestamptz,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- ONE draft per follow-up round, ever (a rejected draft is not redrafted every tick).
CREATE UNIQUE INDEX IF NOT EXISTS ai_actions_one_followup_round
  ON public.ai_actions (followup_id, round_key) WHERE kind = 'followup_message';
-- ONE notice per interest event per officer.
CREATE UNIQUE INDEX IF NOT EXISTS ai_actions_one_officer_notice
  ON public.ai_actions (interest_id, officer_id) WHERE kind = 'officer_notice';
CREATE INDEX IF NOT EXISTS ai_actions_pending ON public.ai_actions (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ai_actions_job ON public.ai_actions (scheduled_job_id) WHERE scheduled_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_actions_officer_client ON public.ai_actions (officer_id, client_id, created_at) WHERE kind = 'officer_notice';
ALTER TABLE public.ai_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_actions_admin_select ON public.ai_actions;
CREATE POLICY ai_actions_admin_select ON public.ai_actions
  FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));
REVOKE ALL ON public.ai_actions FROM anon;

-- Two approvals of the same action can never queue two messages.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_whatsapp_jobs_ai_action_ref
  ON public.scheduled_whatsapp_jobs (reference)
  WHERE reference LIKE 'ai:followup:%' OR reference LIKE 'officer_notice:%';

-- ── 6. Delivery → action status, and arm the follow-up ─────────────────────
-- Mark ONE follow-up as sent and waiting for the client, exactly like
-- reconcile_outbound_whatsapp's arm — but only that task, only while it is
-- still open and unsent, and cancelling nothing.
CREATE OR REPLACE FUNCTION public.ai_followup_arm(p_followup uuid, p_sent_at timestamptz, p_action uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_model uuid;
  v_first timestamptz;
  v_attempt int;
  v_deadline timestamptz;
  v_n int;
BEGIN
  SELECT id INTO v_model FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model IS NULL THEN RETURN false; END IF;

  SELECT COALESCE(public.try_timestamptz(NULLIF(data->>'first_whatsapp_sent_at', '')), p_sent_at),
         COALESCE(NULLIF(data->>'whatsapp_attempt_number', '')::int, 1)
    INTO v_first, v_attempt
    FROM public.records WHERE id = p_followup AND model_id = v_model;
  IF NOT FOUND THEN RETURN false; END IF;

  -- One deadline rule: 24 h after attempt 1; for attempt 2+, five days from the
  -- first message but at least 48 h after this one.
  v_deadline := CASE WHEN v_attempt >= 2
                     THEN GREATEST(v_first + interval '5 days', p_sent_at + interval '48 hours')
                     ELSE p_sent_at + interval '24 hours' END;

  UPDATE public.records
     SET data = (data - 'fired_at' - 'client_messaged_at')
       || jsonb_build_object(
            'whatsapp_state',          'message_sent_waiting_response',
            'followup_status',         'in_progress',
            'sent_at',                 to_char(p_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'first_whatsapp_sent_at',  to_char(v_first AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'whatsapp_attempt_number', v_attempt,
            'scheduled_datetime',      to_char(v_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'source_followup_id',      p_followup::text,
            'agent_followup_action_id', p_action::text)
   WHERE id = p_followup
     AND model_id = v_model
     AND COALESCE(NULLIF(data->>'followup_status', ''), 'open') = 'open'
     AND COALESCE(data->>'whatsapp_state', '') = ''
     AND COALESCE(data->>'sent_at', '') = '';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$function$;
REVOKE ALL ON FUNCTION public.ai_followup_arm(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_followup_arm(uuid, timestamptz, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_ai_actions_job_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid; v_kind text; v_followup uuid; v_status text;
  v_at timestamptz := COALESCE(NEW.finished_at, now());
BEGIN
  BEGIN
    SELECT id, kind, followup_id, status INTO v_id, v_kind, v_followup, v_status
      FROM public.ai_actions WHERE reference = NEW.reference FOR UPDATE;
    IF v_id IS NULL OR v_status <> 'sending' THEN RETURN NEW; END IF;

    IF NEW.status = 'sent' THEN
      UPDATE public.ai_actions SET status = 'sent', sent_at = v_at, error = NULL, updated_at = now() WHERE id = v_id;
      IF v_kind = 'followup_message' AND v_followup IS NOT NULL
         AND NOT public.ai_followup_arm(v_followup, v_at, v_id) THEN
        UPDATE public.ai_actions
           SET context = context || jsonb_build_object('arm', 'task_already_moved'), updated_at = now()
         WHERE id = v_id;
      END IF;
    ELSIF NEW.status IN ('failed', 'cancelled', 'unknown') THEN
      UPDATE public.ai_actions
         SET status = 'failed',
             error = CASE WHEN NEW.status = 'unknown'
                          THEN 'delivery status unknown — check the chat before sending again'
                          ELSE COALESCE(NEW.error_message, NEW.status) END,
             updated_at = now()
       WHERE id = v_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_ai_actions_job_sync: job % (%): %', NEW.id, NEW.reference, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS scheduled_whatsapp_ai_actions_sync ON public.scheduled_whatsapp_jobs;
CREATE TRIGGER scheduled_whatsapp_ai_actions_sync
  AFTER UPDATE OF status ON public.scheduled_whatsapp_jobs
  FOR EACH ROW
  WHEN ((NEW.reference LIKE 'ai:followup:%' OR NEW.reference LIKE 'officer_notice:%')
        AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.tg_ai_actions_job_sync();

-- ── 7. Due WhatsApp follow-ups the AI may draft ────────────────────────────
-- Open, unsent, due, the client in an active stage with a linked chat the rep
-- has not paused, a chat the client has written in before (never a cold first
-- message), the last word ours and nobody active in the last 2 hours, no open
-- booking / no-show call (calls first), and no draft for this round yet.
CREATE OR REPLACE FUNCTION public.ai_followup_candidates(p_limit int DEFAULT 10)
 RETURNS TABLE (followup_id uuid, client_id uuid, chat_wid text, chat_record_id uuid, attempt int, due_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH m AS (
    SELECT (SELECT id FROM public.models WHERE name = 'followups' LIMIT 1) AS followups,
           (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1)     AS chats
  ), f AS (
    SELECT r.id,
           (r.data->>'client_id')::uuid AS client_id,
           COALESCE(NULLIF(r.data->>'whatsapp_attempt_number', '')::int, 1) AS attempt,
           public.try_timestamptz(r.data->>'scheduled_datetime') AS due
      FROM public.records r, m
     WHERE r.model_id = m.followups
       AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') = 'open'
       AND COALESCE(r.data->>'whatsapp_state', '') = ''
       AND COALESCE(r.data->>'sent_at', '') = ''
       AND ( (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ? 'whatsapp_follow_up')
          OR (jsonb_typeof(r.data->'followup_type') = 'string' AND r.data->>'followup_type' = 'whatsapp_follow_up') )
       AND r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.try_timestamptz(r.data->>'scheduled_datetime') <= now()
  )
  SELECT f.id, f.client_id, ch.wid, ch.id, f.attempt, f.due
    FROM f
    CROSS JOIN m
    JOIN public.records cl ON cl.id = f.client_id
    JOIN LATERAL (
      SELECT c.id, c.data->>'wid' AS wid, c.data AS cdata
        FROM public.records c
       WHERE c.model_id = m.chats AND c.data->>'client_link' = f.client_id::text AND COALESCE(c.data->>'wid', '') <> ''
       ORDER BY c.updated_at DESC
       LIMIT 1
    ) ch ON true
   WHERE COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب')
     AND COALESCE(ch.cdata->>'ai_paused', 'false') <> 'true'
     AND NOT EXISTS (SELECT 1 FROM public.ai_actions a
                      WHERE a.kind = 'followup_message' AND a.followup_id = f.id AND a.round_key = f.attempt::text)
     AND EXISTS (SELECT 1 FROM public.chat_messages mi WHERE mi.chat_wid = ch.wid AND mi.flow = 'in')
     AND (SELECT ml.flow FROM public.chat_messages ml
           WHERE ml.chat_wid = ch.wid AND ml.kind NOT IN ('reaction', 'call_log', 'e2e_notification', 'notification', 'notification_template', 'revoked')
           ORDER BY ml.date DESC LIMIT 1) IS DISTINCT FROM 'in'
     AND NOT EXISTS (SELECT 1 FROM public.chat_messages mr WHERE mr.chat_wid = ch.wid AND mr.date > now() - interval '2 hours')
     AND NOT EXISTS (
       SELECT 1 FROM public.records t
        WHERE t.model_id = m.followups
          AND t.data->>'client_id' = f.client_id::text
          AND COALESCE(NULLIF(t.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
          AND ( t.data->'followup_type' ?| ARRAY['appointment_booking_call', 'no_show_recovery_call']
             OR t.data->>'followup_type' IN ('appointment_booking_call', 'no_show_recovery_call') ))
   ORDER BY f.due DESC
   LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;
REVOKE ALL ON FUNCTION public.ai_followup_candidates(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_followup_candidates(int) TO service_role;

-- ── 8. Drafts whose task moved on are expired, not sent ────────────────────
CREATE OR REPLACE FUNCTION public.ai_actions_expire()
 RETURNS int
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  UPDATE public.ai_actions a
     SET status = 'expired', error = 'the follow-up is no longer open and unsent', updated_at = now()
    FROM public.records r
   WHERE a.status = 'pending' AND a.kind = 'followup_message' AND r.id = a.followup_id
     AND NOT (COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') = 'open'
              AND COALESCE(r.data->>'whatsapp_state', '') = ''
              AND COALESCE(r.data->>'sent_at', '') = '');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.ai_actions_expire() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_actions_expire() TO service_role;

COMMIT;
