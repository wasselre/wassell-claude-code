-- District shapes for the map-based location picker (2026-07-13).
-- Returns every active district boundary of a city as simplified GeoJSON
-- (tolerance 0.0002 ≈ 20 m, 5-decimal coords) + the district record id/name —
-- one call renders the whole city as tappable polygons (~145 kB for Riyadh's
-- 189 districts). SECURITY DEFINER: boundaries are non-sensitive shared
-- geography; the districts model is readable by all authenticated users anyway.
-- Applied to wassell-prod 2026-07-13 via the Supabase MCP (city_district_shapes_rpc).
create or replace function public.wassell_city_district_shapes(p_city_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '15s'
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'district_id', b.district_record_id,
      'name', coalesce(d.data->>'display_name', d.data->>'name_ar', d.data->>'name_en'),
      'geojson', ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geom, 0.0002), 5)::jsonb
    )
    order by coalesce(d.data->>'display_name', d.data->>'name_ar')
  ), '[]'::jsonb)
  from public.district_boundaries b
  join public.unified_records d on d.id = b.district_record_id
  where b.is_active
    and d.data->>'city_lookup' = p_city_id::text
$$;

revoke all on function public.wassell_city_district_shapes(uuid) from public;
grant execute on function public.wassell_city_district_shapes(uuid) to authenticated;
grant execute on function public.wassell_city_district_shapes(uuid) to service_role;
