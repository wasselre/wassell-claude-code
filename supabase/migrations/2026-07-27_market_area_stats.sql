-- ============================================================================
-- Market Intelligence — arbitrary-AREA statistics + map layers
-- ============================================================================
-- Until now every Market Intelligence number was keyed to a DISTRICT, because
-- market_benchmarks is precomputed per district × type × bedrooms. This adds the
-- live, on-demand twin: the same statistics for ANY area the user can express in
-- the client-preference vocabulary — one or more districts, "north of الدائري
-- الشمالي up to 5 km", "within 3 km of KAFD", a freehand polygon, or any union
-- of those minus exclusions.
--
-- ZERO AI, same as the rest of the layer. Every figure below is a SQL aggregate.
--
-- SEMANTICS — the area means EXACTLY what it means in the Project Finder.
-- We do not re-implement the geometry predicate: we compile the items with the
-- same wassell_compile_geo_items and resolve membership with the same
-- wassell_geo_match. If the Finder would return a listing for this area, it is
-- counted here, and vice versa. Keeping a second predicate in sync by hand is
-- exactly the drift this codebase has been bitten by before.
--
-- SECURITY DEFINER, deliberately (see reference: the finder market RPC once
-- returned empty because a SECURITY INVOKER function ran RLS over 46k listing
-- rows and hit the statement timeout, which was then swallowed as "no matches").
-- These functions return AGGREGATES over public asking ads — no per-row owner,
-- same non-sensitive posture as market_benchmarks itself.
--
-- ACTIVE-ONLY, by default and by decision. listing_points.is_active is false for
-- the 12,882 ads the Friday reconcile found delisted. "Current asking market"
-- must mean ads that are actually up, so p_filters.active_only defaults to TRUE.
-- NOTE this differs from wassell_refresh_market_benchmarks, which has no
-- is_active filter and therefore still counts delisted ads in the per-district
-- benchmarks. Flagged to the user 2026-07-27; not silently changed here, because
-- moving every district benchmark is a decision with its own blast radius.
-- ============================================================================

BEGIN;

-- ── Bedrooms bucket (mirrors the CASE inside wassell_refresh_market_benchmarks) ──
CREATE OR REPLACE FUNCTION public.wassell_bedrooms_bucket(p_bedrooms numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_bedrooms IS NULL THEN 'all'
    WHEN p_bedrooms <= 2 THEN '1-2'
    WHEN p_bedrooms = 3 THEN '3'
    WHEN p_bedrooms = 4 THEN '4'
    ELSE '5+' END;
$$;

COMMENT ON FUNCTION public.wassell_bedrooms_bucket(numeric) IS
  'Bedrooms bucket for market segments. Same thresholds as wassell_refresh_market_benchmarks — keep in sync.';

-- ============================================================================
-- wassell_market_area_stats(p_items, p_filters) → jsonb
-- ============================================================================
-- p_items   : client-preference location_items[] (district / element_rule /
--             drawn_area, include+exclude). Empty array = no geometry gate, in
--             which case p_filters.city_id / district_ids narrow instead.
-- p_filters : { property_type: canonical text, bedrooms_bucket: text,
--               active_only: bool (default true), city_id: text,
--               district_ids: text[] }
--
-- Returns the same shape family as a market_benchmarks row so the UI can render
-- an area and a district with one component, plus the breakdowns and the
-- our-inventory / client-demand counts that only make sense for a live area.
CREATE OR REPLACE FUNCTION public.wassell_market_area_stats(
  p_items   jsonb DEFAULT '[]'::jsonb,
  p_filters jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp named explicitly: this body creates and reads temp tables, and a
-- SET search_path that omits it is the documented way to make that fragile.
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $$
DECLARE
  v_market_model_id uuid := '8f06bc39-4bee-42e9-9fab-77023fb89ede';
  v_units_model_id  uuid := '7ca3014d-f658-418e-9c53-2d279c97f009';
  v_our_model_id    uuid := '6609286a-f95a-45db-94e6-48cfa915ccbd';
  v_all_proj_model_id uuid := '220c49b9-de57-492d-9eca-c0d9f54fd40f';
  v_clients_model_id  uuid := '2e86f197-385f-4853-908f-b4cb7237f7d8';
  v_tmp uuid;
  v_has_geo boolean := jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0;
  v_active_only boolean := coalesce((p_filters->>'active_only')::boolean, true);
  v_ptype text := nullif(p_filters->>'property_type','');
  v_bbucket text := nullif(p_filters->>'bedrooms_bucket','');
  v_city text := nullif(p_filters->>'city_id','');
  v_dids text[] := CASE WHEN p_filters ? 'district_ids'
                        THEN ARRAY(SELECT jsonb_array_elements_text(p_filters->'district_ids'))
                        END;
  v_geo_status jsonb;
  v_raw int := 0;
  v_ded int := 0;
  v_dupe numeric := 0;
  v_out jsonb;
  v_price jsonb; v_ppm2 jsonb; v_median_area numeric;
  v_by_type jsonb; v_by_bed jsonb; v_districts jsonb;
  v_our jsonb; v_demand jsonb;
BEGIN
  -- ── 1. Resolve the area to a set of listing record ids ────────────────────
  -- Drop first: ON COMMIT DROP only fires at commit, so a previous call that
  -- raised inside the same session would otherwise leave these behind and every
  -- later call in that connection would fail with "relation already exists".
  DROP TABLE IF EXISTS _area_ids;
  DROP TABLE IF EXISTS _area_norm;
  DROP TABLE IF EXISTS _area_dedup;

  CREATE TEMP TABLE _area_ids (record_id uuid PRIMARY KEY) ON COMMIT DROP;

  IF v_has_geo THEN
    v_tmp := gen_random_uuid();
    PERFORM public.wassell_compile_geo_items(v_tmp, p_items);

    -- Surface per-item compile status so the UI can say "this rule could not be
    -- resolved" instead of silently returning a smaller area.
    SELECT jsonb_agg(jsonb_build_object(
             'item_id', item_id, 'kind', kind, 'polarity', polarity,
             'validation_status', validation_status))
      INTO v_geo_status
      FROM public.client_pref_geometry WHERE client_id = v_tmp;

    INSERT INTO _area_ids (record_id)
    SELECT m.record_id FROM public.wassell_geo_match(v_tmp) m
    ON CONFLICT DO NOTHING;

    DELETE FROM public.client_pref_geometry WHERE client_id = v_tmp;
  ELSE
    -- No geometry: fall back to city / district narrowing over all points.
    INSERT INTO _area_ids (record_id)
    SELECT lp.record_id FROM public.listing_points lp
    WHERE lp.geom IS NOT NULL
      AND (NOT v_active_only OR lp.is_active)
      AND (v_dids IS NULL OR lp.district_id::text = ANY(v_dids))
    ON CONFLICT DO NOTHING;

    INSERT INTO _area_ids (record_id)
    SELECT pp.record_id FROM public.project_points pp
    WHERE pp.geom IS NOT NULL
      AND (v_dids IS NULL OR pp.district_id::text = ANY(v_dids))
    ON CONFLICT DO NOTHING;
  END IF;

  -- ── 2. Normalize the listings inside the area ─────────────────────────────
  -- Identical filters + fingerprint to wassell_refresh_market_benchmarks so an
  -- area that happens to be one district reproduces that district's benchmark.
  CREATE TEMP TABLE _area_norm ON COMMIT DROP AS
  SELECT
    r.id,
    (r.data->'location'->>'city')     AS city_id,
    (r.data->'location'->>'district') AS district_id,
    public.wassell_canon_property_type(r.data->>'property_type') AS canon_type,
    nullif(r.data->>'price','')::numeric        AS price,
    nullif(r.data->>'area','')::numeric         AS area,
    nullif(r.data->>'price_per_m2','')::numeric AS ppm2,
    nullif(r.data->>'bedrooms','')::numeric     AS bedrooms,
    public.wassell_bedrooms_bucket(nullif(r.data->>'bedrooms','')::numeric) AS bbucket,
    md5(coalesce(r.data->'location'->>'district','') || '|' ||
        public.wassell_canon_property_type(r.data->>'property_type') || '|' ||
        coalesce(round(nullif(r.data->>'price','')::numeric)::text,'') || '|' ||
        coalesce(round(nullif(r.data->>'area','')::numeric)::text,'') || '|' ||
        coalesce(r.data->>'bedrooms','') || '|' ||
        coalesce(round(nullif(r.data->>'latitude','')::numeric, 4)::text,'') || '|' ||
        coalesce(round(nullif(r.data->>'longitude','')::numeric, 4)::text,'')
    ) AS fingerprint
  FROM public.records r
  JOIN _area_ids a ON a.record_id = r.id
  WHERE r.model_id = v_market_model_id
    AND coalesce(r.data->>'listing_type','sale') = 'sale'
    AND (NOT v_active_only OR coalesce(r.data->>'is_active','true') = 'true')
    AND nullif(r.data->>'price','')::numeric > 0
    AND nullif(r.data->>'area','')::numeric > 0
    AND nullif(r.data->>'price_per_m2','')::numeric > 0;

  -- Optional segment filters.
  IF v_ptype IS NOT NULL THEN
    DELETE FROM _area_norm WHERE canon_type <> v_ptype;
  END IF;
  IF v_bbucket IS NOT NULL AND v_bbucket <> 'all' THEN
    DELETE FROM _area_norm WHERE bbucket <> v_bbucket;
  END IF;
  IF v_city IS NOT NULL THEN
    DELETE FROM _area_norm WHERE city_id IS DISTINCT FROM v_city;
  END IF;

  CREATE TEMP TABLE _area_dedup ON COMMIT DROP AS
  SELECT DISTINCT ON (fingerprint) * FROM _area_norm ORDER BY fingerprint;

  SELECT count(*) INTO v_raw FROM _area_norm;
  SELECT count(*) INTO v_ded FROM _area_dedup;
  v_dupe := CASE WHEN v_raw = 0 THEN 0
                 ELSE round(1 - (v_ded::numeric / v_raw), 4) END;

  -- ── 3. Aggregates ─────────────────────────────────────────────────────────
  SELECT jsonb_build_object(
           'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY price),
           'p10',    percentile_cont(0.1) WITHIN GROUP (ORDER BY price),
           'p25',    percentile_cont(0.25) WITHIN GROUP (ORDER BY price),
           'p75',    percentile_cont(0.75) WITHIN GROUP (ORDER BY price),
           'p90',    percentile_cont(0.9) WITHIN GROUP (ORDER BY price)),
         jsonb_build_object(
           'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2),
           'p10',    percentile_cont(0.1) WITHIN GROUP (ORDER BY ppm2),
           'p25',    percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2),
           'p75',    percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2),
           'p90',    percentile_cont(0.9) WITHIN GROUP (ORDER BY ppm2),
           'min',    min(ppm2), 'max', max(ppm2)),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY area)
    INTO v_price, v_ppm2, v_median_area
    FROM _area_dedup;

  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'count')::int DESC), '[]'::jsonb) INTO v_by_type
  FROM (
    SELECT jsonb_build_object(
             'property_type', canon_type,
             'count', count(*)::int,
             'median_price', percentile_cont(0.5) WITHIN GROUP (ORDER BY price),
             'median_price_per_sqm', percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2),
             'p25_price_per_sqm', percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2),
             'p75_price_per_sqm', percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2),
             'median_area', percentile_cont(0.5) WITHIN GROUP (ORDER BY area)) AS x
    FROM _area_dedup GROUP BY canon_type
  ) s;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'bedrooms_bucket'), '[]'::jsonb) INTO v_by_bed
  FROM (
    SELECT jsonb_build_object(
             'bedrooms_bucket', bbucket,
             'count', count(*)::int,
             'median_price', percentile_cont(0.5) WITHIN GROUP (ORDER BY price),
             'median_price_per_sqm', percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)) AS x
    FROM _area_dedup WHERE bbucket <> 'all' GROUP BY bbucket
  ) s;

  -- Districts the area actually touches (so the UI can name the area honestly
  -- even when it was drawn freehand across three of them).
  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'count')::int DESC), '[]'::jsonb) INTO v_districts
  FROM (
    SELECT jsonb_build_object(
             'district_id', d.district_id,
             'district_name', max(coalesce(dr.name_ar, dr.display_name)),
             'district_name_en', max(dr.name_en),
             'city_name', max(dr.city_name_ar),
             'count', count(*)::int,
             'median_price_per_sqm', percentile_cont(0.5) WITHIN GROUP (ORDER BY d.ppm2)) AS x
    FROM _area_dedup d
    LEFT JOIN public.districts dr ON dr.id = d.district_id::uuid
    WHERE d.district_id IS NOT NULL
    GROUP BY d.district_id
  ) s;

  -- ── 4. Our inventory inside the same area ─────────────────────────────────
  -- project_points (and therefore _area_ids) carries all_projects rows. "Ours"
  -- is the subset listed in our_projects (one row per project, field `project`).
  -- Units link to a project by data->>'project_id'; price is total_price and
  -- area is unit_area — NOT the field names the market listings use.
  WITH ours AS (
    SELECT DISTINCT (data->>'project') AS project_id
    FROM public.records WHERE model_id = v_our_model_id
  ),
  proj AS (
    SELECT pr.id
    FROM public.records pr
    JOIN _area_ids a ON a.record_id = pr.id
    JOIN ours o ON o.project_id = pr.id::text
    WHERE pr.model_id = v_all_proj_model_id
  ),
  un AS (
    SELECT u.id, u.data
    FROM public.records u
    JOIN proj p ON u.data->>'project_id' = p.id::text
    WHERE u.model_id = v_units_model_id
  )
  SELECT jsonb_build_object(
           'project_count', (SELECT count(*) FROM proj),
           'unit_count', (SELECT count(*) FROM un),
           'available_units', (SELECT count(*) FROM un
             WHERE coalesce(un.data->>'unit_status','') ILIKE '%متاح%'
                OR coalesce(un.data->>'unit_status','') ILIKE '%available%'),
           'median_price_per_sqm', (
             SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) FROM (
               SELECT nullif(un.data->>'total_price','')::numeric
                      / nullif(un.data->>'unit_area','')::numeric AS ppm2
               FROM un
               WHERE nullif(un.data->>'total_price','')::numeric > 0
                 AND nullif(un.data->>'unit_area','')::numeric > 0) q),
           'median_price', (
             SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p) FROM (
               SELECT nullif(un.data->>'total_price','')::numeric AS p FROM un
               WHERE nullif(un.data->>'total_price','')::numeric > 0) q))
    INTO v_our;

  -- ── 5. Client demand pointed at the districts this area covers ────────────
  -- Thin-data caveat applies exactly as it does on the Demand × Supply tab: this
  -- counts clients whose SAVED district preferences overlap the area. Clients who
  -- expressed the same area as a drawn shape or a road rule are NOT counted —
  -- comparing two compiled geometries per client is a different (and much more
  -- expensive) question, and pretending otherwise would overstate demand.
  SELECT jsonb_build_object(
           'active_clients', count(DISTINCT c.id),
           'basis', 'district_preferences_only')
    INTO v_demand
    FROM public.records c
    WHERE c.model_id = v_clients_model_id
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.data->'location_items') = 'array'
                    THEN c.data->'location_items' ELSE '[]'::jsonb END) li
        WHERE li->>'kind' = 'district'
          AND coalesce(li->>'polarity','include') = 'include'
          AND li->>'district_id' IN (
            SELECT jsonb_array_elements(v_districts)->>'district_id'));

  -- ── 6. Assemble ───────────────────────────────────────────────────────────
  v_out := jsonb_build_object(
    'raw_count', v_raw,
    'deduped_count', v_ded,
    'duplicate_ratio', v_dupe,
    'confidence_grade', public.wassell_benchmark_confidence(v_ded, v_dupe, 'asking', false),
    'confidence_reason', v_ded::text || ' deduped of ' || v_raw::text || ' asking ads in this area',
    'active_only', v_active_only,
    'has_geometry', v_has_geo,
    'geo_items', coalesce(v_geo_status, '[]'::jsonb),
    'price', coalesce(v_price, '{}'::jsonb),
    'price_per_sqm', coalesce(v_ppm2, '{}'::jsonb),
    'median_area', v_median_area,
    'by_type', v_by_type,
    'by_bedrooms', v_by_bed,
    'districts', v_districts,
    'our_inventory', coalesce(v_our, '{}'::jsonb),
    'demand', coalesce(v_demand, '{}'::jsonb),
    'snapshot_date', CURRENT_DATE
  );

  DROP TABLE IF EXISTS _area_ids;
  DROP TABLE IF EXISTS _area_norm;
  DROP TABLE IF EXISTS _area_dedup;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.wassell_market_area_stats(jsonb, jsonb) IS
  'Live asking-market statistics for an ARBITRARY area expressed as client-preference location_items. Membership is resolved by wassell_geo_match so it is identical to the Project Finder gate. Zero AI; every figure is a SQL aggregate.';

-- ============================================================================
-- wassell_market_map_districts(p_filters) → jsonb
-- ============================================================================
-- The choropleth feed: one row per district that has a benchmark, carrying the
-- metric + a simplified outline, plus our inventory and client demand counts so
-- the map's three layers come from ONE round trip.
CREATE OR REPLACE FUNCTION public.wassell_market_map_districts(
  p_filters jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $$
DECLARE
  v_units_model_id uuid := '7ca3014d-f658-418e-9c53-2d279c97f009';
  v_clients_model_id uuid := '2e86f197-385f-4853-908f-b4cb7237f7d8';
  v_ptype   text := coalesce(nullif(p_filters->>'property_type',''), 'شقة');
  v_bbucket text := coalesce(nullif(p_filters->>'bedrooms_bucket',''), 'all');
  v_city    text := nullif(p_filters->>'city_id','');
  v_out jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'district_id', b.district_id,
           'district_name', b.district_name,
           'district_name_en', b.district_name_en,
           'city_id', b.city_id,
           'city_name', b.city_name,
           'listing_count', b.deduped_count,
           'duplicate_ratio', b.duplicate_ratio,
           'confidence_grade', b.confidence_grade,
           'median_price', b.median_price,
           'median_price_per_sqm', b.median_price_per_sqm,
           'p25_price_per_sqm', b.p25_price_per_sqm,
           'p75_price_per_sqm', b.p75_price_per_sqm,
           'median_area', b.median_area,
           'our_units', coalesce(o.unit_count, 0),
           'demand_clients', coalesce(dm.client_count, 0),
           'centroid', CASE WHEN dr.centroid_lat IS NULL OR dr.centroid_lng IS NULL THEN NULL
                       ELSE jsonb_build_array(dr.centroid_lng, dr.centroid_lat) END,
           'outline', CASE WHEN db.geom IS NULL THEN NULL
                      ELSE ST_AsGeoJSON(ST_SimplifyPreserveTopology(db.geom, 0.0005), 5)::jsonb END
         )), '[]'::jsonb)
    INTO v_out
    FROM public.market_benchmarks b
    LEFT JOIN public.districts dr ON dr.id = b.district_id::uuid
    LEFT JOIN public.district_boundaries db
      ON db.district_record_id = b.district_id::uuid AND db.is_active
    -- Units carry their district as a NAME string, so counting them by name
    -- against a uuid-keyed benchmark would silently under-count. Go through the
    -- project instead: project_points.district_id is a real district uuid.
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS unit_count
      FROM public.records u
      JOIN public.project_points pp ON pp.record_id::text = u.data->>'project_id'
      WHERE u.model_id = v_units_model_id
        AND pp.district_id = b.district_id::uuid
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS client_count
      FROM public.records c
      WHERE c.model_id = v_clients_model_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(c.data->'location_items') = 'array'
                      THEN c.data->'location_items' ELSE '[]'::jsonb END) li
          WHERE li->>'kind' = 'district'
            AND coalesce(li->>'polarity','include') = 'include'
            AND li->>'district_id' = b.district_id)
    ) dm ON true
   WHERE b.snapshot_date = (SELECT max(snapshot_date) FROM public.market_benchmarks)
     AND b.source_type = 'asking'
     AND b.property_type = v_ptype
     AND b.bedrooms_bucket = v_bbucket
     AND (v_city IS NULL OR b.city_id = v_city)
     AND b.district_id IS NOT NULL;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.wassell_market_map_districts(jsonb) IS
  'Choropleth feed for the Market Intelligence map: per-district benchmark metric + simplified outline + our units + client demand, for one property type / bedrooms segment.';

-- Both functions are aggregate-only over public asking ads. Callable by the
-- authenticated role (the page itself is gated to admin/manager by CUSTOM_PAGES)
-- and by service_role for the API route.
REVOKE ALL ON FUNCTION public.wassell_market_area_stats(jsonb, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.wassell_market_map_districts(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_market_area_stats(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_market_map_districts(jsonb) TO authenticated, service_role;

COMMIT;
