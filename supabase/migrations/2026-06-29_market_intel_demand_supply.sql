-- ============================================================================
-- Market Intelligence — demand × supply precompute layer
-- ============================================================================
-- Overlays CRM client DEMAND (active leads' preferences) on market + Wassel SUPPLY,
-- per (district × canonical type × budget bucket). This is the brokerage-specific
-- signal nobody else can compute: we hold both sides.
--
-- Demand atoms per ACTIVE client come from the UNION of:
--   • location.district[] ids
--   • preferred_projects[] → that project's location.district  (richest signal: 248 clients)
-- crossed with canon(preferred_unit_type[]) (or 'all' when unknown) and the client's
-- budget bucket. Demand is intentionally counted as DISTINCT clients.
--
-- DEMAND DATA IS CURRENTLY THIN (most clients lack structured prefs). The
-- confidence_grade reflects that honestly; the UI shows "thin demand" warnings.
-- SECURITY DEFINER so it counts all clients/projects regardless of caller RLS.
-- ============================================================================

BEGIN;

-- Budget bucket helper (mirrored in src/lib/market/format.ts budgetBucket — keep in sync).
CREATE OR REPLACE FUNCTION public.wassell_budget_bucket(p_val numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_val IS NULL OR p_val <= 0 THEN 'all'
    WHEN p_val < 1000000 THEN '<1M'
    WHEN p_val < 2000000 THEN '1-2M'
    WHEN p_val < 3000000 THEN '2-3M'
    WHEN p_val < 5000000 THEN '3-5M'
    ELSE '5M+'
  END;
$$;

CREATE TABLE IF NOT EXISTS public.market_demand_supply_benchmarks (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date               date NOT NULL DEFAULT CURRENT_DATE,
  region_id                   text,
  city_id                     text,
  city_name                   text,
  district_id                 text,
  district_name               text,
  district_name_en            text,
  property_type               text NOT NULL,        -- canonical, or 'all'
  budget_bucket               text NOT NULL DEFAULT 'all',
  bedrooms_bucket             text NOT NULL DEFAULT 'all',
  active_client_count         integer NOT NULL DEFAULT 0,
  matching_market_listing_count integer NOT NULL DEFAULT 0,
  matching_our_project_count  integer NOT NULL DEFAULT 0,
  matching_all_project_count  integer NOT NULL DEFAULT 0,
  undersupply_score           numeric NOT NULL DEFAULT 0,
  sales_priority_score        numeric NOT NULL DEFAULT 0,
  acquisition_priority_score  numeric NOT NULL DEFAULT 0,
  confidence_grade            text NOT NULL DEFAULT 'low',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_demand_supply_segment
  ON public.market_demand_supply_benchmarks (snapshot_date, property_type, budget_bucket, coalesce(district_id,''));
CREATE INDEX IF NOT EXISTS idx_demand_supply_district ON public.market_demand_supply_benchmarks (district_id);
CREATE INDEX IF NOT EXISTS idx_demand_supply_city ON public.market_demand_supply_benchmarks (city_id);
CREATE INDEX IF NOT EXISTS idx_demand_supply_acq ON public.market_demand_supply_benchmarks (acquisition_priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_demand_supply_sales ON public.market_demand_supply_benchmarks (sales_priority_score DESC);

ALTER TABLE public.market_demand_supply_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demand_supply_read ON public.market_demand_supply_benchmarks;
CREATE POLICY demand_supply_read ON public.market_demand_supply_benchmarks
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.market_demand_supply_benchmarks TO authenticated;

CREATE OR REPLACE FUNCTION public.wassell_refresh_demand_supply()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clients_model uuid := '2e86f197-385f-4853-908f-b4cb7237f7d8';
  v_all_proj uuid := '220c49b9-de57-492d-9eca-c0d9f54fd40f';
  v_our_proj uuid := '6609286a-f95a-45db-94e6-48cfa915ccbd';
  v_today date := CURRENT_DATE;
  v_written int := 0;
BEGIN
  DELETE FROM public.market_demand_supply_benchmarks WHERE snapshot_date = v_today;

  -- Active clients (drop dead leads).
  CREATE TEMP TABLE _active ON COMMIT DROP AS
  SELECT id, data FROM public.records
  WHERE model_id = v_clients_model
    AND coalesce(data->>'client_status','') NOT IN ('غير مهتم','غير مؤهل','تم الإفراغ','تم البيع','مرفوض');

  -- Demand districts per client (location cascade ∪ preferred_projects' district).
  CREATE TEMP TABLE _client_district ON COMMIT DROP AS
  SELECT DISTINCT client_id, district_id FROM (
    SELECT c.id AS client_id, jsonb_array_elements_text(c.data->'location'->'district') AS district_id
    FROM _active c WHERE jsonb_typeof(c.data->'location'->'district') = 'array'
    UNION
    SELECT c.id, (p.data->'location'->>'district')
    FROM _active c
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(c.data->'preferred_projects')='array' THEN c.data->'preferred_projects' ELSE '[]'::jsonb END) pid
    JOIN public.records p ON p.id = pid::uuid AND p.model_id = v_all_proj
    WHERE p.data->'location'->>'district' IS NOT NULL
  ) s
  WHERE district_id IS NOT NULL AND district_id <> '';

  -- Demand types per client (canon). Absent → no rows (handled via 'all' below).
  CREATE TEMP TABLE _client_type ON COMMIT DROP AS
  SELECT DISTINCT c.id AS client_id,
         public.wassell_canon_property_type(jsonb_array_elements_text(c.data->'preferred_unit_type')) AS canon_type
  FROM _active c WHERE jsonb_typeof(c.data->'preferred_unit_type') = 'array';

  -- One budget bucket per client.
  CREATE TEMP TABLE _client_budget ON COMMIT DROP AS
  SELECT id AS client_id,
         public.wassell_budget_bucket(nullif(data->'budget'->>'max','')::numeric) AS budget_bucket
  FROM _active;

  -- Demand atoms: client × district × (its types, or 'all') × budget bucket.
  CREATE TEMP TABLE _atoms ON COMMIT DROP AS
  SELECT cd.client_id, cd.district_id,
         coalesce(ct.canon_type, 'all') AS property_type,
         coalesce(cb.budget_bucket, 'all') AS budget_bucket
  FROM _client_district cd
  LEFT JOIN _client_type ct ON ct.client_id = cd.client_id
  LEFT JOIN _client_budget cb ON cb.client_id = cd.client_id;

  -- Supply: market (from benchmarks), our_projects, all_projects per district×type.
  INSERT INTO public.market_demand_supply_benchmarks (
    snapshot_date, region_id, city_id, city_name, district_id, district_name, district_name_en,
    property_type, budget_bucket, active_client_count,
    matching_market_listing_count, matching_our_project_count, matching_all_project_count,
    undersupply_score, sales_priority_score, acquisition_priority_score, confidence_grade)
  SELECT
    v_today, max(dr.region_id), max(dr.city_id), max(dr.city_name_ar), a.district_id,
    max(coalesce(dr.name_ar, dr.display_name)), max(dr.name_en),
    a.property_type, a.budget_bucket,
    count(DISTINCT a.client_id) AS active_client_count,
    coalesce(mk.listing_count, 0),
    coalesce(op.our_count, 0),
    coalesce(ap.all_count, 0),
    round(count(DISTINCT a.client_id)::numeric / (coalesce(op.our_count,0) + 1), 2) AS undersupply_score,
    (CASE WHEN coalesce(op.our_count,0) > 0 THEN count(DISTINCT a.client_id) ELSE 0 END)::numeric AS sales_priority_score,
    (CASE WHEN coalesce(op.our_count,0) = 0 AND coalesce(mk.listing_count,0) >= 10
          THEN count(DISTINCT a.client_id) ELSE round(count(DISTINCT a.client_id) * 0.4, 1) END)::numeric AS acquisition_priority_score,
    CASE WHEN count(DISTINCT a.client_id) >= 8 THEN 'high'
         WHEN count(DISTINCT a.client_id) >= 3 THEN 'medium' ELSE 'low' END
  FROM _atoms a
  LEFT JOIN public.districts dr ON dr.id = a.district_id::uuid
  -- market supply: deduped asking listings for the district (type-specific, or sum for 'all')
  LEFT JOIN LATERAL (
    SELECT sum(b.deduped_count)::int AS listing_count
    FROM public.market_benchmarks b
    WHERE b.snapshot_date = v_today AND b.source_type = 'asking' AND b.bedrooms_bucket = 'all'
      AND b.district_id = a.district_id
      AND (a.property_type = 'all' OR b.property_type = a.property_type)
  ) mk ON true
  -- our supply: our_projects whose linked all_projects sits in this district
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT o.id)::int AS our_count
    FROM public.records o
    JOIN public.records p ON (
      (jsonb_typeof(o.data->'project')='array' AND jsonb_exists(o.data->'project', p.id::text))
      OR o.data->>'project' = p.id::text)
    WHERE o.model_id = v_our_proj AND p.model_id = v_all_proj
      AND p.data->'location'->>'district' = a.district_id
  ) op ON true
  -- all-catalog supply: all_projects in this district
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS all_count
    FROM public.records p2
    WHERE p2.model_id = v_all_proj AND p2.data->'location'->>'district' = a.district_id
  ) ap ON true
  GROUP BY a.district_id, a.property_type, a.budget_bucket, mk.listing_count, op.our_count, ap.all_count;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END;
$$;

COMMENT ON FUNCTION public.wassell_refresh_demand_supply() IS
  'Rebuild market_demand_supply_benchmarks: active client demand × market/our/all supply per district×type×budget. SECURITY DEFINER. Returns segment count.';

COMMIT;
