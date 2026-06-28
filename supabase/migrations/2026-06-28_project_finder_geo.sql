-- Project Finder — geography verification (PostGIS point-in-polygon)
-- ============================================================================
-- The Project Finder's "exact district match" must be COORDINATE/BOUNDARY
-- verified, never a blind trust of the stored `location.district` id. The source
-- of truth for a project's real district is its (lat,lng) point inside a
-- `district_boundaries` polygon. This migration adds:
--
--   1. district_for_point(lat,lng)      — single-point containment resolver.
--   2. districts_for_points(jsonb)      — bulk resolver the matching engine calls
--                                         once per request with all candidate pins.
--   3. v_all_projects_geo_integrity     — per-project audit view (status enum +
--                                         geo_confidence) used as a report AND to
--                                         protect matching from false exacts.
--   4. project_geo_integrity_summary()  — quick grouped counts for the report.
--
-- All read-only & additive. district_boundaries already has a GiST index on geom
-- (3,732 active SRID-4326 polygons), so containment lookups are fast.
-- ============================================================================

-- 1. Single-point district resolver. Returns the active district polygon that
--    CONTAINS the point (the authoritative district), or no rows when the point
--    is outside every known boundary / coords are null.
create or replace function public.district_for_point(
  p_lat double precision,
  p_lng double precision
)
returns table(
  district_record_id uuid,
  spl_district_id text,
  city_id text,
  region_id text
)
language sql
stable
parallel safe
as $$
  select b.district_record_id, b.spl_district_id, b.city_id, b.region_id
  from public.district_boundaries b
  where b.is_active
    and p_lat is not null
    and p_lng is not null
    and ST_Contains(b.geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
  limit 1
$$;

-- 2. Bulk resolver. Input is a JSON array of {id, lat, lng}; output is one row
--    per input id with the containing district (or NULL district when the point
--    is outside all polygons / has no coords). Keyed by `id` (not array index) so
--    the engine maps results back to projects without order fragility.
create or replace function public.districts_for_points(p_points jsonb)
returns table(
  id text,
  district_record_id uuid,
  spl_district_id text,
  city_id text,
  region_id text
)
language sql
stable
parallel safe
as $$
  select
    pt.id,
    d.district_record_id,
    d.spl_district_id,
    d.city_id,
    d.region_id
  from jsonb_to_recordset(coalesce(p_points, '[]'::jsonb))
       as pt(id text, lat double precision, lng double precision)
  left join lateral (
    select b.district_record_id, b.spl_district_id, b.city_id, b.region_id
    from public.district_boundaries b
    where b.is_active
      and pt.lat is not null
      and pt.lng is not null
      and ST_Contains(b.geom, ST_SetSRID(ST_MakePoint(pt.lng, pt.lat), 4326))
    limit 1
  ) d on true
$$;

grant execute on function public.district_for_point(double precision, double precision)
  to anon, authenticated, service_role;
grant execute on function public.districts_for_points(jsonb)
  to anon, authenticated, service_role;

-- 3. Geo-integrity audit view for all_projects. Computes, per project:
--    * stored vs polygon-derived district, and a status enum:
--        verified_match        — coords inside a polygon that EQUALS the stored district.
--        verified_derived      — coords inside a polygon; stored district was empty (derive it).
--        mismatch              — coords inside a polygon that DIFFERS from the stored district
--                                (the false-exact risk: do NOT trust the stored district).
--        outside_known_districts — has coords but the point is outside every active polygon.
--        unverified_no_coords  — no coords, but a stored district exists (match at lower confidence).
--        no_geography          — neither coords nor stored district.
--    * geo_confidence: high (polygon-verified) / medium (stored-only, no coords) / low (everything else).
--    security_invoker so the report respects the caller's RLS on `records`.
--    KEEP THIS STATUS/CONFIDENCE LOGIC SEMANTICALLY IDENTICAL to the TS engine
--    classifier in api/_lib/geoVerify.ts (classifyGeo) — two impls of one recipe.
create or replace view public.v_all_projects_geo_integrity
with (security_invoker = true) as
with ap as (
  select
    r.id,
    r.data->>'project_name' as project_name,
    nullif(r.data->>'latitude','')::double precision  as lat,
    nullif(r.data->>'longitude','')::double precision as lng,
    nullif(r.data->'location'->>'district','') as stored_district_id,
    nullif(r.data->'location'->>'city','')     as stored_city_id,
    nullif(r.data->>'geo_source','')           as geo_source
  from public.records r
  join public.models m on m.id = r.model_id
  where m.name = 'all_projects'
)
select
  ap.id,
  ap.project_name,
  ap.lat,
  ap.lng,
  ap.stored_district_id,
  ap.stored_city_id,
  ap.geo_source,
  poly.district_record_id::text as polygon_district_id,
  poly.city_id                  as polygon_city_id,
  case
    when ap.lat is null or ap.lng is null then
      case when ap.stored_district_id is not null then 'unverified_no_coords' else 'no_geography' end
    when poly.district_record_id is null then 'outside_known_districts'
    when ap.stored_district_id is null then 'verified_derived'
    when ap.stored_district_id = poly.district_record_id::text then 'verified_match'
    else 'mismatch'
  end as geo_status,
  case
    when ap.lat is not null and ap.lng is not null and poly.district_record_id is not null
         and (ap.stored_district_id is null or ap.stored_district_id = poly.district_record_id::text)
      then 'high'
    when (ap.lat is null or ap.lng is null) and ap.stored_district_id is not null
      then 'medium'
    else 'low'
  end as geo_confidence
from ap
left join lateral (
  select b.district_record_id, b.city_id
  from public.district_boundaries b
  where b.is_active
    and ap.lat is not null and ap.lng is not null
    and ST_Contains(b.geom, ST_SetSRID(ST_MakePoint(ap.lng, ap.lat), 4326))
  limit 1
) poly on true;

grant select on public.v_all_projects_geo_integrity to authenticated, service_role;

-- 4. Grouped counts for the audit report.
create or replace function public.project_geo_integrity_summary()
returns table(geo_status text, geo_confidence text, n bigint)
language sql
stable
security invoker
as $$
  select geo_status, geo_confidence, count(*)::bigint as n
  from public.v_all_projects_geo_integrity
  group by geo_status, geo_confidence
  order by n desc
$$;

grant execute on function public.project_geo_integrity_summary() to authenticated, service_role;
