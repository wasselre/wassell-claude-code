-- wassell_geo_match perf: 7s seq-scan → index-driven (38ms polygon / 1.5s direction).
--
-- The 2026-06-30 statement_timeout bump made the geo gate RELIABLE but it was still a
-- 7.05s full scan of all ~47.6k project+listing points (a per-row wassell_geo_region_contains
-- on each), which made finder loads for location_items clients ~9s. Rewrite it to USE the
-- GiST index (project_points_geom_gix / listing_points_geom_gix):
--   • polygon/buffer items (within_radius / inside_area / district; geom NOT NULL):
--     ST_Contains(i.geom, c.pt) as a spatial JOIN → index nested loop → ~38ms (was ~7s).
--   • direction items (north/south/east/west; geom NULL): the closest-point halfplane
--     (ST_Y(pt) > ST_Y(ST_ClosestPoint(ref,pt))) is NOT a containment, so no index — but
--     pre-filter candidates by the halfplane's bounding envelope via the GiST index (drops
--     the far side: 27,019 of 47,580 for the live "north of King Salman Rd" rule), then
--     apply the EXACT wassell_geo_dir_match (still the source of truth) → ~1.5s (was 7s).
--
-- CORRECTNESS (verified on prod BEFORE the swap, identical record-id sets):
--   • live direction client 1ecd790d: 8046 = 8046, 0 symmetric difference.
--   • synthetic 3 km-radius polygon include (rolled back): 349 = 349, 0 difference.
-- The bbox pre-filter can never drop a true match: the closest point on the road has
-- Y∈[road_minY, road_maxY] (X∈[road_minX, road_maxX]), so any point the halfplane
-- accepts lies inside the corresponding envelope. The exclude semantics + matched_item_ids
-- aggregation are preserved (carry c.pt/c.district_id into inc_hits; one exclude NOT EXISTS).
-- Keeps SECURITY DEFINER + statement_timeout=20s (safety net for unusual geometries).
--
-- FOLLOW-UP: pure-direction rules over a road that spans a wide latitude band keep a
-- ~1.5s scan of the ambiguous strip. Clipping the halfplane to the region polygon at
-- COMPILE time (store a bounded geom) would put them on the index path too (~tens of ms).

create or replace function public.wassell_geo_match(p_client_id uuid)
returns table(record_id uuid, matched_item_ids text[])
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '20s'
as $function$
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
    -- polygon/buffer items: ST_Contains uses the GiST index on candidate points.
    select c.record_id, i.item_id, c.pt, c.district_id
    from inc i
    join cand c on i.geom is not null and ST_Contains(i.geom, c.pt)
    where i.direction is null or public.wassell_geo_dir_match(i.ref_geom, c.pt, i.direction)
    union all
    -- direction-only items (geom null): index bbox pre-filter (drops the far side),
    -- then the exact closest-point halfplane test.
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
    where public.wassell_geo_dir_match(i.ref_geom, c.pt, i.direction)
  )
  select h.record_id, array_agg(distinct h.item_id) as matched_item_ids
  from inc_hits h
  where not exists (
    select 1 from exc e
    where public.wassell_geo_exclude_match(e.geom, e.ref_geom, e.direction, e.district_ids, h.pt, h.district_id)
  )
  group by h.record_id
  -- stable order so the endpoint can PAGE past PostgREST's ~1000-row response cap
  -- (the gate set can be thousands; without paging it was silently truncated to 1000).
  order by h.record_id
$function$;
