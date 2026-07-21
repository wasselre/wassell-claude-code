-- ============================================================================
-- One open WhatsApp task per client (2026-07-21, follow-up to the bridge)
--
-- Discovered live on client هيثم right after the bridge shipped: clients could
-- carry SEVERAL open whatsapp_follow_up rows from the pre-bridge ghost-task
-- era. reconcile_outbound_whatsapp stamps only the NEWEST open WA task, so an
-- older duplicate stayed frozen in 'replied' and kept showing a stale
-- "العميل رد — دورك" card in My Tasks.
--
--  1. reconcile_outbound_whatsapp now CONVERGES: after arming the newest task
--     it cancels any OTHER open WA task for the client
--     (cancel_reason='superseded_by_newer_whatsapp_task').
--  2. One-time cleanup applies the same rule to today's data: keep each
--     client's newest open WA task, cancel the older ones.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_outbound_whatsapp(
  p_client_id  uuid,
  p_message_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  -- Retire stale reach-out tasks AND converge duplicate open WhatsApp tasks —
  -- one client, ONE live WhatsApp thread state (the newest task carries it).
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
$$;

-- ─── One-time cleanup: keep each client's newest open WA task ───────────────
WITH ranked AS (
  SELECT r.id,
         ROW_NUMBER() OVER (PARTITION BY r.data->>'client_id' ORDER BY r.created_at DESC) AS rn
  FROM public.records r
  WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'followups' LIMIT 1)
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND ( (jsonb_typeof(r.data->'followup_type') = 'array' AND r.data->'followup_type' ? 'whatsapp_follow_up')
       OR r.data->>'followup_type' = 'whatsapp_follow_up' )
)
UPDATE public.records r
SET data = (r.data - 'whatsapp_state')
  || jsonb_build_object(
       'followup_status',     'cancelled',
       'cancel_reason',       'superseded_by_newer_whatsapp_task',
       'cancelled_at',        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       'cancelled_by_system', true)
FROM ranked
WHERE r.id = ranked.id AND ranked.rn > 1;
