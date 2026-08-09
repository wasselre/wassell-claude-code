-- ─────────────────────────────────────────────────────────────────────────
-- market_listings freeze fallout, wave 3 — READ paths
--
-- Freezing market_listings (2026-08-07) moved all 314,070 rows out of
-- public.records into the dedicated public.market_listings table. Two earlier
-- commits patched part of the fallout (9304bfd5 rewrote the finder's
-- wassell_market_candidates(_json); fee83621 re-based duplicate grouping).
-- This migration closes the READ paths those two missed. Every function below
-- still queried `public.records WHERE model_id = <market>`, which now matches
-- ZERO rows and returns empty without erroring — the silent-failure shape
-- CLAUDE.md warns about.
--
-- Verified broken on prod before this migration:
--   • wassell_market_candidate_count → 0 while wassell_market_candidates
--     returned 2,699 for the same district under the same authed JWT.
--   • wassell_market_geo_coverage    → {in_scope: 0, with_coordinates: 0, …}
--
-- NOT touched (checked, and genuinely fine):
--   • wassell_market_map_districts — reads market_benchmarks + units/clients,
--     all of which are still unfrozen JSONB in `records`.
--
-- No DDL on the frozen table. No app deploy needed — the SPA and the edge
-- functions call every one of these by name.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. The slim summary view must NOT be an invoker view ──────────────────
--
-- The 2026-07-17 fast-path migration deliberately made market_listings_summary
-- `security_invoker=false` so its inline wassell_view_scope_class(...) CASE is
-- the ONE gate, evaluated once per statement as an InitPlan. Rebuilding the
-- view over the frozen table brought it back as `security_invoker=true`, which
-- re-imposes the table's generated `frozen_view` RLS policy ON TOP — and that
-- policy's jsonb_build_object(...) materializes all ~80 columns (including
-- description, image_urls, source_payload, scraped_extras) for EVERY row just
-- to run the check.
--
-- Measured under a real authed JWT before this change:
--   • 793 ms for one 1,000-row keyset page (the SPA pages the whole 314k set)
--   • a bare count(*) over the view EXCEEDED the 8 s authenticated
--     statement_timeout outright
--
-- The view is owned by `postgres`, so as a definer view the scope-class CASE
-- applies exactly as designed. Security is unchanged: 'all' → visible,
-- 'none' → hidden, anything else → the same per-row wassell_can_view_jsonb.
ALTER VIEW public.market_listings_summary SET (security_invoker = false);

-- ── 2. wassell_market_candidate_count — the twin the 08-07 fix missed ─────
--
-- Re-implemented as a straight count over the SAME listing_points filter
-- wassell_market_candidates uses, minus the LIMIT. Deriving both from one
-- filter is the point: the count and the list can no longer disagree.
--
-- The RLS posture matches the list function (gate on wassell_view_scope_class,
-- which is what the 08-07 rewrite settled on) rather than the old per-row
-- wassell_can_view_record — that predicate takes a `records` rowtype and has
-- no meaning for a frozen model. market_listings carries no per-profile
-- scoping, so this is security-neutral in practice and, more importantly,
-- identical to what the user already sees in the list.
CREATE OR REPLACE FUNCTION public.wassell_market_candidate_count(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric DEFAULT NULL::numeric,
  p_budget_max numeric DEFAULT NULL::numeric,
  p_bedrooms numeric DEFAULT NULL::numeric,
  p_type_terms text[] DEFAULT NULL::text[],
  p_record_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS bigint
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count bigint;
BEGIN
  IF public.wassell_view_scope_class(auth.uid(), p_model_id) = 'none' THEN
    RETURN 0;
  END IF;
  IF p_record_ids IS NULL AND p_district_ids IS NULL THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.listing_points lp
  WHERE (
      (p_record_ids IS NOT NULL AND lp.record_id = ANY(p_record_ids))
      OR (p_record_ids IS NULL AND p_district_ids IS NOT NULL
          AND lp.district_id = ANY(p_district_ids::uuid[]))
    )
    AND (
      p_budget_max IS NULL OR lp.price IS NULL
      OR (lp.price <= p_budget_max AND (p_budget_min IS NULL OR lp.price >= p_budget_min))
    )
    AND (p_bedrooms IS NULL OR lp.bedrooms IS NULL OR lp.bedrooms = p_bedrooms)
    AND (
      p_type_terms IS NULL OR coalesce(lp.type_text, '') = ''
      OR EXISTS (SELECT 1 FROM unnest(p_type_terms) t WHERE lp.type_text ILIKE '%' || t || '%')
    );

  RETURN coalesce(v_count, 0);
END;
$function$;

-- ── 3. wassell_market_geo_coverage ───────────────────────────────────────
--
-- Reads the frozen table's TYPED COLUMNS, not market_listings_v.
--
-- Going through the JSONB-shape view would force Postgres to build the full
-- ~80-key jsonb for all 314,070 rows before the WHERE could filter — that
-- alone exceeded the statement timeout when first tried. The typed columns
-- are what the freeze gave us; use them.
--
-- RLS: SECURITY DEFINER owned by `postgres`, and market_listings has
-- relforcerowsecurity=false, so the owner bypasses RLS here — exactly the
-- posture this function already had when it read `records` pre-freeze.
CREATE OR REPLACE FUNCTION public.wassell_market_geo_coverage()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'in_scope',            count(*),
    'with_coordinates',    count(*) FILTER (WHERE lp.geom IS NOT NULL),
    'without_coordinates', count(*) FILTER (WHERE lp.geom IS NULL),
    'pct_without_coordinates',
      round(100.0 * count(*) FILTER (WHERE lp.geom IS NULL) / nullif(count(*), 0), 1))
  FROM public.market_listings r
  LEFT JOIN public.listing_points lp ON lp.record_id = r.id
  WHERE coalesce(r.listing_type, 'sale') = 'sale'
    AND r.price > 0
    AND r.area > 0
    AND r.price_per_m2 > 0;
$function$;

-- ── 4. wassell_market_area_stats ─────────────────────────────────────────
--
-- Only the market-listing source changes (the `_area_norm` temp table). Every
-- other `public.records` read in this function — our_projects, all_projects,
-- units, clients — is a model that is STILL unfrozen, and is left untouched.
--
-- Two details:
--   • It reads the frozen table's TYPED COLUMNS, not market_listings_v —
--     going through the JSONB view builds an ~80-key jsonb per row and is far
--     too slow at this row count (see note on geo_coverage above).
--   • `location` is a text column holding a JSON string, so it is parsed once
--     per row with try_jsonb in a LATERAL; every expression below then reads
--     loc.j->>'district' where it used to read data->'location'->>'district'.
CREATE OR REPLACE FUNCTION public.wassell_market_area_stats(p_items jsonb DEFAULT '[]'::jsonb, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
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
  DROP TABLE IF EXISTS _area_ids;
  DROP TABLE IF EXISTS _area_norm;
  DROP TABLE IF EXISTS _area_dedup;

  CREATE TEMP TABLE _area_ids (record_id uuid PRIMARY KEY) ON COMMIT DROP;

  IF v_has_geo THEN
    v_tmp := gen_random_uuid();
    PERFORM public.wassell_compile_geo_items(v_tmp, p_items);

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

  CREATE TEMP TABLE _area_norm ON COMMIT DROP AS
  SELECT
    m.id,
    (loc.j->>'city')     AS city_id,
    (loc.j->>'district') AS district_id,
    public.wassell_canon_property_type(m.property_type) AS canon_type,
    m.price         AS price,
    m.area          AS area,
    m.price_per_m2  AS ppm2,
    m.bedrooms      AS bedrooms,
    public.wassell_bedrooms_bucket(m.bedrooms) AS bbucket,
    md5(coalesce(loc.j->>'district','') || '|' ||
        public.wassell_canon_property_type(m.property_type) || '|' ||
        coalesce(round(m.price)::text,'') || '|' ||
        coalesce(round(m.area)::text,'') || '|' ||
        coalesce(m.bedrooms::text,'') || '|' ||
        coalesce(round(m.latitude, 4)::text,'') || '|' ||
        coalesce(round(m.longitude, 4)::text,'')
    ) AS fingerprint
  FROM _area_ids a
  JOIN public.market_listings m ON m.id = a.record_id
  CROSS JOIN LATERAL (SELECT public.try_jsonb(m.location) AS j) loc
  WHERE coalesce(m.listing_type, 'sale') = 'sale'
    AND (NOT v_active_only OR coalesce(m.is_active, true))
    AND m.price > 0
    AND m.area > 0
    AND m.price_per_m2 > 0;

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
$function$;

-- ── 5. wassell_refresh_market_benchmarks ─────────────────────────────────
--
-- Same single change: the `_ml_norm` source. This one was a LANDMINE rather
-- than a live bug — nobody had run it since the freeze, and the first run
-- would have DELETEd today's snapshot and rewritten it from zero rows.
--
-- Same typed-column treatment as area_stats above. The unit/our_projects half
-- of the function is untouched — those models are still unfrozen.
--
-- Worth knowing: only the 57,549 Aqar rows carry a `location` object at all;
-- the 256k UAE rows (bayut/dubizzle/propertyfinder) use emirate/community and
-- have no Saudi district id. Benchmarks are district-keyed, so they stay
-- Saudi-only. That is pre-existing behaviour, not something this fix changes.
CREATE OR REPLACE FUNCTION public.wassell_refresh_market_benchmarks()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_market_model_id uuid := '8f06bc39-4bee-42e9-9fab-77023fb89ede';
  v_units_model_id  uuid := '7ca3014d-f658-418e-9c53-2d279c97f009';
  v_our_model_id    uuid := '6609286a-f95a-45db-94e6-48cfa915ccbd';
  v_today date := CURRENT_DATE;
  v_written int := 0;
BEGIN
  DELETE FROM public.market_benchmarks WHERE snapshot_date = v_today;

  CREATE TEMP TABLE _ml_norm ON COMMIT DROP AS
  SELECT
    (loc.j->>'region')   AS region_id,
    (loc.j->>'city')     AS city_id,
    (loc.j->>'district') AS district_id,
    public.wassell_canon_property_type(m.property_type) AS canon_type,
    m.price         AS price,
    m.area          AS area,
    m.price_per_m2  AS ppm2,
    m.bedrooms      AS bedrooms,
    md5(coalesce(loc.j->>'district','') || '|' ||
        public.wassell_canon_property_type(m.property_type) || '|' ||
        coalesce(round(m.price)::text,'') || '|' ||
        coalesce(round(m.area)::text,'') || '|' ||
        coalesce(m.bedrooms::text,'') || '|' ||
        coalesce(round(m.latitude, 4)::text,'') || '|' ||
        coalesce(round(m.longitude, 4)::text,'')
    ) AS fingerprint
  FROM public.market_listings m
  CROSS JOIN LATERAL (SELECT public.try_jsonb(m.location) AS j) loc
  WHERE coalesce(m.listing_type, 'sale') = 'sale'
    AND m.price > 0
    AND m.area > 0
    AND m.price_per_m2 > 0
    AND (loc.j->>'district') IS NOT NULL;

  ALTER TABLE _ml_norm ADD COLUMN bbucket text;
  UPDATE _ml_norm SET bbucket = CASE
    WHEN bedrooms IS NULL THEN 'all'
    WHEN bedrooms <= 2 THEN '1-2'
    WHEN bedrooms = 3 THEN '3'
    WHEN bedrooms = 4 THEN '4'
    ELSE '5+' END;

  CREATE TEMP TABLE _ml_dedup ON COMMIT DROP AS
  SELECT DISTINCT ON (fingerprint) * FROM _ml_norm ORDER BY fingerprint;

  CREATE TEMP TABLE _ml_raw_all ON COMMIT DROP AS
  SELECT district_id, canon_type, count(*) AS raw_count FROM _ml_norm GROUP BY 1,2;
  CREATE TEMP TABLE _ml_raw_bb ON COMMIT DROP AS
  SELECT district_id, canon_type, bbucket, count(*) AS raw_count FROM _ml_norm GROUP BY 1,2,3;

  INSERT INTO public.market_benchmarks (
    snapshot_date, region_id, city_id, district_id, district_name, district_name_en, city_name, property_type,
    bedrooms_bucket, area_bucket, source_type, raw_count, deduped_count, duplicate_ratio,
    median_price, p10_price, p25_price, p75_price, p90_price,
    median_price_per_sqm, p10_price_per_sqm, p25_price_per_sqm, p75_price_per_sqm, p90_price_per_sqm,
    min_price_per_sqm, max_price_per_sqm, median_area, confidence_grade, confidence_reason)
  SELECT
    v_today, max(d.region_id), max(d.city_id), d.district_id,
    max(coalesce(dr.name_ar, dr.display_name)), max(dr.name_en), max(dr.city_name_ar),
    d.canon_type, 'all', 'all', 'asking',
    r.raw_count, count(*)::int, round(1 - (count(*)::numeric / nullif(r.raw_count,0)), 4),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.1) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.9) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.1) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.9) WITHIN GROUP (ORDER BY d.ppm2),
    min(d.ppm2), max(d.ppm2),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.area),
    public.wassell_benchmark_confidence(count(*)::int,
      round(1 - (count(*)::numeric / nullif(r.raw_count,0)), 4), 'asking', false),
    'asking-only; ' || count(*)::text || ' deduped of ' || r.raw_count::text || ' listings'
  FROM _ml_dedup d
  JOIN _ml_raw_all r ON r.district_id = d.district_id AND r.canon_type = d.canon_type
  LEFT JOIN public.districts dr ON dr.id = d.district_id::uuid
  GROUP BY d.district_id, d.canon_type, r.raw_count
  HAVING count(*) >= 3;

  GET DIAGNOSTICS v_written = ROW_COUNT;

  INSERT INTO public.market_benchmarks (
    snapshot_date, region_id, city_id, district_id, district_name, district_name_en, city_name, property_type,
    bedrooms_bucket, area_bucket, source_type, raw_count, deduped_count, duplicate_ratio,
    median_price, p10_price, p25_price, p75_price, p90_price,
    median_price_per_sqm, p10_price_per_sqm, p25_price_per_sqm, p75_price_per_sqm, p90_price_per_sqm,
    min_price_per_sqm, max_price_per_sqm, median_area, confidence_grade, confidence_reason)
  SELECT
    v_today, max(d.region_id), max(d.city_id), d.district_id,
    max(coalesce(dr.name_ar, dr.display_name)), max(dr.name_en), max(dr.city_name_ar),
    d.canon_type, d.bbucket, 'all', 'asking',
    r.raw_count, count(*)::int, round(1 - (count(*)::numeric / nullif(r.raw_count,0)), 4),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.1) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.9) WITHIN GROUP (ORDER BY d.price),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.1) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2),
    percentile_cont(0.9) WITHIN GROUP (ORDER BY d.ppm2),
    min(d.ppm2), max(d.ppm2),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.area),
    public.wassell_benchmark_confidence(count(*)::int,
      round(1 - (count(*)::numeric / nullif(r.raw_count,0)), 4), 'asking', false),
    'asking-only; bedrooms ' || d.bbucket
  FROM _ml_dedup d
  JOIN _ml_raw_bb r ON r.district_id = d.district_id AND r.canon_type = d.canon_type AND r.bbucket = d.bbucket
  LEFT JOIN public.districts dr ON dr.id = d.district_id::uuid
  WHERE d.bbucket <> 'all'
  GROUP BY d.district_id, d.canon_type, d.bbucket, r.raw_count
  HAVING count(*) >= 5;

  INSERT INTO public.market_benchmarks (
    snapshot_date, region_id, city_id, district_id, district_name, district_name_en, city_name, property_type,
    bedrooms_bucket, area_bucket, source_type,
    raw_count, deduped_count, duplicate_ratio,
    median_price, p10_price, p25_price, p75_price, p90_price,
    median_price_per_sqm, p10_price_per_sqm, p25_price_per_sqm, p75_price_per_sqm, p90_price_per_sqm,
    min_price_per_sqm, max_price_per_sqm, median_area,
    confidence_grade, confidence_reason)
  SELECT
    v_today, max(u.region_id), max(u.city_id), u.district_id,
    max(coalesce(dr.name_ar, dr.display_name)), max(dr.name_en), max(dr.city_name_ar),
    u.canon_type, 'all', 'all', 'our_verified',
    count(*)::int, count(*)::int, 0,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY u.price),
    percentile_cont(0.1) WITHIN GROUP (ORDER BY u.price),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY u.price),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY u.price),
    percentile_cont(0.9) WITHIN GROUP (ORDER BY u.price),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY u.ppm2),
    percentile_cont(0.1) WITHIN GROUP (ORDER BY u.ppm2),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY u.ppm2),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY u.ppm2),
    percentile_cont(0.9) WITHIN GROUP (ORDER BY u.ppm2),
    min(u.ppm2), max(u.ppm2),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY u.area),
    public.wassell_benchmark_confidence(count(*)::int, 0, 'our_verified', false),
    'verified Wassel units'
  FROM (
    SELECT
      (proj.data->'location'->>'region') AS region_id,
      (proj.data->'location'->>'city') AS city_id,
      (proj.data->'location'->>'district') AS district_id,
      public.wassell_canon_property_type(un.data->>'unit_type') AS canon_type,
      nullif(un.data->>'total_price','')::numeric AS price,
      nullif(un.data->>'unit_area','')::numeric AS area,
      CASE WHEN nullif(un.data->>'unit_area','')::numeric > 0
           THEN nullif(un.data->>'total_price','')::numeric / nullif(un.data->>'unit_area','')::numeric END AS ppm2
    FROM public.records un
    JOIN public.records proj
      ON proj.id = nullif(coalesce(un.data->>'project_id', un.data->'project_id'->>0),'')::uuid
    WHERE un.model_id = v_units_model_id
      AND EXISTS (
        SELECT 1 FROM public.records op
        WHERE op.model_id = v_our_model_id
          AND (
            (jsonb_typeof(op.data->'project') = 'array' AND jsonb_exists(op.data->'project', proj.id::text))
            OR op.data->>'project' = proj.id::text
          )
      )
      AND nullif(un.data->>'total_price','')::numeric > 0
      AND nullif(un.data->>'unit_area','')::numeric > 0
      AND (proj.data->'location'->>'district') IS NOT NULL
  ) u
  LEFT JOIN public.districts dr ON dr.id = u.district_id::uuid
  GROUP BY u.district_id, u.canon_type
  HAVING count(*) >= 1;

  UPDATE public.market_benchmarks a
  SET asking_transaction_gap_pct = round((a.median_price_per_sqm - t.median_price_per_sqm)
        / nullif(t.median_price_per_sqm,0) * 100, 1),
      transaction_count = t.deduped_count
  FROM public.market_benchmarks t
  WHERE a.snapshot_date = v_today AND a.source_type = 'asking'
    AND t.snapshot_date = v_today AND t.source_type = 'transaction'
    AND coalesce(a.district_id,'') = coalesce(t.district_id,'')
    AND a.property_type = t.property_type
    AND a.bedrooms_bucket = t.bedrooms_bucket;

  RETURN v_written;
END;
$function$;

COMMIT;
