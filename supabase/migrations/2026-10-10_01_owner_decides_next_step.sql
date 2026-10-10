-- The agent owns the next step (operator, 2026-10-10: "we are using AI but
-- still we are giving the human full ownership").
--
--   after_call    — a PERSON recorded a result that leads to another contact
--                   (interested / no answer / wrong time / call back later): the
--                   agent confirms or changes the next step the process planned.
--   conversation  — the client replied before the planned follow-up: the AI
--                   keeps chatting but no longer closes the follow-up; once the
--                   chat is quiet it proposes a result + next step for the agent.
--   visit_booked  — a visit was booked from the AI's question: shown to the owner.
-- Anything still pending at 21:00 Riyadh is applied as suggested (status
-- auto_applied) by /api/cron/ai-sales-automation; the agent can still change it.
--
-- Everything here is gated by ai_automation_settings.owner_decides_next_step
-- (default OFF; switched on after the app is deployed).

BEGIN;

CREATE TABLE IF NOT EXISTS public.next_step_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL,
  owner_user_id       uuid,
  kind                text NOT NULL CHECK (kind IN ('after_call', 'conversation', 'visit_booked')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided', 'auto_applied', 'dismissed')),
  source_followup_id  uuid,          -- after_call: the follow-up whose result was recorded
  followup_id         uuid,          -- conversation: the follow-up on hold; after_call: the planned next task once found
  suggestion_id       uuid,          -- conversation: chat_outcome_suggestions row
  appointment_id      uuid,          -- visit_booked
  call_result         text,          -- after_call: what the person recorded
  summary             text,
  client_quote        text,
  suggested_result    text,
  suggested_confidence int,
  suggested_next      jsonb,         -- {channel: call|ai_whatsapp|agent_whatsapp, at: iso} or null
  decision            jsonb,
  decided_by          uuid,
  decided_at          timestamptz,
  apply_state         text NOT NULL DEFAULT 'none' CHECK (apply_state IN ('none', 'waiting_task', 'done', 'failed')),
  apply_error         text,
  last_message_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS next_step_reviews_one_conversation
  ON public.next_step_reviews (client_id) WHERE kind = 'conversation' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS next_step_reviews_one_after_call
  ON public.next_step_reviews (source_followup_id) WHERE kind = 'after_call';
CREATE UNIQUE INDEX IF NOT EXISTS next_step_reviews_one_visit
  ON public.next_step_reviews (appointment_id) WHERE kind = 'visit_booked';
CREATE INDEX IF NOT EXISTS next_step_reviews_owner ON public.next_step_reviews (owner_user_id, status);
CREATE INDEX IF NOT EXISTS next_step_reviews_status ON public.next_step_reviews (status, created_at);
CREATE INDEX IF NOT EXISTS next_step_reviews_apply ON public.next_step_reviews (apply_state) WHERE apply_state = 'waiting_task';

-- Read: the owner and admins. Writes go through /api/next-step (service role).
ALTER TABLE public.next_step_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS next_step_reviews_select ON public.next_step_reviews;
CREATE POLICY next_step_reviews_select ON public.next_step_reviews FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid())
         OR owner_user_id IN (SELECT u.id FROM public.users u WHERE u.auth_uid = auth.uid()));
REVOKE ALL ON public.next_step_reviews FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.next_step_reviews FROM authenticated;
GRANT SELECT ON public.next_step_reviews TO authenticated;

ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS owner_decides_next_step boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_quiet_minutes int NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS next_step_default_hour int NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS next_step_default_ran_on date;

-- A person closed a follow-up:
--   · with a result that leads to another contact → an after_call review
--     (unless the close itself was a decision on a review: data.next_step_reviewed);
--   · the client's pending conversation review for that follow-up is settled.
-- Never fails the save — a bookkeeping slip must not lose the agent's result.
CREATE OR REPLACE FUNCTION public.tg_records_next_step_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on      boolean;
  v_client  uuid;
  v_by      uuid;
  v_result  text;
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_followups_model_id() THEN RETURN NEW; END IF;
  IF COALESCE(NEW.data->>'followup_status', '') <> 'completed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.data->>'followup_status', '') = 'completed' THEN RETURN NEW; END IF;

  BEGIN
    SELECT owner_decides_next_step INTO v_on FROM public.ai_automation_settings LIMIT 1;
    IF NOT COALESCE(v_on, false) THEN RETURN NEW; END IF;

    v_client := NULLIF(public._followup_client_id_of(NEW.data), '')::uuid;
    IF v_client IS NULL THEN RETURN NEW; END IF;
    v_by := NULLIF(NEW.data->>'completed_by_user', '')::uuid;
    v_result := NEW.data->>'call_result';

    -- The follow-up a conversation review was holding is closed: settled.
    UPDATE public.next_step_reviews
       SET status = 'decided', decided_by = COALESCE(decided_by, v_by), decided_at = COALESCE(decided_at, now()),
           decision = COALESCE(decision, jsonb_build_object('result', v_result, 'closed_elsewhere', true)),
           updated_at = now()
     WHERE kind = 'conversation' AND status = 'pending' AND followup_id = NEW.id;

    IF v_by IS NOT NULL
       AND v_result IN ('interested', 'no_answer', 'wrong_time', 'recontact_later')
       AND NOT (NEW.data ? 'next_step_reviewed') THEN
      INSERT INTO public.next_step_reviews (client_id, owner_user_id, kind, source_followup_id, call_result)
      VALUES (v_client, v_by, 'after_call', NEW.id, v_result)
      ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'next_step_review: % (followup %)', SQLERRM, NEW.id;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS records_next_step_review ON public.records;
CREATE TRIGGER records_next_step_review AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_next_step_review();

-- The AI's chat readings that still need a card (ready, quiet long enough, no
-- pending card pointing at them yet).
CREATE OR REPLACE FUNCTION public.next_step_conversation_candidates(p_quiet_minutes int, p_limit int DEFAULT 30)
RETURNS SETOF public.chat_outcome_suggestions
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.* FROM public.chat_outcome_suggestions s
   WHERE s.status = 'ready'
     AND s.followup_id IS NOT NULL
     AND s.suggested_outcome IS NOT NULL
     AND s.last_message_at <= now() - make_interval(mins => GREATEST(p_quiet_minutes, 1))
     AND NOT EXISTS (SELECT 1 FROM public.next_step_reviews v
                      WHERE v.status = 'pending' AND v.suggestion_id = s.id)
   ORDER BY s.last_message_at ASC
   LIMIT GREATEST(1, LEAST(p_limit, 100));
$function$;
REVOKE ALL ON FUNCTION public.next_step_conversation_candidates(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_step_conversation_candidates(int, int) TO service_role;

-- The AI follow-up writer: re-emitted verbatim from the live definition
-- (2026-10-07_04) with two additions — tasks the agent writes, and clients on
-- hold for a conversation review.
CREATE OR REPLACE FUNCTION public.ai_followup_candidates(p_limit integer DEFAULT 10, p_campaign boolean DEFAULT NULL::boolean)
 RETURNS TABLE(followup_id uuid, client_id uuid, chat_wid text, chat_record_id uuid, attempt integer, due_at timestamp with time zone, campaign text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH m AS (
    SELECT (SELECT id FROM public.models WHERE name = 'followups' LIMIT 1) AS followups,
           (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1)     AS chats
  ), f AS (
    SELECT r.id,
           (r.data->>'client_id')::uuid AS client_id,
           COALESCE(NULLIF(r.data->>'whatsapp_attempt_number', '')::int, 1) AS attempt,
           public.try_timestamptz(r.data->>'scheduled_datetime') AS due,
           NULLIF(r.data->>'campaign_message', '') AS campaign
      FROM public.records r, m
     WHERE r.model_id = m.followups
       AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') = 'open'
       AND COALESCE(r.data->>'whatsapp_state', '') = ''
       AND COALESCE(r.data->>'sent_at', '') = ''
       AND ( (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ? 'whatsapp_follow_up')
          OR (jsonb_typeof(r.data->'followup_type') = 'string' AND r.data->>'followup_type' = 'whatsapp_follow_up') )
       AND r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.try_timestamptz(r.data->>'scheduled_datetime') <= now()
       -- The agent chose to write this one themselves (next-step decision, 2026-10-10).
       AND COALESCE(r.data->>'writer', '') <> 'agent'
       AND (p_campaign IS NULL
            OR (p_campaign AND COALESCE(r.data->>'campaign_message', '') <> '')
            OR (NOT p_campaign AND COALESCE(r.data->>'campaign_message', '') = ''))
  )
  SELECT f.id, f.client_id, ch.wid, ch.id, f.attempt, f.due, f.campaign
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
   WHERE COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار')
     AND COALESCE(ch.cdata->>'ai_paused', 'false') <> 'true'
     -- On hold while the client's agent decides what happens after a conversation.
     AND NOT EXISTS (SELECT 1 FROM public.next_step_reviews v
                      WHERE v.client_id = f.client_id AND v.kind = 'conversation' AND v.status = 'pending')
     AND NOT EXISTS (SELECT 1 FROM public.ai_actions a
                      WHERE a.kind = 'followup_message' AND a.followup_id = f.id AND a.round_key = f.attempt::text)
     AND EXISTS (SELECT 1 FROM public.chat_messages mi WHERE mi.chat_wid = ch.wid AND mi.flow = 'in')
     AND (f.campaign IS NOT NULL OR
          (SELECT ml.flow FROM public.chat_messages ml
            WHERE ml.chat_wid = ch.wid AND ml.kind NOT IN ('reaction', 'call_log', 'e2e_notification', 'notification', 'notification_template', 'revoked')
            ORDER BY ml.date DESC LIMIT 1) IS DISTINCT FROM 'in')
     AND NOT EXISTS (SELECT 1 FROM public.chat_messages mr WHERE mr.chat_wid = ch.wid AND mr.date > now() - interval '2 hours')
     AND NOT EXISTS (
       SELECT 1 FROM public.chat_messages mo
        WHERE mo.chat_wid = ch.wid AND mo.flow = 'out' AND mo.date > now() - interval '72 hours'
          AND mo.kind NOT IN ('reaction', 'call_log', 'e2e_notification', 'notification', 'notification_template', 'revoked')
          AND NOT EXISTS (SELECT 1 FROM public.chat_messages mi2
                           WHERE mi2.chat_wid = ch.wid AND mi2.flow = 'in' AND mi2.date > mo.date))
     AND NOT EXISTS (
       SELECT 1 FROM public.scheduled_whatsapp_jobs q
        WHERE q.chat_wid = ch.wid AND q.status = 'queued')
     AND (f.campaign IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM public.records t
        WHERE t.model_id = m.followups
          AND t.data->>'client_id' = f.client_id::text
          AND COALESCE(NULLIF(t.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
          AND ( t.data->'followup_type' ?| ARRAY['appointment_booking_call', 'no_show_recovery_call']
             OR t.data->>'followup_type' IN ('appointment_booking_call', 'no_show_recovery_call') )))
     AND (f.campaign IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM public.sales_campaign_leads l
        WHERE l.client_id = f.client_id AND l.status = 'planned'))
   ORDER BY (f.campaign IS NOT NULL) DESC, f.due ASC
   LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;

COMMIT;
