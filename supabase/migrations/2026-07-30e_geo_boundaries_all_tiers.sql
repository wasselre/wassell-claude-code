-- Boundary outlines for EVERY administrative tier, so a map can draw context instead
-- of just pins.
--
-- Today only the district tier has geometry (`district_boundaries`, 5,384 rows) and it
-- is read by exactly one screen, scoped to a single city
-- (`wassell_city_district_shapes`). `regions` and `cities` have no geometry column at
-- all, so country / region / city outlines were simply not drawable.
--
-- This adds ONE tier-aware store plus one viewport RPC. It is purely ADDITIVE:
-- `district_boundaries` and its consumers (`district_for_point`,
-- `districts_for_points`, `wassell_city_district_shapes`, the Project Finder's
-- geo-integrity audit) are untouched — this table is for RENDERING, that one is for
-- matching, and conflating them would put map-simplification concerns into the
-- containment path.

BEGIN;

CREATE TABLE IF NOT EXISTS public.geo_boundaries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier               text NOT NULL CHECK (tier IN ('country', 'region', 'city', 'district')),
  external_id        text NOT NULL,          -- 'SA' | 'AE-DXB' | 'AE-DXB-C0067' | 'AE-DXB-D0001'
  record_id          uuid,                   -- the frozen/records row this outlines, when there is one
  parent_external_id text,
  country_code       text NOT NULL,
  name_ar            text,
  name_en            text,
  geom               geometry(Geometry, 4326) NOT NULL,
  source             text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tier, external_id)
);

CREATE INDEX IF NOT EXISTS geo_boundaries_geom_gix ON public.geo_boundaries USING gist (geom);
CREATE INDEX IF NOT EXISTS geo_boundaries_tier_idx ON public.geo_boundaries (tier, country_code);
CREATE INDEX IF NOT EXISTS geo_boundaries_parent_idx ON public.geo_boundaries (parent_external_id);

-- Reference data: readable by every authenticated user, written only by import scripts.
ALTER TABLE public.geo_boundaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geo_boundaries_read ON public.geo_boundaries;
CREATE POLICY geo_boundaries_read ON public.geo_boundaries FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.geo_boundaries TO authenticated;

-- ── staging lane (PostGIS geometry can't be POSTed over PostgREST) ───────────
CREATE TABLE IF NOT EXISTS public._geo_boundary_stage (
  tier               text NOT NULL,
  external_id        text NOT NULL,
  parent_external_id text,
  country_code       text NOT NULL,
  name_ar            text,
  name_en            text,
  source             text,
  geojson            jsonb NOT NULL,
  PRIMARY KEY (tier, external_id)
);
ALTER TABLE public._geo_boundary_stage ENABLE ROW LEVEL SECURITY;  -- no policies → service-role only
REVOKE ALL ON public._geo_boundary_stage FROM anon, authenticated;

-- The WHERE clause is required — an unqualified DELETE is rejected with SQLSTATE 21000
-- by this project's safe-update guard, even inside a SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.geo_boundary_stage_reset()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v int;
BEGIN
  DELETE FROM public._geo_boundary_stage WHERE external_id IS NOT NULL;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN jsonb_build_object('cleared', v);
END; $$;

/** Promote staged GeoJSON into geo_boundaries. Only touches the tiers present in the
 *  staging table, so a country-only run can't wipe the region rows. */
CREATE OR REPLACE FUNCTION public.geo_boundary_stage_apply()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_applied int; v_invalid int;
BEGIN
  INSERT INTO public.geo_boundaries
    (tier, external_id, parent_external_id, country_code, name_ar, name_en, geom, source, updated_at)
  SELECT s.tier, s.external_id, s.parent_external_id, s.country_code, s.name_ar, s.name_en,
         ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(s.geojson::text), 4326)),
         s.source, now()
  FROM public._geo_boundary_stage s
  ON CONFLICT (tier, external_id) DO UPDATE SET
    parent_external_id = EXCLUDED.parent_external_id,
    country_code = EXCLUDED.country_code,
    name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en,
    geom = EXCLUDED.geom, source = EXCLUDED.source, updated_at = now();
  GET DIAGNOSTICS v_applied = ROW_COUNT;
  SELECT count(*) INTO v_invalid FROM public.geo_boundaries WHERE NOT ST_IsValid(geom);
  RETURN jsonb_build_object('applied', v_applied, 'invalid_geometry', v_invalid);
END; $$;

-- ── backfill: district tier, straight from the matching table ────────────────
INSERT INTO public.geo_boundaries
  (tier, external_id, record_id, parent_external_id, country_code, name_ar, name_en, geom, source)
SELECT 'district', b.spl_district_id, d.id, d.city_id,
       coalesce(d.country_code, 'SA'), d.name_ar, d.name_en, b.geom,
       coalesce(b.boundary_source, d.source)
FROM public.district_boundaries b
JOIN public.districts d ON d.id = b.district_record_id
WHERE b.is_active AND ST_IsValid(b.geom)
ON CONFLICT (tier, external_id) DO UPDATE SET
  geom = EXCLUDED.geom, record_id = EXCLUDED.record_id,
  parent_external_id = EXCLUDED.parent_external_id, updated_at = now();

-- ── backfill: city tier = the union of the city's own districts ──────────────
--
-- Not fetched from OSM, and deliberately so. Most of our 190 cities have no OSM
-- boundary relation at all, and where one exists it is a municipal limit that does not
-- match the districts drawn on top of it. The union of a city's districts IS its
-- built-up extent, it is guaranteed consistent with the district layer, and it costs
-- nothing. ST_Buffer(…, 0) cleans the seams left where adjacent districts don't quite
-- share an edge.
INSERT INTO public.geo_boundaries
  (tier, external_id, record_id, parent_external_id, country_code, name_ar, name_en, geom, source)
SELECT 'city', c.spl_city_id, c.id, c.region_lookup,
       coalesce(c.country_code, 'SA'), c.name_ar, c.name_en,
       ST_Multi(ST_Buffer(ST_Union(b.geom), 0)),
       'derived: union of member district boundaries'
FROM public.cities c
JOIN public.districts d ON d.city_lookup = c.id::text
JOIN public.district_boundaries b ON b.district_record_id = d.id AND b.is_active
WHERE ST_IsValid(b.geom)
GROUP BY c.id, c.spl_city_id, c.region_lookup, c.country_code, c.name_ar, c.name_en
HAVING count(*) > 0
ON CONFLICT (tier, external_id) DO UPDATE SET
  geom = EXCLUDED.geom, record_id = EXCLUDED.record_id,
  parent_external_id = EXCLUDED.parent_external_id,
  source = EXCLUDED.source, updated_at = now();

COMMIT;
