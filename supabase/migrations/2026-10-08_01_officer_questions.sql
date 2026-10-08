-- Questions to a project's OFFICER become tracked tasks (operator, 2026-10-08).
--
-- Incident: a customer asked to visit «ربوة الرمز» on Friday "if someone is
-- there". The agent booked the visit at once, told him three times «بتأكد لك
-- وأرد عليك», and drafted a question to the officer that waited 7 hours for
-- approval, went out in a batch, was read and never answered. Nobody owned it,
-- nobody chased it, and the customer never heard back.
--
-- A question to an officer is now a `wa_agent_questions` row like a question to
-- the rep, so it gets the same owner (the client's rep), the same answer box in
-- My Tasks and the same relay to the customer. What this adds:
--   * asked_to          'rep' (as before) | 'officer'
--   * officer_*         who was asked and the EXACT fixed-wording message sent
--   * officer_action_id the ai_actions row that logs the message (the client's
--                       Portals tab lists every officer message from ai_actions)
--   * visit_*           a visit check: the visit the customer wants. It is booked
--                       only when the rep records the officer's confirmation.
--   * due_at / reminded_at / escalated_at / day_before_alerted_at
--                       the deadline chain the automation cron walks.
--
-- Backward compatible: every new column is nullable or defaulted, existing rows
-- read as asked_to='rep', and the deployed code ignores the new columns.

ALTER TABLE public.wa_agent_questions
  ADD COLUMN IF NOT EXISTS asked_to text NOT NULL DEFAULT 'rep',
  ADD COLUMN IF NOT EXISTS officer_id uuid,
  ADD COLUMN IF NOT EXISTS officer_name text,
  ADD COLUMN IF NOT EXISTS officer_phone text,
  ADD COLUMN IF NOT EXISTS officer_message text,
  ADD COLUMN IF NOT EXISTS officer_action_id uuid,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS day_before_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS visit_day date,
  ADD COLUMN IF NOT EXISTS visit_slot text,
  ADD COLUMN IF NOT EXISTS visit_time text,
  ADD COLUMN IF NOT EXISTS visit_confirmed boolean,
  ADD COLUMN IF NOT EXISTS booked_appointment_id uuid;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_agent_questions_asked_to_check') THEN
    ALTER TABLE public.wa_agent_questions
      ADD CONSTRAINT wa_agent_questions_asked_to_check CHECK (asked_to IN ('rep', 'officer'));
  END IF;
END $c$;

-- The cron's deadline sweep: open officer questions / visit checks by due time.
CREATE INDEX IF NOT EXISTS wa_agent_questions_due_idx
  ON public.wa_agent_questions (due_at) WHERE status = 'open' AND due_at IS NOT NULL;
-- The Portals tab joins a logged officer message to its question.
CREATE INDEX IF NOT EXISTS wa_agent_questions_officer_action_idx
  ON public.wa_agent_questions (officer_action_id) WHERE officer_action_id IS NOT NULL;
-- The Portals tab lists a client's officer messages.
CREATE INDEX IF NOT EXISTS ai_actions_officer_client_idx
  ON public.ai_actions (client_id, created_at DESC) WHERE kind = 'officer_notice';

-- A rep writing to the customer answers a question the CUSTOMER asked — never a
-- question waiting on the officer, and never a visit check (that one closes only
-- with an explicit confirm / not-possible, which is what books the visit).
-- Re-emitted from the live definition with ONE change: the two extra predicates.
CREATE OR REPLACE FUNCTION public.tg_wa_agent_questions_close_on_rep_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.wa_agent_questions
     SET status = 'answered_directly', answered_at = COALESCE(NEW.date, now())
   WHERE chat_wid = NEW.chat_wid AND status = 'open' AND created_at <= COALESCE(NEW.date, now())
     AND asked_to = 'rep' AND visit_day IS NULL;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'wa_agent_questions close failed for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $function$;
