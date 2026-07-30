-- The map's serving surface: one RPC per viewport returning the zoom-appropriate
-- administrative outline plus main roads and landmark pins.
--
-- This file is the FINAL applied state; it folds in two corrections made after the
-- first cut, both of which are load-bearing.
--
-- 1. PAYLOAD. The first version measured 523 kB for one Dubai viewport and 1.2 MB at
--    street zoom — far too heavy to fire on every viewport change. Two causes:
--    ST_AsGeoJSON defaults to NINE decimal places (0.1 mm precision on a shape drawn a
--    few hundred pixels wide), and features far below one screen pixel were shipped in
--    full. At 5 decimals (~1 m) and dropping anything whose bbox spans under ~4 px, a
--    realistic viewport is 179–428 kB.
--
-- 2. DUPLICATES. `geo_boundaries` picked up two independent region sets on 2026-07-30:
--    one keyed by our external ids ('AE-DXB', '1'..'13') and one keyed by the `regions`
--    row uuid, inserted by a concurrent session populating the same new table. Both
--    describe the same 20 regions, so every provincial border drew twice in two
--    slightly different traces. Neither set is deleted — the other session's work is
--    not ours to discard and the uuid keying is perfectly valid. Instead each row is
--    tied to the RECORD it outlines and the RPC returns one row per record.

BEGIN;

-- Link region rows to their `regions` row, whichever key convention they used.
UPDATE public.geo_boundaries b
SET record_id = r.id
FROM public.regions r
WHERE b.tier = 'region' AND b.record_id IS NULL
  AND (b.external_id = r.id::text OR b.external_id = r.spl_region_id);

CREATE OR REPLACE FUNCTION public.geo_map_tier_for_zoom(p_zoom int)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  -- Bands chosen so the outline on screen is always the one you could meaningfully
  -- click: whole-Gulf view → countries, national view → regions, metro view → the city
  -- extent, street view → districts.
  SELECT CASE
    WHEN p_zoom <= 5 THEN 'country'
    WHEN p_zoom <= 7 THEN 'region'
    WHEN p_zoom <= 9 THEN 'city'
    ELSE 'district'
  END;
$$;

CREATE OR REPLACE FUNCTION public.geo_map_layers(
  p_min_lng double precision, p_min_lat double precision,
  p_max_lng double precision, p_max_lat double precision,
  p_zoom int, p_max_features int DEFAULT 400
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_env geometry; v_tier text; v_tol double precision; v_minspan double precision;
  v_cap int := greatest(1, least(coalesce(p_max_features, 400), 2000));
  v_bounds jsonb; v_roads jsonb; v_marks jsonb; v_total int; v_shown int;
BEGIN
  v_env  := ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326);
  v_tier := public.geo_map_tier_for_zoom(p_zoom);
  v_tol  := 360.0 / (256.0 * power(2, greatest(p_zoom, 1))) * 2.0;  -- ~2 screen px
  v_minspan := v_tol * 2.0;                                          -- ~4 screen px

  WITH deduped AS (
    -- DISTINCT ON the ENTITY, not the row. Newest wins, then the richer geometry, so
    -- the tie-break is deterministic rather than whatever Postgres returns first.
    SELECT DISTINCT ON (b.tier, coalesce(b.record_id::text, b.external_id))
           b.external_id, b.record_id, b.parent_external_id, b.tier,
           b.name_ar, b.name_en, b.country_code, b.geom
    FROM public.geo_boundaries b
    WHERE b.tier = v_tier AND b.geom && v_env
      AND greatest(ST_XMax(b.geom) - ST_XMin(b.geom), ST_YMax(b.geom) - ST_YMin(b.geom)) >= v_minspan
    ORDER BY b.tier, coalesce(b.record_id::text, b.external_id), b.updated_at DESC, ST_NPoints(b.geom) DESC
  ),
  picked AS (SELECT * FROM deduped ORDER BY ST_Area(geom) DESC LIMIT v_cap)
  SELECT jsonb_build_object('type', 'FeatureCollection',
           'features', coalesce(jsonb_agg(jsonb_build_object(
             'type', 'Feature', 'id', p.tier || ':' || p.external_id,
             'properties', jsonb_build_object(
               'tier', p.tier, 'external_id', p.external_id, 'record_id', p.record_id,
               'parent_external_id', p.parent_external_id, 'country_code', p.country_code,
               'name_ar', p.name_ar, 'name_en', p.name_en),
             'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(p.geom, v_tol), 5)::jsonb)), '[]'::jsonb)),
         count(*)
    INTO v_bounds, v_shown
  FROM picked p;

  -- Counts DEDUPED entities, else `truncated` would lie whenever a second key
  -- convention doubled the raw row count.
  SELECT count(*) INTO v_total FROM (
    SELECT DISTINCT coalesce(b.record_id::text, b.external_id)
    FROM public.geo_boundaries b WHERE b.tier = v_tier AND b.geom && v_env) t;

  IF p_zoom >= 9 THEN
    SELECT jsonb_build_object('type', 'FeatureCollection',
             'features', coalesce(jsonb_agg(jsonb_build_object(
               'type', 'Feature', 'id', e.external_id,
               'properties', jsonb_build_object('external_id', e.external_id, 'category', e.category,
                 'type', e.type, 'name_ar', e.name_ar, 'name_en', e.name_en, 'geom_kind', e.geom_kind),
               'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(e.geom, v_tol), 5)::jsonb)), '[]'::jsonb))
      INTO v_roads
    FROM (SELECT * FROM public.geo_elements
           WHERE category IN ('roads_major', 'ring_roads', 'metro_lines')
             AND is_active AND geom && v_env
           ORDER BY ST_Length(geom) DESC LIMIT least(v_cap, 150)) e;
  ELSE
    v_roads := jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb);
  END IF;

  IF p_zoom >= 11 THEN
    -- Landmarks are drawn as pins, so only the representative point is sent — never the
    -- mall or campus polygon behind it.
    SELECT jsonb_build_object('type', 'FeatureCollection',
             'features', coalesce(jsonb_agg(jsonb_build_object(
               'type', 'Feature', 'id', e.external_id,
               'properties', jsonb_build_object('external_id', e.external_id, 'category', e.category,
                 'type', e.type, 'name_ar', e.name_ar, 'name_en', e.name_en, 'geom_kind', e.geom_kind),
               'geometry', ST_AsGeoJSON(ST_PointOnSurface(e.geom), 5)::jsonb)), '[]'::jsonb))
      INTO v_marks
    FROM (SELECT * FROM public.geo_elements
           WHERE category IN ('landmarks', 'malls', 'universities', 'airports_transport', 'islands')
             AND is_active AND is_searchable AND review_status = 'approved'
             AND geom && v_env
           ORDER BY confidence_score DESC NULLS LAST LIMIT least(v_cap, 200)) e;
  ELSE
    v_marks := jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'tier', v_tier, 'zoom', p_zoom, 'simplify_tolerance', v_tol,
    'boundaries', v_bounds, 'roads', v_roads, 'landmarks', v_marks,
    'boundaries_total', v_total, 'boundaries_shown', coalesce(v_shown, 0),
    -- Never a silent cap: the caller is told the viewport held more than it drew.
    'truncated', v_total > coalesce(v_shown, 0));
END; $$;

GRANT EXECUTE ON FUNCTION public.geo_map_tier_for_zoom(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.geo_map_layers(double precision, double precision, double precision, double precision, int, int) TO authenticated;
REVOKE ALL ON FUNCTION public.geo_map_layers(double precision, double precision, double precision, double precision, int, int) FROM anon;

COMMIT;
