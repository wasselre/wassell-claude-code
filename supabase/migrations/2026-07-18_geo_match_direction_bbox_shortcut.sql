-- Direction-rule geo match: EXACT-SEMANTICS bbox shortcut (2026-07-18).
-- The closest point on the reference line always lies within the line's bbox,
-- so a candidate BEYOND the bbox on the requested side is definitely a match —
-- no per-point ST_ClosestPoint needed. Only candidates within the ref's
-- lat/lng band run the exact test. Cuts "south of King Salman Rd" over a
-- 42k-point candidate set from ~7.7s to ~5s (combined with the compile-time
-- ref simplification; the original per-point evaluation was 11.8s).

CREATE OR REPLACE FUNCTION public.wassell_geo_match(p_client_id uuid)
RETURNS TABLE(record_id uuid, matched_item_ids text[])
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '20s'
AS $function$
  with inc as (
    select item_id, geom, ref_geom, direction, district_ids
    from public.client_pref_geometry
    where client_id = p_client_id and polarity = 'include' and validation_status = 'ok'
  ),
  exc as (
    select geom, ref_geom, direction, district_ids
    from public.client_pref_geometry
    where client_id = p_client_id and polarity = 'exclude' and validation_status = 'ok'
  ),
  cand as (
    select record_id, geom as pt, district_id from public.project_points where is_active
    union all
    select record_id, geom, district_id from public.listing_points where is_active
  ),
  inc_hits as (
    select c.record_id, i.item_id, c.pt, c.district_id
    from inc i
    join cand c on i.geom is not null and ST_Contains(i.geom, c.pt)
    where i.direction is null or public.wassell_geo_dir_match(i.ref_geom, c.pt, i.direction)
    union all
    select c.record_id, i.item_id, c.pt, c.district_id
    from inc i
    join cand c on i.geom is null and i.direction is not null
      and c.pt && case i.direction
        when 'north' then ST_MakeEnvelope(-180, ST_YMin(i.ref_geom), 180, 90, 4326)
        when 'south' then ST_MakeEnvelope(-180, -90, 180, ST_YMax(i.ref_geom), 4326)
        when 'east'  then ST_MakeEnvelope(ST_XMin(i.ref_geom), -90, 180, 90, 4326)
        when 'west'  then ST_MakeEnvelope(-180, -90, ST_XMax(i.ref_geom), 90, 4326)
        else ST_MakeEnvelope(-180, -90, 180, 90, 4326)
      end
    where (case i.direction
             when 'north' then ST_Y(c.pt) > ST_YMax(i.ref_geom)
             when 'south' then ST_Y(c.pt) < ST_YMin(i.ref_geom)
             when 'east'  then ST_X(c.pt) > ST_XMax(i.ref_geom)
             when 'west'  then ST_X(c.pt) < ST_XMin(i.ref_geom)
             else false
           end)
       or public.wassell_geo_dir_match(i.ref_geom, c.pt, i.direction)
  )
  select h.record_id, array_agg(distinct h.item_id) as matched_item_ids
  from inc_hits h
  where not exists (
    select 1 from exc e
    where public.wassell_geo_exclude_match(e.geom, e.ref_geom, e.direction, e.district_ids, h.pt, h.district_id)
  )
  group by h.record_id
  order by h.record_id
$function$;
