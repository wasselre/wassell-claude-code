-- ============================================================================
-- Curated city zones — «شمال الرياض» is DATA, edited in Settings → City Zones
-- ============================================================================
-- 2026-06-30 gave us `wassell_city_zone_districts(city, zone)`: curated
-- `geo_zone_overrides` rows win, else a GEOMETRIC rule (each district's centroid
-- position inside the city's bounding box). The geometric rule is a fine default
-- for the ~1,300 cities nobody will ever curate, but it is NOT what locals mean:
-- the operator's words on 2026-09-21 — "what is known as the north district of
-- Riyadh is different from the districts you selected, which are in the north of
-- Riyadh on paper."
--
-- This migration makes the curated side EDITABLE from the app instead of from a
-- seed in a migration file:
--   a) wassell_city_zone_geometric(city_id, zone)  — the coordinate default,
--      lifted verbatim out of wassell_city_zone_districts so the UI can show
--      "here is what the map would say" next to "here is what we decided".
--      wassell_city_zone_districts keeps its exact signature + behaviour and
--      now delegates its fallback branch to it.
--   b) wassell_zone_cities()            — the city picker.
--   c) wassell_zone_city_districts(city)— the city's district roster (chips + search).
--   d) wassell_zone_state(city, zone)   — curated? effective ids, default ids.
--   e) wassell_zone_override_set(...)   — the ONLY write path. Admin-gated.
--
-- Read path unchanged: the geo-preference resolver, the Project Finder and
-- src/lib/market/zones.ts all keep calling wassell_city_zone_districts.
--
-- NOTE on ids (measured 2026-09-21, contradicts what you'd assume from the name):
--   public.districts.city_id      = the SPL/external city CODE   ('3' = الرياض,
--                                   'AE-DXB-C0067' = دبي). This is what
--                                   geo_zone_overrides.city_id holds.
--   public.districts.city_lookup  = the cities RECORD uuid — this is what
--                                   wassell_city_district_shapes(p_city_id uuid)
--                                   wants. They differ for all 5,129 rows, so
--                                   wassell_zone_cities() returns BOTH.
--
-- GRANTS: Supabase's ALTER DEFAULT PRIVILEGES gives anon/authenticated/
-- service_role EXECUTE on every NEW function in `public`, and `REVOKE ALL …
-- FROM public` does NOT undo that explicit anon grant (same trap as the view
-- grants in CLAUDE.md's frozen-model unwind — measured here: all five new
-- functions came out anon-executable). So each new function GRANTs first and
-- then REVOKEs `public, anon` — order matters, a revoke before the grant is a
-- no-op. wassell_city_zone_districts is deliberately left alone: it already had
-- anon EXECUTE before this migration and its behaviour must not change.
--
-- check_function_bodies is off for the same reason as 2026-09-02_05: the CI
-- ephemeral DB has neither the frozen `districts` table nor PostGIS.
-- ============================================================================

SET check_function_bodies = off;

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- a) The coordinate default, on its own. Verbatim lift of the geometric CTE
--    that lived inside wassell_city_zone_districts — same bands, same
--    thresholds, keyed by city_id only (the caller has already resolved it).
--    Mirrored in TS by src/lib/market/zones.ts `inZone` — change BOTH together.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_city_zone_geometric(p_city_id text, p_zone text)
RETURNS TABLE(district_id uuid, district_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH city_d AS (
    SELECT d.id, coalesce(d.name_ar, d.display_name) AS nm, d.centroid_lat AS lat, d.centroid_lng AS lng
    FROM public.districts d
    WHERE d.city_id = p_city_id AND d.centroid_lat IS NOT NULL AND d.centroid_lng IS NOT NULL
  ), s AS (
    SELECT min(lat) lat0, max(lat) lat1, min(lng) lng0, max(lng) lng1 FROM city_d
  ), rel AS (
    SELECT c.id, c.nm,
      CASE WHEN s.lat1 = s.lat0 THEN 0.5 ELSE (c.lat - s.lat0) / (s.lat1 - s.lat0) END AS rlat,
      CASE WHEN s.lng1 = s.lng0 THEN 0.5 ELSE (c.lng - s.lng0) / (s.lng1 - s.lng0) END AS rlng
    FROM city_d c CROSS JOIN s
  )
  SELECT r.id, r.nm FROM rel r
  WHERE CASE lower(btrim(coalesce(p_zone, '')))
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
$$;

GRANT EXECUTE ON FUNCTION public.wassell_city_zone_geometric(text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wassell_city_zone_geometric(text, text) FROM public, anon;
COMMENT ON FUNCTION public.wassell_city_zone_geometric(text, text) IS
  'The COORDINATE DEFAULT for a (city_id, zone): districts whose centroid falls in the zone band of the city bounding box. Ignores curated overrides — wassell_city_zone_districts is the resolver that layers them on top.';

-- ─────────────────────────────────────────────────────────────────────────────
--    The resolver itself: same signature, same behaviour (curated wins, else
--    geometric). Only the fallback branch changed — it now delegates.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_city_zone_districts(p_city text, p_zone text)
RETURNS TABLE(district_id uuid, district_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
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

  -- 2) Coordinate default.
  RETURN QUERY SELECT g.district_id, g.district_name
  FROM public.wassell_city_zone_geometric(v_city_id, v_zone) g;
END;
$$;

REVOKE ALL ON FUNCTION public.wassell_city_zone_districts(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_city_zone_districts(text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.wassell_city_zone_districts(text, text) IS
  'Resolve a (city, direction-zone) to district ids — curated geo_zone_overrides win, else the coordinate default (wassell_city_zone_geometric). Deterministic; used by the geo-preference resolver and the Project Finder to expand "north of Riyadh". Curate at /settings/geo-zones.';

-- ─────────────────────────────────────────────────────────────────────────────
-- b) City picker: every city that has active districts, with how many zones of
--    it have already been curated. Ordered by size so الرياض / دبي come first.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_zone_cities()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH cities AS (
    SELECT d.city_id,
           min(d.city_lookup)  AS city_lookup,
           min(d.city_name_ar) AS city_name_ar,
           min(d.city_name_en) AS city_name_en,
           count(*)            AS district_count
    FROM public.districts d
    WHERE d.is_active AND d.city_id IS NOT NULL
    GROUP BY d.city_id
  ), cur AS (
    SELECT o.city_id, jsonb_agg(DISTINCT o.zone) AS zones
    FROM public.geo_zone_overrides o
    GROUP BY o.city_id
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'city_id',       c.city_id,
      'city_lookup',   c.city_lookup,
      'city_name_ar',  c.city_name_ar,
      'city_name_en',  c.city_name_en,
      'district_count', c.district_count,
      'curated_zones', coalesce(cur.zones, '[]'::jsonb)
    ) ORDER BY c.district_count DESC, c.city_name_ar
  ), '[]'::jsonb)
  FROM cities c LEFT JOIN cur ON cur.city_id = c.city_id;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_zone_cities() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wassell_zone_cities() FROM public, anon;
COMMENT ON FUNCTION public.wassell_zone_cities() IS
  'Cities that have active districts, largest first, each with its curated zone list. Powers the city picker at /settings/geo-zones. city_id is the SPL code (what geo_zone_overrides keys on); city_lookup is the cities record uuid (what wassell_city_district_shapes wants).';

-- ─────────────────────────────────────────────────────────────────────────────
-- c) The city's district roster. The map only has shapes for districts that
--    have a boundary row (189 of الرياض's 190), so the roster — not the map —
--    is the authoritative list for the chips and the "add a district" search.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_zone_city_districts(p_city_id text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id',      d.id,
      'name_ar', coalesce(d.name_ar, d.display_name, d.name_en),
      'name_en', coalesce(d.name_en, d.display_name, d.name_ar)
    ) ORDER BY coalesce(d.name_ar, d.display_name)
  ), '[]'::jsonb)
  FROM public.districts d
  WHERE d.city_id = p_city_id AND d.is_active;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_zone_city_districts(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wassell_zone_city_districts(text) FROM public, anon;
COMMENT ON FUNCTION public.wassell_zone_city_districts(text) IS
  'Active districts of a city (id + both names) — the roster behind the chip list and the district search at /settings/geo-zones.';

-- ─────────────────────────────────────────────────────────────────────────────
-- d) What one (city, zone) looks like right now: is it curated, what does it
--    resolve to today, and what would the coordinates alone have said.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_zone_state(p_city_id text, p_zone text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'curated', EXISTS (
      SELECT 1 FROM public.geo_zone_overrides o
      WHERE o.city_id = p_city_id AND o.zone = lower(btrim(coalesce(p_zone, '')))
    ),
    'effective_ids', (
      SELECT coalesce(jsonb_agg(to_jsonb(e.district_id)), '[]'::jsonb)
      FROM public.wassell_city_zone_districts(p_city_id, p_zone) e
    ),
    'default_ids', (
      SELECT coalesce(jsonb_agg(to_jsonb(g.district_id)), '[]'::jsonb)
      FROM public.wassell_city_zone_geometric(p_city_id, p_zone) g
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.wassell_zone_state(text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wassell_zone_state(text, text) FROM public, anon;
COMMENT ON FUNCTION public.wassell_zone_state(text, text) IS
  'One (city, zone): { curated, effective_ids, default_ids }. effective = what the resolver returns today, default = what the coordinates alone would say. Read by /settings/geo-zones.';

-- ─────────────────────────────────────────────────────────────────────────────
-- e) The ONLY write path. RLS on geo_zone_overrides stays SELECT-only for
--    authenticated; every change goes through this definer function, which is
--    admin-gated. An EMPTY array means "stop curating this zone — go back to
--    the coordinate default", which is why the DELETE is unconditional.
--
--    NEVER raises SQLSTATE 40001/40P01 (see CLAUDE.md): PostgREST would retry
--    such an error forever. Admin refusal is 42501, bad input is 22023 — both
--    map to a plain HTTP error the browser sees once.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_zone_override_set(
  p_city_id text, p_zone text, p_district_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_zone   text := lower(btrim(coalesce(p_zone, '')));
  v_ids    uuid[] := coalesce(p_district_ids, ARRAY[]::uuid[]);
  v_bad    text;
  v_count  integer;
  v_source text;
BEGIN
  IF NOT public.wassell_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;

  IF v_zone NOT IN ('north','south','east','west','center','northeast','northwest','southeast','southwest') THEN
    RAISE EXCEPTION 'unknown zone %', coalesce(p_zone, '<null>') USING ERRCODE = '22023';
  END IF;

  IF p_city_id IS NULL OR btrim(p_city_id) = '' THEN
    RAISE EXCEPTION 'city_id is required' USING ERRCODE = '22023';
  END IF;

  -- A curated zone must never hold another city's district.
  SELECT string_agg(x.id::text, ', ') INTO v_bad
  FROM unnest(v_ids) AS x(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.districts d WHERE d.id = x.id AND d.city_id = p_city_id
  );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'districts not in city %: %', p_city_id, v_bad USING ERRCODE = '22023';
  END IF;

  v_source := 'curated:' || coalesce(auth.uid()::text, 'unknown');

  DELETE FROM public.geo_zone_overrides o WHERE o.city_id = p_city_id AND o.zone = v_zone;

  IF array_length(v_ids, 1) IS NOT NULL THEN
    INSERT INTO public.geo_zone_overrides (city_id, zone, district_id, source)
    SELECT DISTINCT p_city_id, v_zone, x.id::text, v_source
    FROM unnest(v_ids) AS x(id)
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.geo_zone_overrides o WHERE o.city_id = p_city_id AND o.zone = v_zone;

  RETURN jsonb_build_object('curated', v_count > 0, 'count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_zone_override_set(text, text, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wassell_zone_override_set(text, text, uuid[]) FROM public, anon;
COMMENT ON FUNCTION public.wassell_zone_override_set(text, text, uuid[]) IS
  'ADMIN ONLY. Replace the curated district set of one (city, zone). An empty array clears the curation, so the zone falls back to the coordinate default. The only write path to geo_zone_overrides — RLS on the table is SELECT-only.';

COMMIT;
