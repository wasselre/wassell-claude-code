-- Phase A follow-up — WhatsApp reply reconciliation v2: only a TRUE reply to
-- the rep's check-in marks the task 'replied'.
--
-- v1 (2026-07-04_whatsapp_reply_reconcile.sql) marked ANY open/in_progress
-- whatsapp_follow_up as 'replied' on ANY inbound message from the client —
-- regardless of whether the rep had sent a check-in yet, and regardless of
-- when the message arrived. Real-world failure (2026-07-18): a client message
-- from days BEFORE the scheduled follow-up flipped the fresh task to
-- 'replied', which (a) removed the "بانتظار رد العميل" option from the chat
-- Done popup, and (b) left the task permanently outside the no-response
-- escalation (which only matches whatsapp_state='message_sent_waiting_response'),
-- so a silent client never got the automatic 24h / day-5 escalation.
--
-- v2 semantics — mark 'replied' ONLY when:
--   1. the task is actually awaiting a check-in reply
--      (whatsapp_state = 'message_sent_waiting_response'), AND
--   2. the inbound message arrived at/after the check-in send
--      (p_message_at >= sent_at) — guards against Haberchat re-delivering or
--      backfilling OLD messages after the rep's send.
--
-- The webhook now passes the inbound message's timestamp as p_message_at.
-- It DEFAULTs to now() so the currently-deployed 1-arg webhook call keeps
-- working (and stays correct: the webhook fires at arrival time) until the
-- code deploy lands.
--
-- DROP first: adding a parameter would otherwise create a second overload,
-- and a named-arg call with only p_client_id would become ambiguous.

DROP FUNCTION IF EXISTS public.mark_whatsapp_replied(uuid);

CREATE OR REPLACE FUNCTION public.mark_whatsapp_replied(
  p_client_id  uuid,
  p_message_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model_id uuid;
  v_count    integer;
BEGIN
  IF p_client_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.records r
  SET data = jsonb_set(r.data, '{whatsapp_state}', '"replied"'::jsonb, true)
  WHERE r.model_id = v_model_id
    -- active only: open or in_progress (null/'' legacy status → treated as open)
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    -- WhatsApp follow-up type (followup_type is a JSONB array)
    AND jsonb_typeof(r.data->'followup_type') = 'array'
    AND r.data->'followup_type' ? 'whatsapp_follow_up'
    -- linked to this client (client_id is a scalar string)
    AND r.data->>'client_id' = p_client_id::text
    -- v2 gate 1: only a task that is actually waiting on a check-in reply.
    -- (This also makes the update idempotent — a 'replied' row never matches.)
    AND r.data->>'whatsapp_state' = 'message_sent_waiting_response'
    -- v2 gate 2: the message must postdate the check-in send. A waiting row
    -- with no sent_at (shouldn't happen — both are stamped together) fails
    -- open and is marked replied.
    AND COALESCE(p_message_at, now())
        >= COALESCE(public.try_timestamptz(r.data->>'sent_at'), '-infinity'::timestamptz);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.mark_whatsapp_replied(uuid, timestamptz) IS
  'Phase A v2: mark a client''s WAITING WhatsApp follow-up(s) as replied when an inbound message arrives at/after the check-in send. Called by the Haberchat webhook with the message timestamp.';
