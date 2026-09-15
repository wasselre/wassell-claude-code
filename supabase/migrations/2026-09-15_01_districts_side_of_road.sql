-- Geo-preference: districts CLIPPED to one side of a road.
--
-- «فيلا بالمعذر الشمالي أو المحمدية أو العليا (غرب الملك فهد)» means the parts
-- of those districts that lie WEST of King Fahd Road — not the districts plus a
-- fixed-depth band along the whole road (what the generic side-of-road rule
-- drew, 2026-09-15). For each district: split its boundary by the road, keep the
-- pieces whose centroid is on the requested side, and return them as GeoJSON so
-- the proposal can carry a custom drawn shape. A district the road does not
-- cross is kept whole when it lies on that side and dropped (reported with
-- kept=false) when it lies on the other side.
--
-- Side test: west/east compare longitude, north/south compare latitude, of a
-- piece's centroid against the road's closest point to it. Good for the long
-- radial/ring roads customers name; a road that doubles back on itself is
-- NOT a valid side reference and this function does not try to be clever
-- about it (diagonals are refused → NULL → caller falls back).
--
-- CI note: PostGIS may be absent on the ephemeral CI database.
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.wassell_districts_side_of_road(
  p_district_ids uuid[],
  p_road_external_id text,
  p_side text
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '20s'
AS $function$
  with road as (
    select ST_LineMerge(ST_Force2D(g.geom)) as geom
    from public.geo_elements g
    where g.external_id = p_road_external_id and g.is_active
    limit 1
  ),
  d as (
    select b.district_record_id as district_id,
           coalesce(u.data->>'display_name', u.data->>'name_ar', u.data->>'name_en') as name,
           coalesce(u.data->>'name_en', u.data->>'name_ar', u.data->>'display_name') as name_en,
           ST_MakeValid(ST_Force2D(b.geom)) as geom
    from public.district_boundaries b
    join public.unified_records u on u.id = b.district_record_id
    where b.is_active and b.district_record_id = any(p_district_ids)
  ),
  pieces as (
    select d.district_id, d.name, d.name_en, d.geom as whole,
           ST_Intersects(d.geom, road.geom) as crossed,
           (ST_Dump(case when ST_Intersects(d.geom, road.geom) then ST_Split(d.geom, road.geom) else d.geom end)).geom as piece
    from d, road
  ),
  sided as (
    select p.*,
      case p_side
        when 'west'  then ST_X(ST_Centroid(p.piece)) < ST_X(ST_ClosestPoint(road.geom, ST_Centroid(p.piece)))
        when 'east'  then ST_X(ST_Centroid(p.piece)) > ST_X(ST_ClosestPoint(road.geom, ST_Centroid(p.piece)))
        when 'north' then ST_Y(ST_Centroid(p.piece)) > ST_Y(ST_ClosestPoint(road.geom, ST_Centroid(p.piece)))
        when 'south' then ST_Y(ST_Centroid(p.piece)) < ST_Y(ST_ClosestPoint(road.geom, ST_Centroid(p.piece)))
        else null
      end as on_side
    from pieces p, road
  ),
  per_district as (
    select district_id, name, name_en, bool_or(crossed) as crossed,
           ST_Multi(ST_Union(piece) filter (where on_side)) as kept_geom,
           round((ST_Area(ST_Union(piece) filter (where on_side)::geography) / 1e6)::numeric, 2) as kept_km2,
           round((ST_Area(min(whole)::geography) / 1e6)::numeric, 2) as total_km2
    from sided
    group by district_id, name, name_en
  )
  select case when (select count(*) from road) = 0 or p_side not in ('west','east','north','south') then null
         else coalesce(jsonb_agg(jsonb_build_object(
           'district_id', district_id,
           'name', name,
           'name_en', name_en,
           'crossed', crossed,
           'kept', kept_geom is not null,
           'kept_km2', kept_km2,
           'total_km2', total_km2,
           'geojson', case when kept_geom is not null
                           then ST_AsGeoJSON(ST_SimplifyPreserveTopology(kept_geom, 0.0002), 5)::jsonb end
         ) order by name), '[]'::jsonb) end
  from per_district
$function$;

REVOKE ALL ON FUNCTION public.wassell_districts_side_of_road(uuid[], text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_districts_side_of_road(uuid[], text, text) TO authenticated, service_role;
