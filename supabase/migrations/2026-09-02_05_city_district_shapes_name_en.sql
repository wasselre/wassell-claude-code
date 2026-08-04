-- ════════════════════════════════════════════════════════════════════════════
-- W6 (bilingual): wassell_city_district_shapes returns the English district name
-- alongside the Arabic one, so the DistrictMapPicker map can label districts in
-- the UI language. Additive — the existing `name` (Arabic-first) is unchanged,
-- so every current reader keeps working; `name_en` is new and optional.
--
-- The cross-city suffix (" — <city>") is built with the English city name in
-- name_en and the Arabic one in name (each already localized on its own side).
--
-- check_function_bodies is disabled for this statement so the CI ephemeral DB
-- (which has neither PostGIS nor district_boundaries/city_metro_groups — the
-- bootstrap fixture only stubs the translation tables) can CREATE the function
-- without validating its body. Prod has every dependency; the body runs there.
-- ════════════════════════════════════════════════════════════════════════════

SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.wassell_city_district_shapes(p_city_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15s'
AS $function$
  with member_cities as (
    select p_city_id::text as cid
    union
    select member_city_id::text from public.city_metro_groups where parent_city_id = p_city_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'district_id', b.district_record_id,
      'name',
        coalesce(d.data->>'display_name', d.data->>'name_ar', d.data->>'name_en')
        || case when d.data->>'city_lookup' <> p_city_id::text
                then ' — ' || coalesce(d.data->>'city_name_ar', d.data->>'city_name_en', '')
                else '' end,
      'name_en',
        coalesce(d.data->>'name_en', d.data->>'name_ar', d.data->>'display_name')
        || case when d.data->>'city_lookup' <> p_city_id::text
                then ' — ' || coalesce(d.data->>'city_name_en', d.data->>'city_name_ar', '')
                else '' end,
      'geojson', ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geom, 0.0002), 5)::jsonb
    )
    order by coalesce(d.data->>'display_name', d.data->>'name_ar')
  ), '[]'::jsonb)
  from public.district_boundaries b
  join public.unified_records d on d.id = b.district_record_id
  where b.is_active
    and d.data->>'city_lookup' in (select cid from member_cities)
$function$;
