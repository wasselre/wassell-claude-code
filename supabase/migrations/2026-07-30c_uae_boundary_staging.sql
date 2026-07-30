-- UAE geography, step 3 of 3: the boundary staging lane.
--
-- PostGIS geometry cannot be POSTed over PostgREST, so district polygons land as
-- GeoJSON in a staging table and Postgres parses them with ST_GeomFromGeoJSON — the
-- same two-step the Saudi import used (`_geo_stage_boundaries`).
--
-- Service-role only. This is import plumbing, never touched by the SPA.

CREATE TABLE IF NOT EXISTS public._geo_uae_stage_boundaries (
  spl_district_id text PRIMARY KEY,   -- our external district id, e.g. AE-DXB-D0001
  city_id         text,
  region_id       text,
  geojson         jsonb NOT NULL,
  geometry_type   text
);

ALTER TABLE public._geo_uae_stage_boundaries ENABLE ROW LEVEL SECURITY;
-- No policies at all: RLS with zero policies denies every non-superuser role, so only
-- service_role (which bypasses RLS) can read or write it.
REVOKE ALL ON public._geo_uae_stage_boundaries FROM anon, authenticated;

-- The WHERE clause is REQUIRED, not stylistic: an unqualified
-- `DELETE FROM _geo_uae_stage_boundaries;` is rejected with SQLSTATE 21000
-- "DELETE requires a WHERE clause" by this project's safe-update guard, which fires
-- even inside a SECURITY DEFINER function. `spl_district_id` is the NOT NULL primary
-- key, so the predicate matches every row. TRUNCATE would also satisfy the guard but
-- takes ACCESS EXCLUSIVE, and this table is written in batches over minutes.
CREATE OR REPLACE FUNCTION public.geo_uae_stage_reset()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public._geo_uae_stage_boundaries WHERE spl_district_id IS NOT NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('cleared', v_deleted);
END; $$;

/**
 * Convert staged GeoJSON into district_boundaries rows, linked to the district
 * records by our external id.
 *
 * Deliberately scoped to the UAE (`spl_district_id LIKE 'AE-%'`): a bug here must not
 * be able to touch the 3,733 Saudi boundaries. ST_MakeValid because OSM rings can
 * self-intersect, and an invalid geometry would make every later ST_Contains against
 * it error rather than return false.
 */
CREATE OR REPLACE FUNCTION public.geo_uae_apply_boundaries()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_staged   int;
  v_applied  int;
  v_unlinked int;
  v_invalid  int;
BEGIN
  SELECT count(*) INTO v_staged FROM public._geo_uae_stage_boundaries;

  DELETE FROM public.district_boundaries
  WHERE spl_district_id LIKE 'AE-%'
    AND spl_district_id NOT IN (SELECT spl_district_id FROM public._geo_uae_stage_boundaries);

  INSERT INTO public.district_boundaries
    (district_record_id, spl_district_id, city_id, region_id, geom, geometry_type,
     boundary_source, boundary_updated_at, is_active)
  SELECT
    d.id,
    s.spl_district_id,
    s.city_id,
    s.region_id,
    ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(s.geojson::text), 4326)),
    s.geometry_type,
    'OpenStreetMap via Overpass API (ODbL)',
    now(),
    true
  FROM public._geo_uae_stage_boundaries s
  LEFT JOIN public.districts d ON d.spl_district_id = s.spl_district_id
  ON CONFLICT (spl_district_id) DO UPDATE SET
    district_record_id  = EXCLUDED.district_record_id,
    city_id             = EXCLUDED.city_id,
    region_id           = EXCLUDED.region_id,
    geom                = EXCLUDED.geom,
    geometry_type       = EXCLUDED.geometry_type,
    boundary_source     = EXCLUDED.boundary_source,
    boundary_updated_at = now(),
    is_active           = true;

  SELECT count(*) INTO v_applied FROM public.district_boundaries WHERE spl_district_id LIKE 'AE-%';
  -- A boundary with no district row is a real defect (the district import didn't run,
  -- or the ids drifted): surfaced in the return value, not swallowed.
  SELECT count(*) INTO v_unlinked FROM public.district_boundaries
   WHERE spl_district_id LIKE 'AE-%' AND district_record_id IS NULL;
  SELECT count(*) INTO v_invalid FROM public.district_boundaries
   WHERE spl_district_id LIKE 'AE-%' AND NOT ST_IsValid(geom);

  RETURN jsonb_build_object(
    'staged', v_staged, 'applied', v_applied,
    'unlinked_to_district', v_unlinked, 'invalid_geometry', v_invalid);
END; $$;

REVOKE ALL ON FUNCTION public.geo_uae_stage_reset() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_uae_apply_boundaries() FROM anon, authenticated;
