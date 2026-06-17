-- ============================================================================
-- FOLLOWUP_3 — WhatsApp follow-up rework: model fields.
--
-- Adds the 9 fields the send→waiting→response + escalation flow needs to the
-- followups model, and appends a `no_response` option to the call_result
-- dropdown (the auto-outcome the escalation workflow writes).
--
-- State model (see docs/prd/followups-workspace.md): a WhatsApp follow-up's
-- "waiting" state = followup_status='in_progress' + whatsapp_state=
-- 'message_sent_waiting_response'. The escalation deadline is baked into
-- scheduled_datetime at send time; the on_due sweeper fires the escalation
-- workflow, gated on whatsapp_state (a recorded response clears it).
--
-- Self-contained + idempotent: re-introduces minimal add-field helpers (the
-- Phase-1 `_sos_*` helpers were dropped), skips any field/option that already
-- exists, then drops the helpers. Each helper UPDATE fires models_view_sync so
-- v_followups picks up the new columns.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._wa_add_field(p_model text, p_section text, p_field jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE v_schema jsonb; v_name text := p_field->>'name'; s int; exists_already boolean;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE name = p_model;
  IF v_schema IS NULL THEN RAISE EXCEPTION 'model % not found', p_model; END IF;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_schema->'sections') sx,
                  jsonb_array_elements(sx->'fields') fx
    WHERE fx->>'name' = v_name
  ) INTO exists_already;
  IF exists_already THEN RETURN; END IF;
  SELECT idx - 1 INTO s FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY t(val, idx)
    WHERE t.val->>'id' = p_section;
  IF s IS NULL THEN RAISE EXCEPTION 'section % not found in %', p_section, p_model; END IF;
  v_schema := jsonb_set(v_schema, ARRAY['sections', s::text, 'fields'],
                        (v_schema #> ARRAY['sections', s::text, 'fields']) || p_field);
  UPDATE public.models SET schema = v_schema, updated_at = now() WHERE name = p_model;
END $fn$;

CREATE OR REPLACE FUNCTION public._wa_add_option(p_model text, p_field text, p_opt jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE v_schema jsonb; s int; f int; exists_already boolean;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE name = p_model;
  IF v_schema IS NULL THEN RETURN; END IF;
  FOR s IN 0 .. jsonb_array_length(v_schema->'sections') - 1 LOOP
    FOR f IN 0 .. jsonb_array_length(v_schema #> ARRAY['sections', s::text, 'fields']) - 1 LOOP
      IF v_schema #>> ARRAY['sections', s::text, 'fields', f::text, 'name'] = p_field THEN
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            COALESCE(v_schema #> ARRAY['sections', s::text, 'fields', f::text, 'options'], '[]'::jsonb)) o
          WHERE o->>'value' = p_opt->>'value'
        ) INTO exists_already;
        IF exists_already THEN RETURN; END IF;
        v_schema := jsonb_set(v_schema, ARRAY['sections', s::text, 'fields', f::text, 'options'],
          COALESCE(v_schema #> ARRAY['sections', s::text, 'fields', f::text, 'options'], '[]'::jsonb) || p_opt);
        UPDATE public.models SET schema = v_schema, updated_at = now() WHERE name = p_model;
        RETURN;
      END IF;
    END LOOP;
  END LOOP;
END $fn$;

DO $$
DECLARE
  fu     text := '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63';  -- followups (self-lookup target)
  basic  text := '61a5b4c4-4743-4c2b-87e8-99b883adf403';  -- followups Basic Info
  result text := 'adb3a7a4-d266-49cc-8d0b-8a01ced8375c';  -- followups Follow-up Result
BEGIN
  -- whatsapp_state: the send→waiting→response sub-state (system-managed).
  PERFORM public._wa_add_field('followups', basic, jsonb_build_object(
    'id', gen_random_uuid()::text, 'name', 'whatsapp_state', 'label_ar', 'حالة الواتساب', 'label_en', 'WhatsApp State',
    'type', 'dropdown', 'required', false, 'order', 20, 'section_id', basic, 'width', 'half',
    'show_in_table', false, 'read_only', true,
    'options', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'message_sent_waiting_response', 'label_ar', 'بانتظار رد العميل', 'label_en', 'Awaiting Reply', 'color', '#C09B5F'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'no_response_expired', 'label_ar', 'انتهى دون رد', 'label_en', 'No Response', 'color', '#8E4E3A'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'replied', 'label_ar', 'تم الرد', 'label_en', 'Replied', 'color', '#10B981')
    )));

  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'sent_at', 'label_ar', 'وقت إرسال الرسالة', 'label_en', 'Message Sent At', 'type', 'datetime', 'required', false, 'order', 20, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'first_whatsapp_sent_at', 'label_ar', 'أول رسالة واتساب', 'label_en', 'First WhatsApp Sent', 'type', 'datetime', 'required', false, 'order', 21, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'whatsapp_attempt_number', 'label_ar', 'رقم محاولة الواتساب', 'label_en', 'WhatsApp Attempt #', 'type', 'number', 'required', false, 'order', 22, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'escalation_reason', 'label_ar', 'سبب التصعيد', 'label_en', 'Escalation Reason', 'type', 'dropdown', 'required', false, 'order', 23, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true,
    'options', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'whatsapp_no_response_24h', 'label_ar', 'لا رد خلال 24 ساعة', 'label_en', 'No reply in 24h', 'color', '#C09B5F'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'whatsapp_no_response_5d', 'label_ar', 'لا رد خلال 5 أيام', 'label_en', 'No reply in 5 days', 'color', '#8E4E3A'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'call_no_answer_recontact', 'label_ar', 'لم يرد على المكالمة', 'label_en', 'Call no-answer', 'color', '#C09B5F')
    )));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'previous_followup_id', 'label_ar', 'المتابعة السابقة', 'label_en', 'Previous Follow-up', 'type', 'lookup', 'required', false, 'order', 24, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true, 'lookup_model_id', fu, 'lookup_display_field', 'scheduled_datetime'));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'source_followup_id', 'label_ar', 'متابعة المصدر', 'label_en', 'Source Follow-up', 'type', 'lookup', 'required', false, 'order', 25, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true, 'lookup_model_id', fu, 'lookup_display_field', 'scheduled_datetime'));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'sent_by_user', 'label_ar', 'أرسلها', 'label_en', 'Sent By', 'type', 'assignee', 'required', false, 'order', 26, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true, 'assignee_role_ids', '[]'::jsonb));
  PERFORM public._wa_add_field('followups', result, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'whatsapp_template_id', 'label_ar', 'معرّف قالب الواتساب', 'label_en', 'WhatsApp Template', 'type', 'text', 'required', false, 'order', 27, 'section_id', result, 'width', 'half', 'show_in_table', false, 'read_only', true));

  -- The auto-outcome the escalation workflow writes when a waiting WhatsApp expires.
  PERFORM public._wa_add_option('followups', 'call_result', jsonb_build_object('id', gen_random_uuid()::text, 'value', 'no_response', 'label_ar', 'لا يوجد رد', 'label_en', 'No Response', 'color', '#8E4E3A'));
END $$;

DROP FUNCTION public._wa_add_field(text, text, jsonb);
DROP FUNCTION public._wa_add_option(text, text, jsonb);
