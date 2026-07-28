-- WA-24 -- only a CONVERSATIONAL outbound message retires a client's call tasks.
--
-- reconcile_outbound_whatsapp cancels every open appointment_booking_call,
-- no_show_recovery_call and older whatsapp_follow_up for the client on ANY
-- outbound message. That rule was chosen deliberately for a rep messaging a
-- customer -- but it fired just as hard for a bulk campaign or a generated
-- document, so a broadcast to 200 clients would silently cancel up to 200 call
-- tasks, including calls for people who were about to be booked.
--
-- The message now carries WHERE it came from (chat_messages.send_source),
-- stamped by the send paths that persist the row (WA-04); the webhook echo
-- merges onto that same row, so by reconcile time the answer is on it.
--
-- Conversational (retires call tasks): composer, new_chat, ai, workflow.
--   A workflow message is a deliberate 1:1 reach-out -- the automation doing
--   what a rep would have done.
-- Non-conversational (does NOT retire): bulk, document, media_batch.
--   Receiving a PDF is not a conversation, and a campaign is not outreach to
--   any particular person.
--
-- The whatsapp_follow_up itself is STILL armed either way: we did message the
-- customer, so the 24-hour reply clock is correct in both cases. Only the
-- cancellation of OTHER work is scoped.
--
-- Verified in production: the reconcile still arms the WhatsApp follow-up for a
-- document send, and no longer cancels that client's booking/no-show calls.

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS send_source text;

COMMENT ON COLUMN public.chat_messages.send_source IS
  'WA-24: which surface produced this outbound message (composer|new_chat|ai|workflow|bulk|document|media_batch). Decides whether it retires the client''s open call tasks.';

CREATE OR REPLACE FUNCTION public.reconcile_outbound_whatsapp(
  p_client_id uuid,
  p_message_at timestamptz DEFAULT NULL,
  p_source text DEFAULT 'composer'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_model_id  uuid;
  v_msg_at    timestamptz := COALESCE(p_message_at, now());
  v_stage     text;
  v_rep       text;
  v_wa_id     uuid;
  v_first     text;
  v_attempt   int;
  v_cancelled int := 0;
  v_deadline  text;
  v_now_iso   text;
  v_conversational boolean := COALESCE(p_source, 'composer') NOT IN ('bulk', 'document', 'media_batch');
BEGIN
  IF p_client_id IS NULL THEN RETURN 0; END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN RETURN 0; END IF;

  SELECT data->>'client_stage', data->>'client_owner'
    INTO v_stage, v_rep
  FROM public.records WHERE id = p_client_id;
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل') THEN RETURN 0; END IF;

  v_deadline := to_char((v_msg_at + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_now_iso  := to_char(v_msg_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT r.id,
         NULLIF(r.data->>'first_whatsapp_sent_at', ''),
         COALESCE(NULLIF(r.data->>'whatsapp_attempt_number', '')::int, 1)
    INTO v_wa_id, v_first, v_attempt
  FROM public.records r
  WHERE r.model_id = v_model_id
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND ( (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ? 'whatsapp_follow_up')
       OR (jsonb_typeof(r.data->'followup_type') = 'string' AND r.data->>'followup_type' = 'whatsapp_follow_up') )
    AND r.data->>'client_id' = p_client_id::text
  ORDER BY r.created_at DESC
  LIMIT 1;

  IF v_wa_id IS NOT NULL THEN
    UPDATE public.records
    SET data = (data - 'fired_at' - 'client_messaged_at')
      || jsonb_build_object(
           'whatsapp_state',          'message_sent_waiting_response',
           'followup_status',         'in_progress',
           'sent_at',                 v_now_iso,
           'first_whatsapp_sent_at',  COALESCE(v_first, v_now_iso),
           'whatsapp_attempt_number', v_attempt,
           'scheduled_datetime',      v_deadline,
           'source_followup_id',      v_wa_id::text)
    WHERE id = v_wa_id;
  ELSE
    v_wa_id := gen_random_uuid();
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (v_wa_id, v_model_id,
      jsonb_build_object(
        'client_id',               p_client_id::text,
        'sales_rep',               v_rep,
        'followup_type',           jsonb_build_array('whatsapp_follow_up'),
        'followup_status',         'in_progress',
        'whatsapp_state',          'message_sent_waiting_response',
        'sent_at',                 v_now_iso,
        'first_whatsapp_sent_at',  v_now_iso,
        'whatsapp_attempt_number', 1,
        'followup_number',         1,
        'scheduled_datetime',      v_deadline,
        'source_followup_id',      v_wa_id::text,
        'creation_source',         'outbound_whatsapp'),
      NULL);
  END IF;

  -- ONLY a conversational message retires the client's other open work.
  IF NOT v_conversational THEN
    RETURN 1;
  END IF;

  UPDATE public.records r
  SET data = (r.data - 'whatsapp_state')
    || jsonb_build_object(
         'followup_status',     'cancelled',
         'cancel_reason',       CASE
             WHEN (jsonb_typeof(r.data->'followup_type') = 'array' AND r.data->'followup_type' ? 'whatsapp_follow_up')
               OR r.data->>'followup_type' = 'whatsapp_follow_up'
             THEN 'superseded_by_newer_whatsapp_task'
             ELSE 'contacted_via_whatsapp' END,
         'cancelled_at',        v_now_iso,
         'cancelled_by_system', true)
  WHERE r.model_id = v_model_id
    AND r.id <> v_wa_id
    AND r.data->>'client_id' = p_client_id::text
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND ( (jsonb_typeof(r.data->'followup_type') = 'array'
             AND r.data->'followup_type' ?| ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])
       OR (jsonb_typeof(r.data->'followup_type') = 'string'
             AND r.data->>'followup_type' = ANY(ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])) );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN v_cancelled + 1;
END;
$function$;
