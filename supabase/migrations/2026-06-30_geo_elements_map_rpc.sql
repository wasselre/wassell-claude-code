-- ============================================================================
-- Geo Elements map view — filtered GeoJSON FeatureCollection RPC
-- ============================================================================
-- Feeds the admin module's Map tab (Google Maps Data layer). Returns the SAME
-- filtered set as wassell_admin_list_geo_elements, but as a GeoJSON
-- FeatureCollection with simplified geometry (lines/polygons reduced ~11 m so the
-- payload stays small; points unchanged). Read-only; service-role only (the API
-- gates on wassell_is_admin first). Geometry is never edited.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_admin_geo_geojson(
  p_q text DEFAULT NULL, p_category text DEFAULT NULL, p_type text DEFAULT NULL, p_city text DEFAULT NULL,
  p_geom_kind text DEFAULT NULL, p_review_status text DEFAULT NULL, p_is_verified boolean DEFAULT NULL,
  p_is_approximate boolean DEFAULT NULL, p_is_active boolean DEFAULT NULL, p_is_searchable boolean DEFAULT NULL,
  p_conf_min numeric DEFAULT NULL, p_conf_max numeric DEFAULT NULL, p_low_confidence boolean DEFAULT NULL,
  p_limit int DEFAULT 3000
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH f AS (
    SELECT e.* FROM public.geo_elements e
    WHERE e.external_id IS NOT NULL AND e.geom IS NOT NULL
      AND (p_category IS NULL OR e.category = p_category)
      AND (p_type IS NULL OR e.type = p_type)
      AND (p_city IS NULL OR e.city ILIKE p_city)
      AND (p_geom_kind IS NULL OR e.geom_kind = p_geom_kind)
      AND (p_review_status IS NULL OR e.review_status = p_review_status)
      AND (p_is_verified IS NULL OR e.is_verified = p_is_verified)
      AND (p_is_approximate IS NULL OR e.is_approximate = p_is_approximate)
      AND (p_is_active IS NULL OR e.is_active = p_is_active)
      AND (p_is_searchable IS NULL OR e.is_searchable = p_is_searchable)
      AND (p_conf_min IS NULL OR e.confidence_score >= p_conf_min)
      AND (p_conf_max IS NULL OR e.confidence_score <= p_conf_max)
      AND (NOT coalesce(p_low_confidence, false) OR (e.confidence_score IS NOT NULL AND e.confidence_score < 0.5))
      AND (
        nullif(btrim(coalesce(p_q,'')),'') IS NULL
        OR e.name_ar ILIKE '%'||btrim(p_q)||'%' OR e.name_en ILIKE '%'||btrim(p_q)||'%'
        OR e.display_name ILIKE '%'||btrim(p_q)||'%' OR e.external_id ILIKE '%'||btrim(p_q)||'%'
        OR EXISTS (SELECT 1 FROM public.geo_element_aliases a WHERE a.element_id = e.id AND a.alias_norm ILIKE '%'||lower(btrim(p_q))||'%')
      )
    ORDER BY e.category, e.external_id
    LIMIT greatest(1, least(coalesce(p_limit, 3000), 5000))
  )
  SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'count', (SELECT count(*) FROM f),
    'features', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(f.geom, 0.0001), 6)::jsonb,
        'properties', jsonb_build_object(
          'external_id', f.external_id, 'name_ar', f.name_ar, 'name_en', f.name_en,
          'category', f.category, 'type', f.type, 'geometry_type', f.geom_kind,
          'review_status', f.review_status, 'is_active', f.is_active, 'is_searchable', f.is_searchable,
          'is_verified', f.is_verified, 'confidence_score', f.confidence_score,
          'lat', f.latitude, 'lng', f.longitude
        )
      )) FROM f
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.wassell_admin_geo_geojson(text,text,text,text,text,text,boolean,boolean,boolean,boolean,numeric,numeric,boolean,int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_admin_geo_geojson(text,text,text,text,text,text,boolean,boolean,boolean,boolean,numeric,numeric,boolean,int)
  TO service_role;

COMMIT;
