-- ============================================================================
-- Directional zone resolver — "north of Riyadh" → a concrete set of districts
-- ============================================================================
-- The matcher only understands cities + districts (boundary-verified). A vague
-- directional phrase ("شمال الرياض" / "north of Riyadh") has no home in the
-- requirements. This adds a DETERMINISTIC zone → districts resolver:
--   • GEOMETRIC default: classify a city's districts by their centroid's relative
--     position (lat/lng band within the city's bounding box). Scales to every city.
--   • CURATED OVERRIDE: geo_zone_overrides(city_id, zone, district_id) WINS over the
--     geometric rule for a (city, zone) when present — for locally-understood zones
--     that don't split on a clean line.
--
-- ZERO AI in the expansion. The LLM (if used) only maps the WORDS "north of Riyadh"
-- → {city, zone}; this function turns zone into district ids deterministically.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.geo_zone_overrides (
  city_id      text NOT NULL,            -- districts.city_id (city record id)
  zone         text NOT NULL,            -- 'north'|'south'|'east'|'west'|'center'|diagonals
  district_id  text NOT NULL,            -- districts.id
  source       text,                     -- provenance note (seed/curated/manual)
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, zone, district_id)
);
ALTER TABLE public.geo_zone_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geo_zone_overrides_read ON public.geo_zone_overrides;
CREATE POLICY geo_zone_overrides_read ON public.geo_zone_overrides FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.geo_zone_overrides TO authenticated;

-- Resolve a (city, zone) to its districts. p_city accepts the city NAME
-- (districts.city_name_ar) OR a city_id. Override wins; else geometric bands.
-- SECURITY DEFINER STABLE — reads the frozen public.districts directly.
CREATE OR REPLACE FUNCTION public.wassell_city_zone_districts(p_city text, p_zone text)
RETURNS TABLE(district_id uuid, district_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_zone text := lower(btrim(coalesce(p_zone,'')));
  v_city_id text;
BEGIN
  -- Resolve the city's id (all districts of a city share one city_id).
  SELECT d.city_id INTO v_city_id
  FROM public.districts d
  WHERE (d.city_name_ar = p_city OR d.city_id = p_city)
  LIMIT 1;
  IF v_city_id IS NULL THEN RETURN; END IF;

  -- 1) Curated override wins.
  IF EXISTS (SELECT 1 FROM public.geo_zone_overrides o WHERE o.city_id = v_city_id AND o.zone = v_zone) THEN
    RETURN QUERY
      SELECT d.id, coalesce(d.name_ar, d.display_name)
      FROM public.geo_zone_overrides o
      JOIN public.districts d ON d.id::text = o.district_id
      WHERE o.city_id = v_city_id AND o.zone = v_zone;
    RETURN;
  END IF;

  -- 2) Geometric: relative position of each centroid within the city bounding box.
  RETURN QUERY
  WITH city_d AS (
    SELECT d.id, coalesce(d.name_ar, d.display_name) AS nm, d.centroid_lat AS lat, d.centroid_lng AS lng
    FROM public.districts d
    WHERE d.city_id = v_city_id AND d.centroid_lat IS NOT NULL AND d.centroid_lng IS NOT NULL
  ), s AS (
    SELECT min(lat) lat0, max(lat) lat1, min(lng) lng0, max(lng) lng1 FROM city_d
  ), rel AS (
    SELECT c.id, c.nm,
      CASE WHEN s.lat1 = s.lat0 THEN 0.5 ELSE (c.lat - s.lat0) / (s.lat1 - s.lat0) END AS rlat,
      CASE WHEN s.lng1 = s.lng0 THEN 0.5 ELSE (c.lng - s.lng0) / (s.lng1 - s.lng0) END AS rlng
    FROM city_d c CROSS JOIN s
  )
  SELECT r.id, r.nm FROM rel r
  WHERE CASE v_zone
    WHEN 'north'     THEN r.rlat >= 0.60
    WHEN 'south'     THEN r.rlat <= 0.40
    WHEN 'east'      THEN r.rlng >= 0.60
    WHEN 'west'      THEN r.rlng <= 0.40
    WHEN 'center'    THEN r.rlat BETWEEN 0.35 AND 0.65 AND r.rlng BETWEEN 0.35 AND 0.65
    WHEN 'northeast' THEN r.rlat >= 0.55 AND r.rlng >= 0.55
    WHEN 'northwest' THEN r.rlat >= 0.55 AND r.rlng <= 0.45
    WHEN 'southeast' THEN r.rlat <= 0.45 AND r.rlng >= 0.55
    WHEN 'southwest' THEN r.rlat <= 0.45 AND r.rlng <= 0.45
    ELSE false END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_city_zone_districts(text, text) TO authenticated;

COMMENT ON FUNCTION public.wassell_city_zone_districts(text, text) IS
  'Resolve a (city, direction-zone) to district ids — curated geo_zone_overrides win, else geometric centroid bands. Deterministic; used by the Project Finder to expand "north of Riyadh".';

-- ── Seed: Riyadh "north" override = geometric north ∪ curated marquee districts ──
-- Demonstrates the override path. Geometric handles every other zone/city. The
-- team can edit these rows (or add other zones/cities) without a deploy.
INSERT INTO public.geo_zone_overrides (city_id, zone, district_id, source)
SELECT rc.city_id, 'north', z.district_id::text, 'riyadh_geo_seed'
FROM (SELECT DISTINCT city_id FROM public.districts WHERE city_name_ar = 'الرياض') rc
CROSS JOIN LATERAL public.wassell_city_zone_districts('الرياض', 'north') z
ON CONFLICT DO NOTHING;

INSERT INTO public.geo_zone_overrides (city_id, zone, district_id, source)
SELECT rc.city_id, 'north', d.id::text, 'riyadh_curated'
FROM (SELECT DISTINCT city_id FROM public.districts WHERE city_name_ar = 'الرياض') rc
JOIN public.districts d
  ON d.city_name_ar = 'الرياض'
 AND regexp_replace(d.name_ar, '^\s*حي\s+', '') IN
     ('النرجس','العارض','الياسمين','الملقا','حطين','الصحافة','النفل','القيروان','بنبان','الملقى')
ON CONFLICT DO NOTHING;

COMMIT;
