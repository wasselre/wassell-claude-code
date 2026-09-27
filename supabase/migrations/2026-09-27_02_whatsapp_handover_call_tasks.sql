-- ============================================================================
-- Outbound WhatsApp HANDS OVER a call task instead of dropping it.
--
-- Before: a rep's conversational WhatsApp cancelled the client's open booking
-- call / no-show recovery call with cancel_reason 'contacted_via_whatsapp' and
-- nothing else — 274 booking calls in 30 days vanished that way, and nothing on
-- the WhatsApp task said a call plan had ever existed (a no-show recovery lost
-- its appointment link for good, since the dedup trigger forbids a second one).
--
-- After: the same cancellation, plus a two-way link.
--   cancelled task  → handed_to_followup_id = the WhatsApp task
--   WhatsApp task   → handed_over_from_id / handed_over_from_type = the newest
--                     call task it replaced; appointment_id copied across when
--                     the WhatsApp task has none; previous_followup_id filled
--                     when empty.
-- The chat task bar shows "picked up from: booking call", and the outcome the
-- rep (or the AI suggestion) records on the WhatsApp task is now the recorded
-- result of that contact.
--
-- Re-emitted VERBATIM from the live definition (pg_get_functiondef,
-- 2026-09-27) with ONLY the handover additions marked «handover». cancel_reason
-- values are unchanged so existing reporting keeps counting the same way.
-- Signature unchanged → CREATE OR REPLACE keeps grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_outbound_whatsapp(p_client_id uuid, p_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_source text DEFAULT 'composer'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  -- «handover»
  v_from_id   text;
  v_from_type text;
  v_from_appt text;
BEGIN
  IF p_client_id IS NULL THEN RETURN 0; END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN RETURN 0; END IF;

  SELECT data->>'client_stage', data->>'client_owner'
    INTO v_stage, v_rep
  FROM public.records WHERE id = p_client_id;
  v_rep := COALESCE(NULLIF(v_rep, ''), public.wassell_default_sales_rep()::text);  -- auto-assign default rep
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب') THEN RETURN 0; END IF;

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

  IF NOT v_conversational THEN
    RETURN 1;
  END IF;

  WITH cancelled AS (
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
           'cancelled_by_system', true,
           'handed_to_followup_id', v_wa_id::text)                           -- «handover»
    WHERE r.model_id = v_model_id
      AND r.id <> v_wa_id
      AND r.data->>'client_id' = p_client_id::text
      AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
      AND ( (jsonb_typeof(r.data->'followup_type') = 'array'
               AND r.data->'followup_type' ?| ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])
         OR (jsonb_typeof(r.data->'followup_type') = 'string'
               AND r.data->>'followup_type' = ANY(ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])) )
    RETURNING r.id, r.created_at,
              COALESCE(r.data->'followup_type'->>0, r.data->>'followup_type') AS ftype,
              NULLIF(r.data->>'appointment_id', '') AS appt
  )
  SELECT count(*)::int,
         (array_agg(c.id::text ORDER BY c.created_at DESC) FILTER (WHERE c.ftype <> 'whatsapp_follow_up'))[1],
         (array_agg(c.ftype    ORDER BY c.created_at DESC) FILTER (WHERE c.ftype <> 'whatsapp_follow_up'))[1],
         (array_agg(c.appt     ORDER BY c.created_at DESC) FILTER (WHERE c.ftype <> 'whatsapp_follow_up' AND c.appt IS NOT NULL))[1]
    INTO v_cancelled, v_from_id, v_from_type, v_from_appt
  FROM cancelled c;

  -- «handover» — the WhatsApp task records which call task it took over.
  IF v_from_id IS NOT NULL THEN
    UPDATE public.records w
    SET data = w.data
      || jsonb_build_object('handed_over_from_id', v_from_id, 'handed_over_from_type', v_from_type)
      || CASE WHEN NULLIF(w.data->>'previous_followup_id', '') IS NULL
              THEN jsonb_build_object('previous_followup_id', v_from_id) ELSE '{}'::jsonb END
      || CASE WHEN v_from_appt IS NOT NULL AND NULLIF(w.data->>'appointment_id', '') IS NULL
              THEN jsonb_build_object('appointment_id', v_from_appt) ELSE '{}'::jsonb END
    WHERE w.id = v_wa_id;
  END IF;

  RETURN v_cancelled + 1;
END;
$function$;
