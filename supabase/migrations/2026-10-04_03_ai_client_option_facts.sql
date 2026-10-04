-- AI-added client options carry the project's display facts (2026-10-04).
--
-- 2026-10-04_02 created options for projects the AI sent with facts = NULL, so
-- their cards on the client's Options tab read «غير متوفر» for price, area,
-- rooms and location — the card renders ONLY the snapshot in data.facts (the
-- Finder writes one at save time). This copies the same facts from the project
-- record: on create, and on any later mark of an option that still has none.
-- Then the 144 options created by the backfill get theirs.
--
-- No 40001/40P01 anywhere; record_save is the write path as before.

BEGIN;

SET LOCAL check_function_bodies = off;

-- The facts the option card reads, in the Finder's shape. Keys missing on the
-- project are simply absent (never invented). District / city are NAMES, as
-- the Finder stores them.
CREATE OR REPLACE FUNCTION public.client_option_project_facts(p_project uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d jsonb;
  v_district text;
  v_facts jsonb;
BEGIN
  SELECT data INTO d FROM public.records WHERE id = p_project;
  IF d IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(jsonb_object_agg(k, d->k), '{}'::jsonb) INTO v_facts
    FROM unnest(ARRAY[
      'latitude', 'longitude', 'price_range', 'area_range', 'bedroom_range', 'bathroom_range',
      'unit_types', 'unit_count', 'available_units', 'project_type', 'project_status',
      'construction_status', 'preferred_amenities', 'handover_date', 'expected_handover_date'
    ]) AS k
   WHERE d ? k AND d->k <> 'null'::jsonb;

  -- District name: the geography table when present (it is absent in CI), else
  -- the project's own free-text neighbourhood.
  IF to_regclass('public.districts') IS NOT NULL
     AND COALESCE(d->'location'->>'district', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    EXECUTE 'SELECT name_ar FROM public.districts WHERE id = $1'
      INTO v_district USING (d->'location'->>'district')::uuid;
  END IF;
  v_district := COALESCE(NULLIF(v_district, ''), NULLIF(d->>'preferred_neighborhoods', ''), NULLIF(d->>'district', ''));
  IF v_district IS NOT NULL THEN v_facts := v_facts || jsonb_build_object('district', v_district); END IF;

  IF COALESCE(d->>'city_name', d->>'preferred_city', '') <> '' THEN
    v_facts := v_facts || jsonb_build_object('city', COALESCE(NULLIF(d->>'city_name', ''), d->>'preferred_city'));
  END IF;
  IF COALESCE(d->>'main_image', d->>'image_url', '') <> '' THEN
    v_facts := v_facts || jsonb_build_object('image', COALESCE(NULLIF(d->>'main_image', ''), d->>'image_url'));
  END IF;

  RETURN NULLIF(v_facts, '{}'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.client_option_project_facts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_option_project_facts(uuid) TO service_role;

-- The one writer, now with facts (otherwise identical to 2026-10-04_02).
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
  v_facts_missing boolean;
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
      'facts', public.client_option_project_facts(p_project),
      'ai_status_source', p_source, 'ai_status_at', now()), NULL, NULL);
    RETURN 'created:' || p_status;
  END IF;

  v_facts_missing := v_data->'facts' IS NULL OR v_data->'facts' = 'null'::jsonb;
  v_cur := COALESCE(NULLIF(v_data->>'status', ''), 'suitable');
  -- A rep's hard decision is never overridden by the AI.
  IF v_cur IN ('eliminated', 'reserved', 'closed')
     OR (p_status = 'presented' AND v_cur <> 'suitable')
     OR (p_status = 'interested' AND v_cur IN ('interested', 'main_focus'))
     OR (p_status = 'not_interested' AND v_cur = 'not_interested') THEN
    -- Status stays; an option without facts still gets them.
    IF v_facts_missing AND public.client_option_project_facts(p_project) IS NOT NULL THEN
      PERFORM public.record_save(v_model, v_id,
        v_data || jsonb_build_object('facts', public.client_option_project_facts(p_project)), NULL, NULL);
    END IF;
    RETURN 'kept:' || v_cur;
  END IF;

  v_new := v_data || jsonb_build_object('status', p_status, 'ai_status_source', p_source, 'ai_status_at', now());
  IF p_status = 'not_interested' THEN v_new := v_new || jsonb_build_object('is_main', false); END IF;
  IF v_facts_missing THEN v_new := v_new || jsonb_build_object('facts', public.client_option_project_facts(p_project)); END IF;
  PERFORM public.record_save(v_model, v_id, v_new, NULL, NULL);
  RETURN 'updated:' || v_cur || '->' || p_status;
END;
$function$;
REVOKE ALL ON FUNCTION public.client_option_mark(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_option_mark(uuid, uuid, text, text) TO service_role;

-- Backfill: AI-added options that have no facts yet.
DO $backfill$
DECLARE r record; v_facts jsonb;
BEGIN
  FOR r IN
    SELECT o.id, o.model_id, o.data
      FROM public.records o
      JOIN public.models m ON m.id = o.model_id AND m.name = 'client_property_options'
     WHERE o.data->>'added_from' = 'ai'
       AND o.data->>'source_type' = 'project'
       AND (o.data->'facts' IS NULL OR o.data->'facts' = 'null'::jsonb)
  LOOP
    v_facts := public.client_option_project_facts((r.data->>'source_id')::uuid);
    IF v_facts IS NOT NULL THEN
      PERFORM public.record_save(r.model_id, r.id, r.data || jsonb_build_object('facts', v_facts), NULL, NULL);
    END IF;
  END LOOP;
END
$backfill$;

COMMIT;
