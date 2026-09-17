-- Project Finder — "closest point of the selected area to the project" distance.
--
-- WHY: until now the finder's out-of-area distance_km was a haversine to the
-- selected area's CENTRE point (district centroid / drawn-area centroid /
-- landmark point) — see api/_lib/matchAgent.ts. A project 1 km outside a
-- district's edge read as its (much larger) distance to the district centre.
-- The rep wants the honest boundary distance: how far the project is from the
-- CLOSEST point of the wanted area, not its middle.
--
-- This RPC takes the candidate project points + a description of the selected
-- geographical area (its pieces) and returns, per point, the minimum surface
-- distance (km) to the UNION of those pieces (0 when the point is inside any of
-- them) plus the name of the nearest piece (for the "~X km from Y" label).
--
-- The area "pieces" are given explicitly so the RPC works for both a
-- client-gated search and pure discovery (a district picker with no client):
--   {"name": "...", "kind": "district", "district_id": "<records.id>"}
--       -> the district's polygon in public.district_boundaries
--   {"name": "...", "kind": "polygon",  "geojson": {"type":"Polygon",...}}
--       -> a hand-drawn area (closed GeoJSON ring, [lng,lat] order)
--   {"name": "...", "kind": "element",  "external_id": "...", "buffer_m": 5000}
--       -> a geo_elements landmark/road/zone, optionally buffered by buffer_m
--          metres (a "within X km of Y" rule -> a disk; buffer_m 0 -> the geom)
--
-- SECURITY DEFINER so it reads district_boundaries / geo_elements regardless of
-- the caller's RLS (it returns only public geography distances, never row data).
-- Additive + backward-compatible: nothing calls it until the engine does, and
-- the engine keeps its centroid haversine as a fallback when this returns nothing.

-- check_function_bodies OFF so the CI ephemeral DB (no PostGIS, no geo tables)
-- can still create the function (same posture as the other geo RPCs).
SET check_function_bodies = off;

create or replace function public.wassell_area_point_distances(
  p_points jsonb,
  p_pieces jsonb
)
returns table (id text, distance_km double precision, nearest_name text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with points as (
    select
      (p->>'id')::text as id,
      ST_SetSRID(
        ST_MakePoint(
          public.try_numeric(p->>'lng')::double precision,
          public.try_numeric(p->>'lat')::double precision
        ), 4326
      )::geography as g
    from jsonb_array_elements(coalesce(p_points, '[]'::jsonb)) as p
    where public.try_numeric(p->>'lat') is not null
      and public.try_numeric(p->>'lng') is not null
  ),
  pieces as (
    -- Selected district polygons.
    select nullif(pc->>'name','') as name, b.geom::geography as g
    from jsonb_array_elements(coalesce(p_pieces, '[]'::jsonb)) as pc
    join public.district_boundaries b
      on pc->>'kind' = 'district'
     and b.district_record_id = (pc->>'district_id')::uuid
    union all
    -- Hand-drawn areas (closed GeoJSON ring).
    select nullif(pc->>'name','') as name,
           ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(pc->'geojson'), 4326))::geography as g
    from jsonb_array_elements(coalesce(p_pieces, '[]'::jsonb)) as pc
    where pc->>'kind' = 'polygon' and pc ? 'geojson'
    union all
    -- Landmark / road / zone elements, optionally buffered into a disk/band.
    select nullif(pc->>'name','') as name,
           case
             when coalesce(public.try_numeric(pc->>'buffer_m'), 0) > 0
               then ST_Buffer(e.geom::geography, public.try_numeric(pc->>'buffer_m')::double precision)
             else e.geom::geography
           end as g
    from jsonb_array_elements(coalesce(p_pieces, '[]'::jsonb)) as pc
    join public.geo_elements e
      on pc->>'kind' = 'element'
     and e.external_id = pc->>'external_id'
  )
  select
    pt.id,
    (min(ST_Distance(pc.g, pt.g)) / 1000.0)::double precision as distance_km,
    (array_agg(pc.name order by ST_Distance(pc.g, pt.g) asc))[1] as nearest_name
  from points pt
  cross join pieces pc
  where pc.g is not null and not ST_IsEmpty(pc.g::geometry)
  group by pt.id;
$$;

grant execute on function public.wassell_area_point_distances(jsonb, jsonb) to authenticated, service_role;

comment on function public.wassell_area_point_distances(jsonb, jsonb) is
  'Project Finder: min surface distance (km) from each candidate point to the closest point of the selected area (district polygons + drawn areas + buffered elements), with the nearest piece name. Replaces the centroid haversine for out-of-area distance.';
