-- Early-message indicator — restores the "client messaged us before the
-- check-in" surfacing that reply-reconciliation v2 removed, WITHOUT the false
-- 'replied' state.
--
-- v2 (2026-07-18_whatsapp_reply_waiting_gate.sql) made 'replied' mean "a real
-- reply to the rep's check-in" (waiting state + message after sent_at). Correct,
-- but it dropped v1's side-benefit: a client who replies to the on-call project
-- message BEFORE any check-in used to surface the task early in the queue.
--
-- v3 adds a separate, honest signal: an inbound message while the task is
-- still FRESH (no whatsapp_state) stamps `client_messaged_at` on the task.
-- The SPA surfaces such tasks in Due Now / My Tasks (like replied) and shows
-- a "client messaged" banner in the Workspace — while the rep KEEPS the full
-- fresh-phase choice screen, including "بانتظار رد العميل".
--
-- Also adds the read-only `client_messaged_at` datetime field to the followups
-- model schema so the value is visible in the generic form / views / PRDs.

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
  v_msg_at   timestamptz := COALESCE(p_message_at, now());
  v_count    integer;
BEGIN
  IF p_client_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN
    RETURN 0;
  END IF;

  -- 1. True reply to a check-in → mark 'replied' (v2 semantics, unchanged):
  --    the task must be WAITING and the message must postdate the send.
  UPDATE public.records r
  SET data = jsonb_set(r.data, '{whatsapp_state}', '"replied"'::jsonb, true)
  WHERE r.model_id = v_model_id
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND jsonb_typeof(r.data->'followup_type') = 'array'
    AND r.data->'followup_type' ? 'whatsapp_follow_up'
    AND r.data->>'client_id' = p_client_id::text
    AND r.data->>'whatsapp_state' = 'message_sent_waiting_response'
    AND v_msg_at >= COALESCE(public.try_timestamptz(r.data->>'sent_at'), '-infinity'::timestamptz);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 2. Early message on a FRESH task (no check-in sent yet) → NOT a reply;
  --    stamp client_messaged_at so the queue surfaces the task now while the
  --    rep keeps the full choice screen. Only advances (never rewinds), so
  --    webhook retries / re-deliveries of older messages are no-ops.
  UPDATE public.records r
  SET data = jsonb_set(r.data, '{client_messaged_at}', to_jsonb(v_msg_at), true)
  WHERE r.model_id = v_model_id
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND jsonb_typeof(r.data->'followup_type') = 'array'
    AND r.data->'followup_type' ? 'whatsapp_follow_up'
    AND r.data->>'client_id' = p_client_id::text
    AND COALESCE(r.data->>'whatsapp_state', '') = ''
    AND COALESCE(public.try_timestamptz(r.data->>'client_messaged_at'), '-infinity'::timestamptz) < v_msg_at;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.mark_whatsapp_replied(uuid, timestamptz) IS
  'Phase A v3: inbound client message → WAITING task + message after sent_at ⇒ replied; FRESH task (no check-in) ⇒ stamp client_messaged_at (early-surface indicator). Called by the Haberchat webhook with the message timestamp.';

-- ── Schema: read-only client_messaged_at datetime on followups ──────────────
-- Same helper pattern as 2026-06-17_whatsapp_followup_fields.sql. Idempotent.

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

DO $$
DECLARE
  result text := 'adb3a7a4-d266-49cc-8d0b-8a01ced8375c';  -- followups "Follow-up Result" section
BEGIN
  PERFORM public._wa_add_field('followups', result, jsonb_build_object(
    'id', gen_random_uuid()::text, 'name', 'client_messaged_at',
    'label_ar', 'رسالة العميل قبل التواصل', 'label_en', 'Client Messaged At',
    'type', 'datetime', 'required', false, 'order', 28, 'section_id', result,
    'width', 'half', 'show_in_table', false, 'read_only', true));
END $$;

DROP FUNCTION public._wa_add_field(text, text, jsonb);
