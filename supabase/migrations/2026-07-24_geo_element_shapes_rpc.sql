-- ============================================================================
-- wassell_geo_element_shapes — authenticated GeoJSON fetch for a few elements
-- ============================================================================
-- The client location picker (DistrictMapPicker) lets users SEARCH roads
-- (roads_major / ring_roads / metro_lines) and, on pick, draws the actual road
-- line so they can see WHERE it runs. geo_elements.geom is a PostGIS geometry
-- (roads are MultiLineString) and PostGIS types can't be read as GeoJSON inline
-- through PostgREST, so this RPC returns simplified GeoJSON for a small set of
-- external_ids.
--
-- Read-only, SECURITY DEFINER, granted to authenticated (same posture as
-- wassell_preview_geo_items). Only returns active + searchable + non-rejected
-- rows — exactly the public landmark/road set the picker already reads via the
-- authenticated SELECT on geo_elements — so it exposes nothing extra.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_geo_element_shapes(p_external_ids text[])
RETURNS TABLE (
  external_id  text,
  name_ar      text,
  name_en      text,
  display_name text,
  element_type text,
  geojson      jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.external_id,
    e.name_ar,
    e.name_en,
    e.display_name,
    e.element_type,
    ST_AsGeoJSON(ST_SimplifyPreserveTopology(e.geom, 0.0001), 6)::jsonb
  FROM public.geo_elements e
  WHERE e.external_id = ANY (p_external_ids)
    AND e.geom IS NOT NULL
    AND e.is_active
    AND e.is_searchable
    AND coalesce(e.review_status, '') <> 'rejected'
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.wassell_geo_element_shapes(text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.wassell_geo_element_shapes(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_geo_element_shapes(text[]) TO service_role;

COMMIT;
