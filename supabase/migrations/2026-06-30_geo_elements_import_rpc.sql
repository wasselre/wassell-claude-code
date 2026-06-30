-- ============================================================================
-- Geo-intelligence import RPCs (service-role only)
-- ============================================================================
-- Server-side upsert from the dataset's JSON array, so geometry parses natively
-- with ST_GeomFromGeoJSON (impossible through a plain PostgREST upsert). Called
-- in batches by scripts/import-geo-intelligence.mjs (or directly). Keyed on
-- geo_elements.external_id (= dataset `id`, e.g. RUH-METR-0007). Idempotent.
--
-- centroid_geog (the canonical within_radius point) comes from the always-present
-- (latitude, longitude); geom holds the full GeoJSON geometry (point/line/polygon).
-- review_status defaults 'approved' (curated dataset); is_searchable true. The
-- confidence/verified/approximate flags ride along for display + the matcher's
-- low-confidence gate.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_import_geo_elements(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.geo_elements
    (external_id, element_type, category, type, geom_kind, name_ar, name_en, display_name,
     city, latitude, longitude, geom, centroid_geog, source_url, source_type,
     confidence_score, is_verified, is_approximate, review_status, is_searchable, notes, raw)
  SELECT
    r->>'id',
    r->>'category',                                  -- element_type (back-compat) = category
    r->>'category',
    r->>'type',
    coalesce(nullif(r->>'geometry_type',''), 'point'),
    nullif(r->>'name_ar',''), nullif(r->>'name_en',''),
    coalesce(nullif(r->>'name_en',''), nullif(r->>'name_ar',''), r->>'id'),
    nullif(r->>'city',''),
    nullif(r->>'latitude','')::double precision,
    nullif(r->>'longitude','')::double precision,
    CASE WHEN jsonb_typeof(r->'geometry_geojson') = 'object'
         THEN ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(r->>'geometry_geojson'), 4326)) END,
    CASE WHEN nullif(r->>'latitude','') IS NOT NULL AND nullif(r->>'longitude','') IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint((r->>'longitude')::double precision,
                                       (r->>'latitude')::double precision), 4326)::geography END,
    nullif(r->>'source_url',''), nullif(r->>'source_type',''),
    nullif(r->>'confidence_score','')::numeric,
    coalesce((r->>'is_verified')::boolean, false),
    coalesce((r->>'is_approximate')::boolean, false),
    'approved', true,
    nullif(r->>'notes',''),
    r
  FROM jsonb_array_elements(p_rows) AS r
  WHERE coalesce(r->>'id','') <> ''
  ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
    element_type=excluded.element_type, category=excluded.category, type=excluded.type,
    geom_kind=excluded.geom_kind, name_ar=excluded.name_ar, name_en=excluded.name_en,
    display_name=excluded.display_name, city=excluded.city,
    latitude=excluded.latitude, longitude=excluded.longitude,
    geom=excluded.geom, centroid_geog=excluded.centroid_geog,
    source_url=excluded.source_url, source_type=excluded.source_type,
    confidence_score=excluded.confidence_score, is_verified=excluded.is_verified,
    is_approximate=excluded.is_approximate, notes=excluded.notes, raw=excluded.raw,
    updated_at=now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('upserted', v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.wassell_import_geo_elements(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_import_geo_elements(jsonb) TO service_role;

-- Rebuild AR/EN aliases from the elements' names (idempotent; ON CONFLICT no-op).
CREATE OR REPLACE FUNCTION public.wassell_rebuild_geo_aliases()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.geo_element_aliases (element_id, external_id, alias, alias_norm, lang, source)
  SELECT e.id, e.external_id, v.alias, lower(btrim(v.alias)), v.lang, 'import'
  FROM public.geo_elements e
  CROSS JOIN LATERAL (VALUES (e.name_ar, 'ar'), (e.name_en, 'en')) AS v(alias, lang)
  WHERE e.external_id IS NOT NULL AND v.alias IS NOT NULL AND btrim(v.alias) <> ''
  ON CONFLICT (element_id, alias_norm, coalesce(lang,'')) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('aliases_added', v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.wassell_rebuild_geo_aliases() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_rebuild_geo_aliases() TO service_role;

COMMIT;
