-- Preview display for bounded direction rules (applied as TWO live migrations:
-- preview_direction_display_clip + direction_ref_single_line — this file is
-- the final state). The compiled geom is the road's full distance buffer
-- (matching then applies the side test); the picker must SHOW only the matched
-- side. Clip the buffer with a deep translate-band on the chosen side (line +
-- line shifted 1° ≈ 100km). Merged roads can be MULTILINESTRING, so refs are
-- normalized to their longest single line via _wassell_longest_line. Any
-- construction failure falls back to the full buffer (display-only; matching
-- is untouched). Rows also return listing_count/project_count so the picker
-- can name the exact rule that is too big.

CREATE OR REPLACE FUNCTION public._wassell_longest_line(p geometry)
RETURNS geometry LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT d.geom FROM (
    SELECT (ST_Dump(ST_CollectionExtract(ST_LineMerge(p), 2))).geom
  ) d ORDER BY ST_Length(d.geom) DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.wassell_preview_geo_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tmp uuid := gen_random_uuid();
  v_out jsonb;
BEGIN
  PERFORM public.wassell_compile_geo_items(v_tmp, p_items);

  SELECT jsonb_agg(jsonb_build_object(
    'item_id', g.item_id,
    'kind', g.kind,
    'polarity', g.polarity,
    'direction', g.direction,
    'validation_status', g.validation_status,
    'geojson', CASE
      WHEN g.geom IS NULL THEN NULL
      WHEN g.direction IS NOT NULL AND ln.line IS NOT NULL THEN
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(coalesce(clip.side_geom, g.geom), 0.0002), 5)::jsonb
      ELSE ST_AsGeoJSON(ST_SimplifyPreserveTopology(g.geom, 0.0002), 5)::jsonb
    END,
    'ref_geojson', CASE WHEN g.ref_geom IS NOT NULL
      THEN ST_AsGeoJSON(ST_SimplifyPreserveTopology(g.ref_geom, 0.0002), 5)::jsonb END,
    'listing_count', CASE WHEN g.geom IS NULL THEN NULL ELSE (
      SELECT count(*) FROM public.listing_points lp
      WHERE lp.is_active AND lp.geom IS NOT NULL AND ST_Contains(g.geom, lp.geom)
        AND (g.direction IS NULL OR public.wassell_geo_dir_match(g.ref_geom, lp.geom, g.direction))
    ) END,
    'project_count', CASE WHEN g.geom IS NULL THEN NULL ELSE (
      SELECT count(*) FROM public.project_points pp
      WHERE pp.is_active AND pp.geom IS NOT NULL AND ST_Contains(g.geom, pp.geom)
        AND (g.direction IS NULL OR public.wassell_geo_dir_match(g.ref_geom, pp.geom, g.direction))
    ) END
  ) ORDER BY g.item_id)
  INTO v_out
  FROM public.client_pref_geometry g
  LEFT JOIN LATERAL (
    SELECT public._wassell_longest_line(g.ref_geom) AS line
  ) ln ON g.ref_geom IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT (
      SELECT CASE WHEN c IS NULL OR ST_IsEmpty(c) THEN NULL ELSE c END FROM (
        SELECT ST_CollectionExtract(ST_Intersection(
          ST_MakeValid(g.geom),
          ST_MakeValid(ST_MakePolygon(ST_AddPoint(ST_MakeLine(
            ln.line,
            ST_Reverse(ST_Translate(ln.line,
              CASE g.direction WHEN 'east' THEN 1.0 WHEN 'west' THEN -1.0 ELSE 0 END,
              CASE g.direction WHEN 'north' THEN 1.0 WHEN 'south' THEN -1.0 ELSE 0 END))),
            ST_StartPoint(ln.line))))
        ), 3) AS c
      ) x
    ) AS side_geom
  ) clip ON g.direction IS NOT NULL AND ln.line IS NOT NULL
  WHERE g.client_id = v_tmp;

  DELETE FROM public.client_pref_geometry WHERE client_id = v_tmp;

  RETURN coalesce(v_out, '[]'::jsonb);
END;
$$;
