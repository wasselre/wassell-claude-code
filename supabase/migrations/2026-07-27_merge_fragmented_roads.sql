-- ============================================================================
-- Merge fragmented + duplicated road records in geo_elements
-- ============================================================================
-- APPLIED LIVE to wassell-prod on 2026-07-27 (as the numbered steps below —
-- run as separate statements, see "Statement timeout" note at the bottom).
--
-- Reported from live use: the same road is stored as MANY rows — sometimes
-- disjoint halves of one road, sometimes overlapping duplicates. Effects:
--   • the picker's road search listed the same road 6-8 times
--   • picking one drew only PART of the road
--   • "area between roads" built its hull from a fragment → wrong polygon
--   • within_distance / direction rules only matched against the fragment
--
-- Measured (Riyadh is the only city with roads):
--   197 road rows -> 123 distinct roads; 74 rows retired.
--   «طريق الثمامة»     8 rows, pure fragmentation (34.8 km -> 55.4 km merged)
--   «الدائري الشمالي»  8 rows across ring_roads + roads_major; the row a client
--                      rule pointed at held just 10.3 km of a 51.4 km road.
--   Whole network: 3347.1 km before == 3347.1 km after (nothing lost, only
--   duplication dissolved and fragments stitched).
--
-- STRATEGY — merge, never delete:
--   1. Group by a canonical name key: lowercase, unify أإآ→ا / ى→ي / ة→ه, strip
--      tashkeel+tatweel, drop the type words (طريق/شارع), strip the ال article
--      from every token. Suffixes are PRESERVED, so «... الفرعي» service roads
--      stay their own road (verified: all 13 grouped alone).
--   2. One survivor per group. Rows referenced by a client's saved
--      location_items rules win outright — client rules store
--      geo_elements.external_id, so that id MUST keep resolving. Otherwise the
--      longest geometry wins, external_id as a deterministic tie-break.
--   3. Survivor's geom := ST_Union of the group — stitches disjoint fragments
--      AND dissolves overlapping duplicates in one operation.
--   4. Losers are DEACTIVATED, never deleted: the geo_element_aliases FK stays
--      valid, any rule still pointing at one can resolve geometry, and the whole
--      change is reversible from the backup table.
--
-- Backup: public._backup_geo_elements_roads_20260727 (all 197 pre-merge rows).
-- To reverse: restore geom/is_active/is_searchable/notes/raw from that table.
--
-- VERIFIED after applying:
--   • all 38 survivors ST_Equals the union of their group's ORIGINAL geometry
--   • 0 duplicate groups remain among active+searchable roads
--   • total network km identical before/after
--   • RUH-RING-0853 (client-referenced) still active, same external_id, now 51.4 km
-- ============================================================================

-- Step 1 — full backup before touching anything.
CREATE TABLE IF NOT EXISTS public._backup_geo_elements_roads_20260727 AS
SELECT * FROM public.geo_elements
WHERE element_type IN ('roads_major', 'ring_roads', 'metro_lines');

-- Step 2a — external_ids referenced by client rules, computed ONCE.
-- (Doing this as a correlated subquery inside the window function below scans
--  records once per road row and blows the statement timeout.)
CREATE TABLE IF NOT EXISTS public._road_merge_referenced AS
SELECT DISTINCT c->>'element_id' AS ext_id
FROM public.records r
CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.data->'location_items', '[]'::jsonb)) li
CROSS JOIN LATERAL jsonb_array_elements(coalesce(li->'conditions', '[]'::jsonb)) c
WHERE li->>'kind' = 'element_rule' AND c->>'element_id' IS NOT NULL;

-- Step 2b — the merge plan: which row survives each group.
CREATE TABLE IF NOT EXISTS public._road_merge_plan AS
WITH norm AS (
  SELECT id, external_id, geom,
    trim(regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(translate(lower(coalesce(name_ar, '')), 'أإآىة', 'ااايه'), '[ًٌٍَُِّْـ]', '', 'g'),
    '(ال)?(طريق|شارع)', ' ', 'g'), '\mال', '', 'g'), '\s+', ' ', 'g')) AS canon
  FROM public.geo_elements
  WHERE element_type IN ('roads_major', 'ring_roads', 'metro_lines')
    AND is_active AND coalesce(review_status, '') <> 'rejected'
),
ranked AS (
  SELECT n.*,
    count(*) OVER (PARTITION BY canon) AS grp_size,
    row_number() OVER (
      PARTITION BY canon
      ORDER BY (n.external_id IN (SELECT ext_id FROM public._road_merge_referenced)) DESC,
               ST_Length(n.geom::geography) DESC,
               n.external_id
    ) AS rn
  FROM norm n
)
SELECT id, external_id, canon, rn, grp_size,
       first_value(id)          OVER (PARTITION BY canon ORDER BY rn) AS survivor_id,
       first_value(external_id) OVER (PARTITION BY canon ORDER BY rn) AS survivor_ext
FROM ranked
WHERE grp_size > 1;

-- Step 3 — survivor absorbs the whole group's geometry.
WITH merged AS (
  SELECT m.survivor_id, ST_Multi(ST_Union(g.geom)) AS geom, count(*) AS merged_from
  FROM public._road_merge_plan m
  JOIN public.geo_elements g ON g.id = m.id
  GROUP BY m.survivor_id
)
UPDATE public.geo_elements g
SET geom          = merged.geom,
    geom_kind     = 'linestring',
    -- representative point must lie ON the road, not at the bbox centre
    longitude     = ST_X(ST_ClosestPoint(merged.geom, ST_Centroid(merged.geom))),
    latitude      = ST_Y(ST_ClosestPoint(merged.geom, ST_Centroid(merged.geom))),
    centroid_geog = ST_ClosestPoint(merged.geom, ST_Centroid(merged.geom))::geography,
    notes         = concat_ws(' | ', nullif(g.notes, ''),
                      'merged ' || merged.merged_from || ' fragment/duplicate rows on 2026-07-27'),
    updated_at    = now()
FROM merged
WHERE g.id = merged.survivor_id;

-- Step 4 — move the losers' aliases onto the survivor.
-- The unique key is (element_id, alias_norm, COALESCE(lang,'')), and two losers
-- in the same group routinely share an alias — so BOTH collision classes must be
-- cleared before the UPDATE, else it aborts on geo_element_aliases_uniq.
DELETE FROM public.geo_element_aliases a           -- 4a: survivor already has it
USING public._road_merge_plan m
WHERE a.element_id = m.id AND m.rn > 1
  AND EXISTS (
    SELECT 1 FROM public.geo_element_aliases b
    WHERE b.element_id = m.survivor_id
      AND b.alias_norm IS NOT DISTINCT FROM a.alias_norm
      AND coalesce(b.lang, '') = coalesce(a.lang, '')
  );

DELETE FROM public.geo_element_aliases a           -- 4b: duplicated among losers
USING (
  SELECT a2.id,
         row_number() OVER (PARTITION BY m.survivor_id, a2.alias_norm, coalesce(a2.lang, '')
                            ORDER BY a2.id) AS dup_rn
  FROM public.geo_element_aliases a2
  JOIN public._road_merge_plan m ON a2.element_id = m.id AND m.rn > 1
) d
WHERE a.id = d.id AND d.dup_rn > 1;

UPDATE public.geo_element_aliases a                -- 4c: move what's left
SET element_id = m.survivor_id, external_id = m.survivor_ext
FROM public._road_merge_plan m
WHERE a.element_id = m.id AND m.rn > 1;

-- Step 5 — retire the losers (deactivate, never delete).
UPDATE public.geo_elements g
SET is_active     = false,
    is_searchable = false,
    notes         = concat_ws(' | ', nullif(g.notes, ''),
                      'merged into ' || m.survivor_ext || ' on 2026-07-27 (duplicate/fragment)'),
    raw           = coalesce(g.raw, '{}'::jsonb) || jsonb_build_object(
                      'merged_into_external_id', m.survivor_ext,
                      'merged_into_id', m.survivor_id,
                      'merged_at', '2026-07-27'),
    updated_at    = now()
FROM public._road_merge_plan m
WHERE g.id = m.id AND m.rn > 1;

-- Step 6 — helper tables are scaffolding; the backup + each retired row's
-- raw.merged_into_id are the durable audit trail.
DROP TABLE IF EXISTS public._road_merge_plan;
DROP TABLE IF EXISTS public._road_merge_referenced;

-- Statement timeout: run steps 1..6 as SEPARATE statements. Wrapping the whole
-- thing in one transaction exceeded the statement timeout on wassell-prod.
