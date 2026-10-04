-- The AI sets the client's MAIN project when it records a positive follow-up
-- result (interested / appointment booked / wants an offer) — the server twin
-- of the rep's «اعتمد كمشروع رئيسي» (setMainOption in
-- src/lib/matching/clientOptions.ts). Rules:
--   · only when the client has NO main project yet — a main the rep (or an
--     earlier reading) chose is never replaced;
--   · never on an option a rep eliminated / reserved / closed;
--   · the option is created first if missing (through client_option_mark).
-- Writes through record_save like every other option write. No 40001/40P01.

BEGIN;

CREATE OR REPLACE FUNCTION public.client_option_set_main_ai(p_client uuid, p_project uuid, p_source text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_model uuid;
  v_id uuid;
  v_data jsonb;
  v_cur text;
BEGIN
  IF p_client IS NULL OR p_project IS NULL THEN RETURN 'skipped:missing_ids'; END IF;
  SELECT id INTO v_model FROM public.models WHERE name = 'client_property_options' LIMIT 1;
  IF v_model IS NULL THEN RETURN 'skipped:no_model'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('client_option_main:' || p_client::text));

  IF EXISTS (SELECT 1 FROM public.records r
              WHERE r.model_id = v_model AND r.data->>'client_id' = p_client::text
                AND (r.data->>'is_main' = 'true' OR r.data->>'status' = 'main_focus')) THEN
    RETURN 'kept:has_main';
  END IF;

  PERFORM public.client_option_mark(p_client, p_project, 'interested', p_source);

  SELECT r.id, r.data INTO v_id, v_data
    FROM public.records r
   WHERE r.model_id = v_model
     AND r.data->>'client_id' = p_client::text
     AND r.data->>'source_type' = 'project'
     AND r.data->>'source_id' = p_project::text
   ORDER BY r.created_at LIMIT 1;
  IF v_id IS NULL THEN RETURN 'skipped:no_option'; END IF;

  v_cur := COALESCE(NULLIF(v_data->>'status', ''), 'suitable');
  IF v_cur IN ('eliminated', 'reserved', 'closed', 'not_interested') THEN RETURN 'kept:' || v_cur; END IF;

  PERFORM public.record_save(v_model, v_id, v_data || jsonb_build_object(
    'is_main', true, 'status', 'main_focus', 'ai_status_source', p_source, 'ai_status_at', now()), NULL, NULL);
  RETURN 'set_main';
END;
$function$;

REVOKE ALL ON FUNCTION public.client_option_set_main_ai(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_option_set_main_ai(uuid, uuid, text) TO service_role;

COMMIT;
