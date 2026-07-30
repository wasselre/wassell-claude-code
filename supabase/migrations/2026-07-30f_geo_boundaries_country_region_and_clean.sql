-- ============================================================================
-- geo_boundaries: fill the country + region tiers, and de-sliver the city tier
-- ============================================================================
-- Follows 2026-07-30e_geo_boundaries_all_tiers.sql, which built the tier store and
-- backfilled `district` and `city`. Two gaps remained, both measured on prod:
--
-- 1. THE COUNTRY AND REGION TIERS WERE EMPTY (0 rows each), while
--    `geo_map_tier_for_zoom` serves 'country' at zoom ≤5 and 'region' at ≤7. So
--    zooming out on any map drew nothing at all — the layer silently had no data
--    for two of its four tiers.
--
--    They are NOT derived by dissolving districts upward. Districts exist only
--    inside built-up areas, so the union of every Saudi district is not Saudi
--    Arabia — measured, it is 190 disconnected city blobs. Country and region come
--    from real OSM `boundary=administrative` relations instead
--    (data/source/geo/fetch-admin.mjs → scripts/import-admin-boundaries.mjs):
--    SA + AE at admin_level 2, and admin_level 4 for 13 Saudi provinces and 7
--    emirates, matched back to our own records so the parent chain still joins.
--
--    The city tier's own rationale (union of member districts) is unchanged and
--    still correct — a city's extent IS its districts, and most of our 190 cities
--    have no usable OSM municipal relation.
--
-- 2. THE CITY TIER WAS FULL OF PINHOLES. Adjacent district polygons do not share
--    exact edges, and `ST_Buffer(g, 0)` repairs invalid geometry but does NOT close
--    gaps between separate polygons. Measured on the city tier as built: 185 rows,
--    627 parts, **6,324 interior rings**, 363,661 points. Those rings are also
--    un-simplifiable — ST_SimplifyPreserveTopology must preserve every one of them.
--    `_geo_clean_dissolve` buffers out-and-back to close the seams, then drops
--    confetti parts and pinholes while keeping genuine islands and enclaves.
-- ============================================================================

BEGIN;

-- ── the cleaner ─────────────────────────────────────────────────────────────
-- Thresholds are BEST-EFFORT and must never annihilate a feature: applied to a
-- small one they can remove everything (الحصاة is a single district below
-- min_part_area). Hence the fallback chain at the end.
CREATE OR REPLACE FUNCTION public._geo_clean_dissolve(
  g geometry,
  eps double precision,
  min_part_area double precision,
  min_hole_area double precision
)
RETURNS geometry
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_closed geometry;
  v_out    geometry;
BEGIN
  IF g IS NULL OR ST_IsEmpty(g) THEN RETURN NULL; END IF;

  v_closed := ST_MakeValid(ST_Buffer(ST_Buffer(ST_MakeValid(g), eps), -eps));
  v_closed := ST_Multi(ST_CollectionExtract(v_closed, 3));

  WITH parts AS (
    SELECT (ST_Dump(v_closed)).geom AS p
  ), big AS (
    SELECT p FROM parts WHERE ST_Area(p) >= min_part_area
  ), rebuilt AS (
    SELECT ST_MakePolygon(
             ST_ExteriorRing(p),
             coalesce((
               SELECT array_agg(r) FROM (
                 SELECT ST_InteriorRingN(p, i) AS r
                 FROM generate_series(1, ST_NumInteriorRings(p)) i
                 WHERE ST_Area(ST_MakePolygon(ST_InteriorRingN(p, i))) >= min_hole_area
               ) keep_holes
             ), ARRAY[]::geometry[])
           ) AS p
    FROM big
  )
  SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Collect(p)), 3)) INTO v_out FROM rebuilt;

  IF v_out IS NULL OR ST_IsEmpty(v_out) THEN v_out := v_closed; END IF;
  IF v_out IS NULL OR ST_IsEmpty(v_out) THEN
    v_out := ST_Multi(ST_CollectionExtract(ST_MakeValid(g), 3));
  END IF;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public._geo_clean_dissolve(geometry, double precision, double precision, double precision) IS
  'Close sliver seams and drop confetti parts/pinholes from a dissolved administrative outline so it renders and simplifies. Never returns empty for a non-empty input.';

-- ── name normalization for matching OSM names to our records ────────────────
-- The prefix strip runs AFTER letter normalization, so its patterns must be in
-- post-normalization spelling: translate() maps ة→ه, so «إمارة» becomes «اماره».
-- Written the other way it never matched, and Ajman imported under its ISO code
-- beside the model's own id — 8 emirate rows for 7 emirates.
CREATE OR REPLACE FUNCTION public._geo_norm_admin_name(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(p, '')), 'أإآىة', 'ااايه'),
             '[ًٌٍَُِّْـ]', '', 'g'),
           '^(اماره|منطقه|محافظه|مدينه)[[:space:]]+', '', 'i'))
$$;

-- ── import one real OSM administrative border into geo_boundaries ───────────
-- external_id follows the chain the city tier already established: a city's
-- parent_external_id is its REGION RECORD UUID, so region rows are keyed by that
-- uuid (not the ISO code they arrive with), and country rows by the ISO-2 code.
CREATE OR REPLACE FUNCTION public.geo_boundary_import_admin(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier   text := p_row->>'level';
  v_cc     text := p_row->>'country_code';
  v_ext    text := p_row->>'ref_id';
  v_rec    uuid;
  v_parent text;
  v_geom   geometry;
BEGIN
  v_geom := ST_Multi(ST_CollectionExtract(
              ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p_row->>'geometry_geojson'), 4326)), 3));
  IF v_geom IS NULL OR ST_IsEmpty(v_geom) THEN
    RAISE EXCEPTION 'empty geometry for % % %', v_tier, v_cc, v_ext;
  END IF;

  IF v_tier = 'region' THEN
    SELECT r.id INTO v_rec
    FROM public.unified_records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'regions'
    WHERE coalesce(r.data->>'country_code','') = v_cc
      AND public._geo_norm_admin_name(r.data->>'name_ar')
        = public._geo_norm_admin_name(p_row->>'name_ar')
    LIMIT 1;

    IF v_rec IS NULL THEN
      -- Loud: an unjoined region still imports (the outline is real and useful),
      -- but a region the city tier cannot point at is a broken parent chain.
      RAISE WARNING 'geo_boundary_import_admin: region %/% matched no regions record; keying by ISO %',
        v_cc, p_row->>'name_ar', v_ext;
    ELSE
      v_ext := v_rec::text;
    END IF;
    v_parent := v_cc;
  ELSIF v_tier = 'country' THEN
    SELECT r.id INTO v_rec
    FROM public.unified_records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'countries'
    WHERE r.data->>'iso_code' = v_cc
    LIMIT 1;
    v_ext := v_cc;
    v_parent := NULL;
  ELSE
    RAISE EXCEPTION 'geo_boundary_import_admin only handles country/region, got %', v_tier;
  END IF;

  INSERT INTO public.geo_boundaries
    (tier, external_id, record_id, parent_external_id, country_code, name_ar, name_en, geom, source, updated_at)
  VALUES (v_tier, v_ext, v_rec, v_parent, v_cc,
          p_row->>'name_ar', p_row->>'name_en', v_geom,
          'osm: boundary=administrative relation ' || coalesce(p_row->>'osm_id','?'), now())
  ON CONFLICT (tier, external_id) DO UPDATE
    SET record_id = coalesce(excluded.record_id, geo_boundaries.record_id),
        parent_external_id = excluded.parent_external_id,
        country_code = excluded.country_code,
        name_ar = coalesce(excluded.name_ar, geo_boundaries.name_ar),
        name_en = coalesce(excluded.name_en, geo_boundaries.name_en),
        geom = excluded.geom,
        source = excluded.source,
        updated_at = now();

  RETURN jsonb_build_object('tier', v_tier, 'external_id', v_ext,
                            'joined', v_rec IS NOT NULL, 'points', ST_NPoints(v_geom));
END;
$$;

REVOKE ALL ON FUNCTION public.geo_boundary_import_admin(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.geo_boundary_import_admin(jsonb) TO service_role;

-- ── de-sliver the existing city tier in place ───────────────────────────────
-- eps 0.001° ≈ 110 m: wider than any district seam, far narrower than any real
-- gap between separate built-up areas.
UPDATE public.geo_boundaries
   SET geom = public._geo_clean_dissolve(geom, 0.001, 0.00002, 0.00005),
       source = coalesce(source, '') || ' + seam-cleaned',
       updated_at = now()
 WHERE tier = 'city';

COMMIT;
