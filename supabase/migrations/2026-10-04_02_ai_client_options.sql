-- AI keeps the client's project options up to date (operator, 2026-10-04):
--   · every project the AI sends a client is added to the client's options
--     ('presented', added_from 'ai');
--   · when the client's messages show they want / don't want a project, the
--     outcome agent sets that option to 'interested' / 'not_interested'.
-- The option card shows the client's link interest in it (the UI joins
-- v_project_interest), so the degree of interest sits next to the status.
--
-- client_option_mark(client, project, status, source) is the ONE writer. It
-- never overrides a rep's hard decision (eliminated / reserved / closed), never
-- demotes main_focus on an "interested" reading, and writes through record_save
-- (the normal records path). An advisory lock per (client, project) keeps two
-- simultaneous marks from creating two options for the same project.
--
-- The send trigger on chat_message_projects must never fail the insert: it
-- catches and RAISE WARNINGs. No 40001/40P01 anywhere.

BEGIN;

-- 1. A fourth "added from" value: the AI.
UPDATE public.models m
   SET schema = jsonb_set(m.schema, '{sections}', (
     SELECT jsonb_agg(
       jsonb_set(sec, '{fields}', (
         SELECT jsonb_agg(
           CASE WHEN f->>'name' = 'added_from'
                 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f->'options') o WHERE o->>'value' = 'ai')
                THEN jsonb_set(f, '{options}', (f->'options') || jsonb_build_object(
                       'id', gen_random_uuid()::text, 'value', 'ai',
                       'label_ar', 'المساعد الذكي', 'label_en', 'AI assistant', 'color', '#C09B5F'))
                ELSE f END
           ORDER BY ord)
         FROM jsonb_array_elements(sec->'fields') WITH ORDINALITY AS t(f, ord)))
       ORDER BY sord)
     FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS s(sec, sord)))
 WHERE m.name = 'client_property_options';

-- 2. The one writer.
CREATE OR REPLACE FUNCTION public.client_option_mark(p_client uuid, p_project uuid, p_status text, p_source text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_model uuid;
  v_projects uuid;
  v_id uuid;
  v_data jsonb;
  v_cur text;
  v_name text;
  v_new jsonb;
BEGIN
  IF p_client IS NULL OR p_project IS NULL THEN RETURN 'skipped:missing_ids'; END IF;
  IF p_status NOT IN ('presented', 'interested', 'not_interested') THEN RETURN 'skipped:bad_status'; END IF;
  SELECT id INTO v_model FROM public.models WHERE name = 'client_property_options' LIMIT 1;
  SELECT id INTO v_projects FROM public.models WHERE name = 'all_projects' LIMIT 1;
  IF v_model IS NULL THEN RETURN 'skipped:no_model'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE id = p_client) THEN RETURN 'skipped:no_client'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('client_option:' || p_client::text || ':' || p_project::text));

  SELECT r.id, r.data INTO v_id, v_data
    FROM public.records r
   WHERE r.model_id = v_model
     AND r.data->>'client_id' = p_client::text
     AND r.data->>'source_type' = 'project'
     AND r.data->>'source_id' = p_project::text
   ORDER BY r.created_at
   LIMIT 1;

  IF v_id IS NULL THEN
    SELECT COALESCE(NULLIF(data->>'project_name', ''), data->>'name') INTO v_name
      FROM public.records WHERE id = p_project AND (v_projects IS NULL OR model_id = v_projects);
    IF v_name IS NULL THEN RETURN 'skipped:no_project'; END IF;
    PERFORM public.record_save(v_model, gen_random_uuid(), jsonb_build_object(
      'client_id', p_client::text, 'source_type', 'project', 'source_id', p_project::text,
      'source_name', v_name, 'status', p_status, 'is_main', false,
      'match_score', NULL, 'match_run_id', NULL, 'priority_rank', NULL,
      'added_from', 'ai', 'added_by', NULL, 'sales_notes', '', 'elimination_notes', '',
      'facts', NULL, 'ai_status_source', p_source, 'ai_status_at', now()), NULL, NULL);
    RETURN 'created:' || p_status;
  END IF;

  v_cur := COALESCE(NULLIF(v_data->>'status', ''), 'suitable');
  -- A rep's hard decision is never overridden by the AI.
  IF v_cur IN ('eliminated', 'reserved', 'closed') THEN RETURN 'kept:' || v_cur; END IF;
  IF p_status = 'presented' AND v_cur <> 'suitable' THEN RETURN 'kept:' || v_cur; END IF;
  IF p_status = 'interested' AND v_cur IN ('interested', 'main_focus') THEN RETURN 'kept:' || v_cur; END IF;
  IF p_status = 'not_interested' AND v_cur = 'not_interested' THEN RETURN 'kept:' || v_cur; END IF;

  v_new := v_data || jsonb_build_object('status', p_status, 'ai_status_source', p_source, 'ai_status_at', now());
  IF p_status = 'not_interested' THEN v_new := v_new || jsonb_build_object('is_main', false); END IF;
  PERFORM public.record_save(v_model, v_id, v_new, NULL, NULL);
  RETURN 'updated:' || v_cur || '->' || p_status;
END;
$function$;
REVOKE ALL ON FUNCTION public.client_option_mark(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_option_mark(uuid, uuid, text, text) TO service_role;

-- 3. Every project the AI sends lands in the client's options.
CREATE OR REPLACE FUNCTION public.tg_chat_message_projects_ai_option()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_src text; v_ref text; v_conv uuid; v_link text; v_client uuid;
BEGIN
  BEGIN
    SELECT send_source, reference, conversation_record_id INTO v_src, v_ref, v_conv
      FROM public.chat_messages WHERE id = NEW.message_wid;
    IF COALESCE(v_src, '') <> 'ai' AND COALESCE(v_ref, '') NOT LIKE 'ai%' THEN RETURN NEW; END IF;
    SELECT data->>'client_link' INTO v_link FROM public.records WHERE id = v_conv;
    IF v_link ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_client := v_link::uuid;
    ELSE v_client := public.find_client_id_by_phone('+' || split_part(NEW.chat_wid, '@', 1));
    END IF;
    IF v_client IS NOT NULL THEN PERFORM public.client_option_mark(v_client, NEW.project_id, 'presented', 'ai_send'); END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_chat_message_projects_ai_option: % → %', NEW.message_wid, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS chat_message_projects_ai_option ON public.chat_message_projects;
CREATE TRIGGER chat_message_projects_ai_option
  AFTER INSERT ON public.chat_message_projects
  FOR EACH ROW EXECUTE FUNCTION public.tg_chat_message_projects_ai_option();

COMMIT;
