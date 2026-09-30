-- 1. A visit closes only the appointment it actually fulfils.
--
-- tg_records_visit_completes_appointment matched the client's NEAREST open
-- appointment within ±3 days, whatever its project and even when it was still
-- in the future. Live 2026-09-30: recording "visited صفا 78 yesterday" marked
-- tomorrow's صفا 82 appointment completed. Re-emitted from the live definition
-- with two added conditions:
--   * the appointment is not more than 24 h AFTER the visit (a visit cannot
--     fulfil an appointment that has not come yet; the 3-day look-BACK stays);
--   * when both name a project, it is the same project. A visit points at
--     our_projects, an appointment at all_projects — compared through the
--     our_projects row's `project` link.
--
-- 2. record_assign_auto_id_system — the next auto-id for a server-side writer.
-- record_assign_auto_id gates on the CALLER's create permission (auth.uid()),
-- which a service-role writer (the WhatsApp sales agent booking a visit) does
-- not have, so its appointments had no «م ع###» number. Same counter row, same
-- self-heal against the highest id in use; service role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_records_visit_completes_appointment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_visits uuid;
  v_appts  uuid;
  v_client text;
  v_visit_at timestamptz;
  v_match uuid;
  v_visit_project text;
BEGIN
  SELECT id INTO v_visits FROM models WHERE name = 'visits' LIMIT 1;
  IF NEW.model_id IS DISTINCT FROM v_visits THEN RETURN NEW; END IF;

  v_client := NULLIF(NEW.data->>'client_id', '');
  IF v_client IS NULL OR v_client !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;

  SELECT id INTO v_appts FROM models WHERE name = 'appointments' LIMIT 1;
  IF v_appts IS NULL THEN RETURN NEW; END IF;

  v_visit_at := COALESCE(
    public.try_timestamptz(NEW.data->>'scheduled_datetime'),
    now());

  -- The visit's project as an all_projects id (visits point at our_projects).
  IF NULLIF(NEW.data->>'project_id', '') ~* '^[0-9a-f-]{36}$' THEN
    SELECT NULLIF(o.data->>'project', '') INTO v_visit_project
      FROM records o WHERE o.id = (NEW.data->>'project_id')::uuid;
  END IF;

  SELECT a.id INTO v_match
  FROM records a
  WHERE a.model_id = v_appts
    AND a.data->>'client_id' = v_client
    AND COALESCE(NULLIF(a.data->>'appointment_status', ''), 'scheduled')
        IN ('scheduled', 'confirmed', 'rescheduled')
    AND public.try_timestamptz(a.data->>'appointment_date') IS NOT NULL
    AND abs(extract(epoch FROM (public.try_timestamptz(a.data->>'appointment_date') - v_visit_at))) <= 259200
    AND public.try_timestamptz(a.data->>'appointment_date') <= v_visit_at + interval '24 hours'
    AND (v_visit_project IS NULL
         OR NULLIF(a.data->>'project_id', '') IS NULL
         OR a.data->>'project_id' = v_visit_project)
  ORDER BY abs(extract(epoch FROM (public.try_timestamptz(a.data->>'appointment_date') - v_visit_at))) ASC
  LIMIT 1;

  IF v_match IS NULL THEN RETURN NEW; END IF;

  UPDATE records
  SET data = data || jsonb_build_object(
        'appointment_status', 'completed',
        'completed_by_visit_id', NEW.id::text)
  WHERE id = v_match;

  NEW.data := NEW.data || jsonb_build_object('appointment_id', v_match::text);

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_assign_auto_id_system(p_model_name text, p_field_name text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_model  uuid;
  v_field  jsonb;
  v_value  int;
  v_max    bigint;
BEGIN
  SELECT m.id, f INTO v_model, v_field
  FROM public.models m
  CROSS JOIN LATERAL jsonb_array_elements(m.schema->'sections') s
  CROSS JOIN LATERAL jsonb_array_elements(s->'fields') f
  WHERE m.name = p_model_name AND f->>'name' = p_field_name AND f->>'type' = 'auto_id'
  LIMIT 1;
  IF v_model IS NULL THEN
    RAISE EXCEPTION 'record_assign_auto_id_system: no auto_id field %.%', p_model_name, p_field_name;
  END IF;

  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (v_model, (v_field->>'id')::uuid, '__global__', GREATEST(COALESCE((v_field->>'auto_id_start_value')::int, 1), 1))
  ON CONFLICT (model_id, field_id, scope_key)
  DO UPDATE SET current_value = public.auto_id_counters.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_value;

  -- Never at or below an id already in use (same self-heal as record_assign_auto_id).
  SELECT MAX(NULLIF(regexp_replace(ur.data->>p_field_name, '\D', '', 'g'), '')::bigint)
    INTO v_max
  FROM public.unified_records ur
  WHERE ur.model_id = v_model;
  IF v_max IS NOT NULL AND v_max >= v_value THEN
    v_value := (v_max + 1)::int;
    UPDATE public.auto_id_counters
       SET current_value = v_value, updated_at = now()
     WHERE model_id = v_model AND field_id = (v_field->>'id')::uuid AND scope_key = '__global__';
  END IF;

  RETURN COALESCE(v_field->>'auto_id_prefix', '')
      || lpad(v_value::text, GREATEST(COALESCE((v_field->>'auto_id_padding')::int, 0), length(v_value::text)), '0');
END;
$function$;

REVOKE ALL ON FUNCTION public.record_assign_auto_id_system(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id_system(text, text) TO service_role;

COMMIT;
