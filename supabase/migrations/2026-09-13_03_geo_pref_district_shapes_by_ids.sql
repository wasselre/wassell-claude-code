-- Geo-preference grader: district polygons BY ID.
--
-- The grader's map shows what the AI actually selected for a conversation —
-- the resolved district ids inside a proposal's compiled expression. The
-- existing wassell_city_district_shapes(p_city_id) returns every district of a
-- city (hundreds); this one returns exactly the requested ids, from the same
-- district_boundaries polygons the Finder verifies against. Read-only.
--
-- CI note: PostGIS may be absent on the ephemeral CI database, so the body is
-- not validated at CREATE time there (the function is exercised on prod).
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.wassell_district_shapes_by_ids(p_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15s'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'district_id', b.district_record_id,
      'name', coalesce(d.data->>'display_name', d.data->>'name_ar', d.data->>'name_en'),
      'name_en', coalesce(d.data->>'name_en', d.data->>'name_ar', d.data->>'display_name'),
      'city', coalesce(d.data->>'city_name_ar', d.data->>'city_name_en', ''),
      'city_en', coalesce(d.data->>'city_name_en', d.data->>'city_name_ar', ''),
      'geojson', ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geom, 0.0002), 5)::jsonb
    )
    order by coalesce(d.data->>'display_name', d.data->>'name_ar')
  ), '[]'::jsonb)
  from public.district_boundaries b
  join public.unified_records d on d.id = b.district_record_id
  where b.is_active
    and b.district_record_id = any(p_ids)
$function$;

REVOKE ALL ON FUNCTION public.wassell_district_shapes_by_ids(uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_district_shapes_by_ids(uuid[]) TO authenticated, service_role;
