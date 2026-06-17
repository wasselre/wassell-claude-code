-- ============================================================================
-- FOLLOWUP_3 leg C — escalation-call no-answer re-enters the WhatsApp sequence.
--
-- Prepends ONE leading branch to the live "Follow-ups - Booking Call" workflow
-- (W2, id d997425a-0c8d-48c4-afef-b5792792cfae): when a booking call that was
-- itself created by the day-5 WhatsApp escalation (escalation_reason =
-- 'whatsapp_no_response_5d') is completed with call_result='no_answer', create
-- a fresh WhatsApp follow-up due +1d (re-entering the loop). Branches are
-- first-match-wins, so this leading branch handles ONLY escalation-calls; a
-- normal booking-call no_answer (no escalation_reason) fails this branch's
-- escalation_reason condition and falls through to W2's generic no_answer
-- branch unchanged.
--
-- Idempotent: re-running is a no-op if the leading branch already exists.
-- Backs up the pre-edit workflow row first.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public._backup_w2_bookingcall_20260617 AS
  SELECT * FROM public.workflows WHERE id = 'd997425a-0c8d-48c4-afef-b5792792cfae';

DO $$
DECLARE
  fu text := '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63';
  w2 text := 'd997425a-0c8d-48c4-afef-b5792792cfae';
  already boolean;
  lead jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.workflows w, jsonb_array_elements(w.branches) b
    WHERE w.id = w2 AND b->>'label_en' = 'Escalation Call No-Answer -> WhatsApp'
  ) INTO already;
  IF already THEN RAISE NOTICE 'W2 leg-C branch already present — skip'; RETURN; END IF;

  lead := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'label_en', 'Escalation Call No-Answer -> WhatsApp',
    'label_ar', 'مكالمة التصعيد بلا رد ← واتساب',
    'condition_mode', 'all',
    'conditions', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'value', jsonb_build_array('appointment_booking_call'), 'field_id', 'followup_type', 'operator', 'equals'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'whatsapp_no_response_5d', 'field_id', 'escalation_reason', 'operator', 'equals'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', '', 'field_id', 'actual_datetime', 'operator', 'is_not_empty'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'no_answer', 'field_id', 'call_result', 'operator', 'equals', 'only_on_change', true)
    ),
    'actions', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'type', 'create_record', 'skip_if_exists', false, 'target_model_id', fu,
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'static_value', '', 'target_field_id', 'client_id', 'trigger_field_id', 'client_id'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', jsonb_build_array('whatsapp_follow_up'), 'target_field_id', 'followup_type', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'date_expression', 'static_value', '', 'date_expression', '+1d', 'date_base', 'current_date', 'target_field_id', 'scheduled_datetime', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 'open', 'target_field_id', 'followup_status', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 1, 'target_field_id', 'whatsapp_attempt_number', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 'call_no_answer_recontact', 'target_field_id', 'escalation_reason', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'static_value', '', 'target_field_id', 'sales_rep', 'trigger_field_id', 'sales_rep'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'record_id', 'static_value', '', 'target_field_id', 'previous_followup_id', 'trigger_field_id', '')
        ))
    )
  );
  UPDATE public.workflows SET branches = jsonb_build_array(lead) || branches WHERE id = w2;
END $$;
