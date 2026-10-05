-- Opt-in persistent broker logins. Credentials remain operator-entered data.
-- No inventory writes, brake overrides or scheduling are enabled here.
BEGIN;

DO $migration$
DECLARE v_schema jsonb; v_index int; v_section jsonb; v_fields jsonb; v_field jsonb;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE name = 'lead_portals' FOR UPDATE;
  IF v_schema IS NULL THEN RETURN; END IF;
  SELECT (ord - 1)::int, sec INTO v_index, v_section
    FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY AS x(sec, ord)
    ORDER BY (sec->>'label_en' = 'Sign-in & automation') DESC, ord DESC LIMIT 1;
  v_fields := COALESCE(v_section->'fields', '[]'::jsonb);
  FOR v_field IN SELECT value FROM jsonb_array_elements('[
    {"name":"login_id","type":"text","label_ar":"معرّف الدخول","label_en":"Login ID"},
    {"name":"browserbase_persist_context","type":"checkbox","label_ar":"حفظ جلسة الدخول","label_en":"Keep the portal signed in","default_value":false},
    {"name":"browserbase_context_id","type":"text","label_ar":"معرّف جلسة المتصفح المحفوظة","label_en":"Browserbase context ID","read_only":true},
    {"name":"browserbase_authenticated_at","type":"datetime","label_ar":"بداية جلسة الدخول","label_en":"Login established at","read_only":true},
    {"name":"browserbase_last_authenticated_at","type":"datetime","label_ar":"آخر تحقق من الدخول","label_en":"Last authenticated check","read_only":true},
    {"name":"browserbase_session_reused_at","type":"datetime","label_ar":"آخر إعادة استخدام للجلسة","label_en":"Last login reuse","read_only":true},
    {"name":"browserbase_login_survived_s","type":"number","label_ar":"مدة بقاء الدخول بالثواني","label_en":"Observed login lifetime (seconds)","read_only":true},
    {"name":"inventory_capture_enabled","type":"checkbox","label_ar":"حفظ مخزون الوحدات يومياً","label_en":"Capture unit inventory daily","default_value":false}
  ]'::jsonb)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_schema->'sections') s,
      jsonb_array_elements(s->'fields') f WHERE f->>'name' = v_field->>'name') THEN
      v_fields := v_fields || jsonb_build_array(v_field || jsonb_build_object(
        'id', gen_random_uuid()::text, 'section_id', v_section->>'id',
        'order', jsonb_array_length(v_fields), 'required', false, 'width', 'half', 'show_in_table', false));
    END IF;
  END LOOP;
  UPDATE public.models SET schema = jsonb_set(v_schema, ARRAY['sections', v_index::text, 'fields'], v_fields)
    WHERE name = 'lead_portals';
END $migration$;

-- A claim is a very short transaction. Serializing the selection closes the
-- NOT EXISTS / SKIP LOCKED race between the five worker machines and prevents
-- concurrent sessions from overwriting the same persisted browser context.
CREATE OR REPLACE FUNCTION public.portal_registration_job_claim_next(p_worker_id text)
RETURNS SETOF public.portal_registration_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT pg_try_advisory_xact_lock(913015, 1) THEN RETURN; END IF;
  RETURN QUERY UPDATE public.portal_registration_jobs j
    SET status = 'running', attempts = j.attempts + 1, worker_id = p_worker_id,
        started_at = now(), heartbeat_at = now(), updated_at = now()
    WHERE j.id = (
      SELECT q.id FROM public.portal_registration_jobs q
      WHERE q.status = 'queued' AND q.parked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.portal_registration_jobs l
          WHERE l.status IN ('running', 'awaiting_input')
            AND (l.portal_record_id = q.portal_record_id OR (
              public.portal_signin_phone_digits(q.portal_record_id) IS NOT NULL
              AND public.portal_signin_phone_digits(l.portal_record_id)
                = public.portal_signin_phone_digits(q.portal_record_id))))
      ORDER BY q.created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING j.*;
END $function$;

CREATE OR REPLACE FUNCTION public.portal_browserbase_context_set(p_portal_record_id uuid, p_context_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_data jsonb; v_context text;
BEGIN
  IF NULLIF(btrim(p_context_id), '') IS NULL THEN
    RAISE EXCEPTION 'Browserbase context ID is required' USING ERRCODE = 'WS422';
  END IF;
  SELECT data INTO v_data FROM public.records
    WHERE id = p_portal_record_id AND model_id = '1ead0000-0000-4000-8000-000000000001' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portal not found' USING ERRCODE = 'WS404'; END IF;
  IF COALESCE(v_data->>'browserbase_persist_context', 'false') <> 'true' THEN
    RAISE EXCEPTION 'Persistent context is not enabled for this portal' USING ERRCODE = 'WS422';
  END IF;
  v_context := NULLIF(v_data->>'browserbase_context_id', '');
  IF v_context IS NULL THEN
    v_context := p_context_id;
    UPDATE public.records SET data = jsonb_set(data, '{browserbase_context_id}', to_jsonb(v_context))
      WHERE id = p_portal_record_id;
  END IF;
  RETURN v_context;
END $function$;

CREATE OR REPLACE FUNCTION public.portal_browserbase_auth_state(p_portal_record_id uuid, p_reused boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_data jsonb; v_state jsonb; v_established timestamptz;
BEGIN
  SELECT data INTO v_data FROM public.records
    WHERE id = p_portal_record_id AND model_id = '1ead0000-0000-4000-8000-000000000001' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portal not found' USING ERRCODE = 'WS404'; END IF;
  IF COALESCE(v_data->>'browserbase_persist_context', 'false') <> 'true' THEN
    RAISE EXCEPTION 'Persistent context is not enabled for this portal' USING ERRCODE = 'WS422';
  END IF;
  v_established := NULLIF(v_data->>'browserbase_authenticated_at', '')::timestamptz;
  v_state := jsonb_build_object('browserbase_last_authenticated_at', now());
  IF p_reused AND v_established IS NOT NULL THEN
    v_state := v_state || jsonb_build_object('browserbase_session_reused_at', now(),
      'browserbase_login_survived_s', greatest(0, floor(extract(epoch FROM now() - v_established))));
  ELSE
    v_state := v_state || jsonb_build_object('browserbase_authenticated_at', now(),
      'browserbase_login_survived_s', 0);
  END IF;
  UPDATE public.records SET data = data || v_state WHERE id = p_portal_record_id;
  RETURN v_state;
END $function$;

REVOKE ALL ON FUNCTION public.portal_registration_job_claim_next(text),
  public.portal_browserbase_context_set(uuid,text), public.portal_browserbase_auth_state(uuid,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_claim_next(text),
  public.portal_browserbase_context_set(uuid,text), public.portal_browserbase_auth_state(uuid,boolean)
  TO service_role;
COMMIT;
