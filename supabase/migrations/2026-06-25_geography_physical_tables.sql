-- Geography migration — physical tables for HEAVY geography artifacts.
-- These are deliberately NOT records-backed Wassell models: the SPA loads every
-- record of every records-model into the browser via unified_records, so 24 MB of
-- GeoJSON boundaries + ~15k aliases would download on every page load (violates the
-- "don't load heavy GeoJSON into normal views" rule). They live as dedicated tables
-- queried on demand (boundaries by city/bbox via RPC; aliases server-side for matching).
--
-- Regions / Cities / Districts ARE records-models (lookup targets) — created separately.

CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. District boundaries (heavy polygons, on-demand).
CREATE TABLE IF NOT EXISTS public.district_boundaries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_record_id   uuid,                          -- records.id of the district row (linked after import)
  spl_district_id      text NOT NULL UNIQUE,
  city_id              text,
  region_id            text,
  geom                 geometry(Geometry, 4326) NOT NULL,   -- Polygon | MultiPolygon, WGS84
  geometry_type        text,
  boundary_source      text,
  boundary_updated_at  timestamptz DEFAULT now(),
  is_active            boolean DEFAULT true
);
CREATE INDEX IF NOT EXISTS district_boundaries_geom_gix ON public.district_boundaries USING gist (geom);
CREATE INDEX IF NOT EXISTS district_boundaries_city_idx ON public.district_boundaries (city_id);
CREATE INDEX IF NOT EXISTS district_boundaries_drec_idx ON public.district_boundaries (district_record_id);

-- 2. District aliases (server-side matching helper).
CREATE TABLE IF NOT EXISTS public.district_aliases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_record_id  uuid,
  spl_district_id     text NOT NULL,
  alias_ar            text,
  alias_en            text,
  alias_type          text NOT NULL,   -- official|alternative_spelling|common_name|english_variant|arabic_variant|normalized|legacy|manual
  source              text,
  confidence_score    numeric,
  is_active           boolean DEFAULT true
);
CREATE INDEX IF NOT EXISTS district_aliases_spl_idx     ON public.district_aliases (spl_district_id);
CREATE INDEX IF NOT EXISTS district_aliases_alias_ar_idx ON public.district_aliases (alias_ar);
CREATE INDEX IF NOT EXISTS district_aliases_alias_en_idx ON public.district_aliases (lower(alias_en));
CREATE INDEX IF NOT EXISTS district_aliases_drec_idx    ON public.district_aliases (district_record_id);

-- 3. Geography import runs (audit metadata).
CREATE TABLE IF NOT EXISTS public.geography_import_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   text,
  source_path              text,
  extraction_date          date,
  import_started_at        timestamptz,
  import_completed_at      timestamptz,
  total_regions            int,
  total_cities             int,
  cities_with_districts    int,
  cities_without_districts  int,
  total_districts          int,
  imported_regions         int,
  imported_cities          int,
  imported_districts       int,
  imported_boundaries      int,
  missing_english_names_count int,
  duplicate_rows_removed   int,
  failed_records_count     int,
  status                   text,
  notes                    text,
  validation_report_json   jsonb
);

-- RLS: reference data — readable by all authenticated users; writes are service-role/admin only
-- (these tables are populated by migrations/import scripts, never by the SPA).
ALTER TABLE public.district_boundaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.district_aliases     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geography_import_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS district_boundaries_read ON public.district_boundaries;
CREATE POLICY district_boundaries_read ON public.district_boundaries FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS district_aliases_read ON public.district_aliases;
CREATE POLICY district_aliases_read ON public.district_aliases FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS geography_import_runs_admin ON public.geography_import_runs;
CREATE POLICY geography_import_runs_admin ON public.geography_import_runs FOR SELECT TO authenticated
  USING (wassell_is_admin((SELECT auth.uid())));

GRANT SELECT ON public.district_boundaries  TO authenticated;
GRANT SELECT ON public.district_aliases     TO authenticated;
GRANT SELECT ON public.geography_import_runs TO authenticated;

-- 4. On-demand boundary fetch RPC: by city, or by viewport bbox. Returns GeoJSON.
--    Never returns the whole country at once (the SPA must scope by city/bbox/zoom).
CREATE OR REPLACE FUNCTION public.district_boundaries_for_city(p_city_id text)
RETURNS TABLE(spl_district_id text, district_record_id uuid, geojson jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.spl_district_id, b.district_record_id, ST_AsGeoJSON(b.geom)::jsonb
  FROM public.district_boundaries b
  WHERE b.city_id = p_city_id AND b.is_active;
$$;

CREATE OR REPLACE FUNCTION public.district_boundaries_in_bbox(
  p_min_lng double precision, p_min_lat double precision,
  p_max_lng double precision, p_max_lat double precision)
RETURNS TABLE(spl_district_id text, district_record_id uuid, geojson jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.spl_district_id, b.district_record_id, ST_AsGeoJSON(b.geom)::jsonb
  FROM public.district_boundaries b
  WHERE b.is_active
    AND b.geom && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326);
$$;

GRANT EXECUTE ON FUNCTION public.district_boundaries_for_city(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.district_boundaries_in_bbox(double precision,double precision,double precision,double precision) TO authenticated;
