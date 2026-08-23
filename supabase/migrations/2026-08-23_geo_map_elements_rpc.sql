-- Client-facing viewport RPC for on-demand map layers (layer controls).
--
-- geo_map_layers already returns a BUNDLED "roads" set and a "landmarks" set,
-- zoom-gated, and never returns hospitals / parks / metro stations / business
-- zones. The map layer-control panel needs to switch INDIVIDUAL categories on and
-- off, including those, so this RPC takes an explicit category list and returns
-- exactly what was asked for, viewport-scoped and capped.
--
-- SECURITY DEFINER + granted to authenticated (same posture as geo_map_layers) so
-- every role can see context on the map; it is read-only over public.geo_elements.
--
-- Shape: { lines: FeatureCollection, points: FeatureCollection }
--   · line categories (roads_major, ring_roads, metro_lines) → simplified line geometry
--   · every other requested category → ONE representative point per place
--     (ST_PointOnSurface), de-duplicated by name within the category so a place
--     that exists as both a point row and a polygon row is pinned once.

CREATE OR REPLACE FUNCTION public.geo_map_elements(
  p_min_lng double precision, p_min_lat double precision,
  p_max_lng double precision, p_max_lat double precision,
  p_zoom integer,
  p_categories text[],
  p_max_features integer DEFAULT 600
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_env       geometry;
  v_tol       double precision;
  v_cap       int := greatest(1, least(coalesce(p_max_features, 600), 2000));
  v_line_cats text[] := ARRAY['roads_major', 'ring_roads', 'metro_lines'];
  v_req_line  text[];
  v_req_point text[];
  v_lines     jsonb;
  v_points    jsonb;
  v_empty     jsonb := jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb);
BEGIN
  IF p_categories IS NULL OR array_length(p_categories, 1) IS NULL THEN
    RETURN jsonb_build_object('lines', v_empty, 'points', v_empty, 'zoom', p_zoom);
  END IF;

  v_env := ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326);
  v_tol := 360.0 / (256.0 * power(2, greatest(p_zoom, 1))) * 2.0;

  v_req_line  := ARRAY(SELECT unnest(p_categories) INTERSECT SELECT unnest(v_line_cats));
  v_req_point := ARRAY(SELECT unnest(p_categories) EXCEPT   SELECT unnest(v_line_cats));

  -- ── line layers (roads / metro lines) ──────────────────────────────────────
  IF array_length(v_req_line, 1) IS NOT NULL THEN
    SELECT jsonb_build_object('type', 'FeatureCollection',
             'features', coalesce(jsonb_agg(f), '[]'::jsonb))
      INTO v_lines
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature', 'id', e.external_id,
        'properties', jsonb_build_object('external_id', e.external_id, 'category', e.category,
          'type', e.type, 'name_ar', e.name_ar, 'name_en', e.name_en),
        'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(e.geom, v_tol), 5)::jsonb) AS f
      FROM public.geo_elements e
      WHERE e.category = ANY(v_req_line)
        AND e.geom_kind = 'linestring'
        AND e.is_active
        AND coalesce(e.review_status, 'approved') <> 'rejected'
        AND e.geom && v_env
      ORDER BY ST_Length(e.geom) DESC
      LIMIT v_cap
    ) t;
  ELSE
    v_lines := v_empty;
  END IF;

  -- ── point layers (malls / parks / hospitals / universities / landmarks /
  --    metro stations …) — one representative pin per named place ─────────────
  IF array_length(v_req_point, 1) IS NOT NULL THEN
    SELECT jsonb_build_object('type', 'FeatureCollection',
             'features', coalesce(jsonb_agg(f), '[]'::jsonb))
      INTO v_points
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature', 'id', d.external_id,
        'properties', jsonb_build_object('external_id', d.external_id, 'category', d.category,
          'type', d.type, 'name_ar', d.name_ar, 'name_en', d.name_en),
        'geometry', ST_AsGeoJSON(ST_PointOnSurface(d.geom), 5)::jsonb) AS f
      FROM (
        -- de-dupe: a place present as both a point and a polygon row is pinned
        -- once; prefer the point row, then the more-confident one.
        SELECT DISTINCT ON (e.category, lower(coalesce(e.name_ar, e.name_en, e.external_id)))
               e.external_id, e.category, e.type, e.name_ar, e.name_en, e.geom, e.confidence_score
        FROM public.geo_elements e
        WHERE e.category = ANY(v_req_point)
          AND e.is_active AND e.is_searchable
          AND coalesce(e.review_status, 'approved') = 'approved'
          AND e.geom && v_env
        ORDER BY e.category, lower(coalesce(e.name_ar, e.name_en, e.external_id)),
                 (e.geom_kind = 'point') DESC, e.confidence_score DESC NULLS LAST
      ) d
      ORDER BY d.confidence_score DESC NULLS LAST
      LIMIT v_cap
    ) t;
  ELSE
    v_points := v_empty;
  END IF;

  RETURN jsonb_build_object('lines', v_lines, 'points', v_points, 'zoom', p_zoom);
END; $function$;

GRANT EXECUTE ON FUNCTION public.geo_map_elements(
  double precision, double precision, double precision, double precision, integer, text[], integer
) TO anon, authenticated, service_role;
