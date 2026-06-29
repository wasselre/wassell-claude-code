-- ============================================================================
-- Market Intelligence — benchmark precompute layer (Phase: Market Intelligence)
-- ============================================================================
-- Deterministic, refreshable price benchmarks derived from the live data:
--   • source_type='asking'       → public market_listings (Aqar asking prices)
--   • source_type='our_verified' → our_projects' units (verified Wassel inventory)
--   • source_type='transaction'  → official transaction data (NONE yet — schema-ready)
--
-- ZERO AI. Pure SQL aggregation. The refresh function is SECURITY DEFINER so it
-- counts ALL listings/units regardless of the caller's RLS (a salesperson who
-- can't see every listing must still get a complete benchmark). The resulting
-- aggregate rows are NON-SENSITIVE (no per-row owner) and exposed read-only to
-- every authenticated user — same posture as district_boundaries / document_templates.
--
-- Honest-by-design: raw_count vs deduped_count + duplicate_ratio + confidence_grade
-- are stored so every consumer can see how trustworthy a benchmark is. Asking
-- prices are NEVER labelled "market value" — that framing lives in the UI/PDF.
--
-- NOTE: `districts` / `cities` / `regions` are FROZEN models → their rows live in
-- the physical public.districts table (NOT in records). The refresh joins there.
-- ============================================================================

BEGIN;

-- ── Canonical property type ─────────────────────────────────────────────────
-- market_listings.property_type is free Arabic text with 326 distinct values
-- (mostly suffix noise: "فيلا"/"فيلا سكنية"/"فيلا للبيع" …). Collapse to a stable
-- canonical set so benchmark segments are robust. MIRRORED in TS at
-- src/lib/market/propertyType.ts (canonPropertyType) — KEEP IN SYNC. First match wins.
CREATE OR REPLACE FUNCTION public.wassell_canon_property_type(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN 'أخرى'
    WHEN p_raw ILIKE '%فيلا%' OR p_raw ILIKE '%دوبلكس%' OR p_raw ILIKE '%دبلكس%' OR p_raw ILIKE '%فلل%' THEN 'فيلا'
    WHEN p_raw ILIKE '%تاون%' THEN 'تاون هاوس'
    WHEN p_raw ILIKE '%شقة%' OR p_raw ILIKE '%شقه%' OR p_raw ILIKE '%شقق%' THEN 'شقة'
    WHEN p_raw ILIKE '%عمارة%' OR p_raw ILIKE '%عماره%' OR p_raw ILIKE '%عمائر%' THEN 'عمارة'
    WHEN p_raw ILIKE '%استراح%' THEN 'استراحة'
    WHEN p_raw ILIKE '%دور%' THEN 'دور'
    WHEN p_raw ILIKE '%أرض%' OR p_raw ILIKE '%ارض%' OR p_raw ILIKE '%اراض%' OR p_raw ILIKE '%أراض%' THEN 'أرض'
    WHEN p_raw ILIKE '%تجاري%' OR p_raw ILIKE '%تجاره%' OR p_raw ILIKE '%مكتب%' OR p_raw ILIKE '%محل%' OR p_raw ILIKE '%معرض%' THEN 'تجاري'
    WHEN p_raw ILIKE '%سكني%' OR p_raw ILIKE '%سكنيه%' THEN 'سكني'
    ELSE 'أخرى'
  END;
$$;

COMMENT ON FUNCTION public.wassell_canon_property_type(text) IS
  'Collapse free-text market_listings.property_type into a stable canonical bucket. Mirrored in src/lib/market/propertyType.ts — keep in sync.';

-- ── The benchmark table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.market_benchmarks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date            date NOT NULL DEFAULT CURRENT_DATE,
  region_id                text,
  city_id                  text,
  city_name                text,
  district_id              text,
  district_name            text,        -- Arabic (name_ar / display_name)
  district_name_en         text,        -- English (name_en)
  property_type            text NOT NULL,           -- canonical (wassell_canon_property_type)
  bedrooms_bucket          text NOT NULL DEFAULT 'all',  -- 'all' | '1-2' | '3' | '4' | '5+'
  area_bucket              text NOT NULL DEFAULT 'all',  -- reserved for future area splits
  source_type              text NOT NULL,           -- 'asking' | 'transaction' | 'our_verified'
  raw_count                integer NOT NULL DEFAULT 0,
  deduped_count            integer NOT NULL DEFAULT 0,
  duplicate_ratio          numeric NOT NULL DEFAULT 0,
  median_price             numeric,
  p10_price                numeric,
  p25_price                numeric,
  p75_price                numeric,
  p90_price                numeric,
  median_price_per_sqm     numeric,
  p10_price_per_sqm        numeric,
  p25_price_per_sqm        numeric,
  p75_price_per_sqm        numeric,
  p90_price_per_sqm        numeric,
  min_price_per_sqm        numeric,
  max_price_per_sqm        numeric,
  median_area              numeric,
  transaction_count        integer NOT NULL DEFAULT 0,
  asking_transaction_gap_pct numeric,
  confidence_grade         text NOT NULL DEFAULT 'low',  -- 'high' | 'medium' | 'low'
  confidence_reason        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_market_benchmarks_segment
  ON public.market_benchmarks (snapshot_date, source_type, property_type, bedrooms_bucket, area_bucket, coalesce(district_id,''));
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_district ON public.market_benchmarks (district_id);
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_city ON public.market_benchmarks (city_id);
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_ptype ON public.market_benchmarks (property_type);
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_source ON public.market_benchmarks (source_type);
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_snapshot ON public.market_benchmarks (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_lookup
  ON public.market_benchmarks (source_type, property_type, bedrooms_bucket, district_id);

ALTER TABLE public.market_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_benchmarks_read ON public.market_benchmarks;
CREATE POLICY market_benchmarks_read ON public.market_benchmarks
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.market_benchmarks TO authenticated;

-- ── Confidence grading (deterministic) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_benchmark_confidence(
  p_deduped int, p_dupe_ratio numeric, p_source text, p_has_txn boolean
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_deduped >= 30 AND p_dupe_ratio <= 0.25 THEN 'high'
    WHEN p_deduped >= 12 AND p_dupe_ratio <= 0.45 THEN 'medium'
    ELSE 'low'
  END;
$$;

-- ── The refresh function ────────────────────────────────────────────────────
-- Rebuilds the whole table for CURRENT_DATE. Cheap (~1,500 rows, ~2s). SECURITY
-- DEFINER so it sees all rows. Returns the number of 'all'-grain asking segments.
CREATE OR REPLACE FUNCTION public.wassell_refresh_market_benchmarks()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_market_model_id uuid := '8f06bc39-4bee-42e9-9fab-77023fb89ede';
  v_units_model_id  uuid := '7ca3014d-f658-418e-9c53-2d279c97f009';
  v_our_model_id    uuid := '6609286a-f95a-45db-94e6-48cfa915ccbd';
  v_today date := CURRENT_DATE;
  v_written int := 0;
BEGIN
  DELETE FROM public.market_benchmarks WHERE snapshot_date = v_today;

  -- ========================= ASKING (market_listings) =======================
  CREATE TEMP TABLE _ml_norm ON COMMIT DROP AS
  SELECT
    (data->'location'->>'region')   AS region_id,
    (data->'location'->>'city')     AS city_id,
    (data->'location'->>'district') AS district_id,
    public.wassell_canon_property_type(data->>'property_type') AS canon_type,
    nullif(data->>'price','')::numeric        AS price,
    nullif(data->>'area','')::numeric         AS area,
    nullif(data->>'price_per_m2','')::numeric AS ppm2,
    nullif(data->>'bedrooms','')::numeric     AS bedrooms,
    md5(coalesce(data->'location'->>'district','') || '|' ||
        public.wassell_canon_property_type(data->>'property_type') || '|' ||
        coalesce(round(nullif(data->>'price','')::numeric)::text,'') || '|' ||
        coalesce(round(nullif(data->>'area','')::numeric)::text,'') || '|' ||
        coalesce(data->>'bedrooms','') || '|' ||
        coalesce(round(nullif(data->>'latitude','')::numeric, 4)::text,'') || '|' ||
        coalesce(round(nullif(data->>'longitude','')::numeric, 4)::text,'')
    ) AS fingerprint
  FROM public.records
  WHERE model_id = v_market_model_id
    AND coalesce(data->>'listing_type','sale') = 'sale'
    AND nullif(data->>'price','')::numeric > 0
    AND nullif(data->>'area','')::numeric > 0
    AND nullif(data->>'price_per_m2','')::numeric > 0
    AND (data->'location'->>'district') IS NOT NULL;

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

  -- INSERT 1 — 'all' bedrooms grain (one row per district × canon_type).
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

  -- INSERT 2 — bedrooms split grain (only where bedrooms known: bucket <> 'all').
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

  -- ===================== OUR_VERIFIED (our_projects' units) =================
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

  -- ===================== TRANSACTION =======================================
  -- No transaction source is connected yet (market_listings.sold_at is empty and
  -- no Paseetah table exists in this DB). Schema + readers are transaction-ready;
  -- when a transaction feed lands, add an INSERT … source_type='transaction' here.

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
$$;

COMMENT ON FUNCTION public.wassell_refresh_market_benchmarks() IS
  'Rebuild market_benchmarks for today from market_listings (asking) + our units (our_verified). SECURITY DEFINER — counts all rows. Returns the all-grain asking segment count.';

COMMIT;
