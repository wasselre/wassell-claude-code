-- ============================================================================
-- Link geo_elements to the national geography layer (city_id / region_id)
-- ============================================================================
-- `geo_elements.city_id` and `region_id` have existed since the v1 table but were
-- NEVER populated — all 725 Riyadh anchors carry NULL in both. The only city
-- handle was the free-text `city` label ('Riyadh'), matched with ILIKE. That was
-- survivable while one city existed; with 21 cities the element layer needs a
-- real join key to the geography layer, so that "elements in this city" is an
-- id equality (the same lookup-first posture the district cutover established on
-- 2026-06-26) rather than a string comparison that a rename or a spelling variant
-- silently breaks. Note the dataset already contains one such variant: SPL stores
-- Abha as 'ابها' without the hamza.
--
-- Populated by CONTAINMENT against district_boundaries — the authoritative SPL
-- polygons — using each element's centroid_geog. This is strictly better than
-- trusting the label: an element's true city is wherever its point actually falls.
-- Elements outside every district polygon (an airport or a motorway stretch in
-- open desert is genuinely outside any residential district) fall back to the
-- NEAREST district within p_fallback_km, and are left NULL beyond that rather
-- than guessed at.
--
-- Idempotent and re-runnable; call it after every geo-intelligence import.
-- SECURITY DEFINER because it writes geo_elements while callers may only read it,
-- and because district_boundaries containment must see all rows.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_link_geo_elements_geography(
  p_only_null boolean DEFAULT true,
  p_fallback_km numeric DEFAULT 25,
  p_sync_label boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contained int := 0;
  v_nearest   int := 0;
  v_unmatched int := 0;
  v_relabel   int := 0;
BEGIN
  -- ── 1. exact containment ──────────────────────────────────────────────────
  WITH tgt AS (
    SELECT e.id, e.centroid_geog
    FROM public.geo_elements e
    WHERE e.centroid_geog IS NOT NULL
      AND (NOT p_only_null OR e.city_id IS NULL)
  ), hit AS (
    -- A point can sit inside overlapping/adjacent polygons; order deterministically
    -- so a re-run cannot flip the answer.
    SELECT DISTINCT ON (t.id)
           t.id, b.city_id, b.region_id
    FROM tgt t
    JOIN public.district_boundaries b
      ON b.is_active
     AND ST_Intersects(b.geom, t.centroid_geog::geometry)
    ORDER BY t.id, b.spl_district_id
  )
  UPDATE public.geo_elements e
     SET city_id = h.city_id, region_id = h.region_id
    FROM hit h
   WHERE h.id = e.id;
  GET DIAGNOSTICS v_contained = ROW_COUNT;

  -- ── 2. nearest-district fallback for points outside every polygon ─────────
  -- Uses the KNN operator (<->) inside a LATERAL so the GiST index on
  -- district_boundaries.geom does the work: one indexed nearest-neighbour lookup
  -- per unlinked point, then a single precise geography distance check on that one
  -- row. The obvious formulation — ST_DWithin(b.geom::geography, …) in the join —
  -- CASTS THE INDEXED COLUMN, which silently disables the index and turns this into
  -- 1,833 points x 3,733 polygons. That is what blew the statement timeout (57014)
  -- on the first multi-city import.
  WITH tgt AS (
    SELECT e.id, e.centroid_geog
    FROM public.geo_elements e
    WHERE e.centroid_geog IS NOT NULL
      AND e.city_id IS NULL
  ), near AS (
    SELECT t.id, k.city_id, k.region_id
    FROM tgt t
    CROSS JOIN LATERAL (
      SELECT b.city_id, b.region_id, b.geom
      FROM public.district_boundaries b
      WHERE b.is_active
      ORDER BY b.geom <-> t.centroid_geog::geometry
      LIMIT 1
    ) k
    WHERE ST_DWithin(k.geom::geography, t.centroid_geog, p_fallback_km * 1000)
  )
  UPDATE public.geo_elements e
     SET city_id = n.city_id, region_id = n.region_id
    FROM near n
   WHERE n.id = e.id;
  GET DIAGNOSTICS v_nearest = ROW_COUNT;

  -- ── 3. keep the free-text label consistent with the resolved city ─────────
  -- The label and the id must never disagree: wassell_search_geo_elements filters
  -- on the TEXT label (p_city ILIKE), so a row whose label says Riyadh but whose
  -- point is in Ad Dir'iyah would be unreachable for a Dir'iyah client. The 2026
  -- Riyadh import labelled everything inside its metropolitan bbox 'Riyadh',
  -- including 22 anchors that are really in Ad Dir'iyah (the At-Turaif heritage
  -- cluster) plus a handful in Al Uyainah / Al Muzahimiyah / Huraymila. Containment
  -- is the truth; the label follows it.
  IF p_sync_label THEN
    WITH city AS (
      SELECT r.data->>'spl_city_id' AS spl, r.data->>'name_en' AS name_en
      FROM public.unified_records r
      JOIN public.models m ON m.id = r.model_id
      WHERE m.name = 'cities' AND coalesce(r.data->>'name_en', '') <> ''
    )
    UPDATE public.geo_elements e
       SET city = c.name_en
      FROM city c
     WHERE c.spl = e.city_id
       AND e.city IS DISTINCT FROM c.name_en;
    GET DIAGNOSTICS v_relabel = ROW_COUNT;
  END IF;

  SELECT count(*) INTO v_unmatched
    FROM public.geo_elements
   WHERE centroid_geog IS NOT NULL AND city_id IS NULL;

  RETURN jsonb_build_object(
    'linked_by_containment', v_contained,
    'linked_by_nearest',     v_nearest,
    'relabelled',            v_relabel,
    'still_unlinked',        v_unmatched,
    'fallback_km',           p_fallback_km
  );
END;
$$;

COMMENT ON FUNCTION public.wassell_link_geo_elements_geography(boolean, numeric, boolean) IS
  'Populate geo_elements.city_id/region_id from district_boundaries containment '
  '(nearest district within p_fallback_km as fallback), then sync the free-text city '
  'label to the resolved city so the two can never disagree. Idempotent; run after '
  'every geo-intelligence import. p_only_null=false re-links every row.';

-- The 2-arg form from the first apply is superseded by the 3-arg form.
DROP FUNCTION IF EXISTS public.wassell_link_geo_elements_geography(boolean, numeric);

REVOKE ALL ON FUNCTION public.wassell_link_geo_elements_geography(boolean, numeric, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_link_geo_elements_geography(boolean, numeric, boolean) TO service_role;

-- Filtering elements by city/region is now an id lookup — index it.
CREATE INDEX IF NOT EXISTS geo_elements_city_id_idx   ON public.geo_elements (city_id)   WHERE city_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS geo_elements_region_id_idx ON public.geo_elements (region_id) WHERE region_id IS NOT NULL;

COMMIT;
