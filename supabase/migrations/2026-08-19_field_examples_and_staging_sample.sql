-- Market-automation: make decisions evidence-backed.
--   (A) source_field_catalog_observe — the scraper reports real per-field example
--       values every run, so the decision drawer shows real, current examples for
--       ALL fields (was: only 20 of 94, seeded once and never refreshed).
--   (C) market_listing_staging_sample — return real staged values + their current
--       live value for a field, so the operator can SEE how data lands in a column
--       before releasing it.
-- Catalog is evidence only (gate-a §11) — these NEVER touch source_field_mappings.
-- Applied to prod (wassell-prod) 2026-08-19.

-- (A) Merge a batch of field observations into the catalog. Unions example_values
-- (capped at 15 distinct), bumps occurrence_count, refreshes raw_data_type/last_seen.
CREATE OR REPLACE FUNCTION public.source_field_catalog_observe(p_platform text, p_observations jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n int := 0; v_obs jsonb; v_path text;
BEGIN
  FOR v_obs IN SELECT value FROM jsonb_array_elements(p_observations) LOOP
    v_path := v_obs->>'source_path';
    CONTINUE WHEN v_path IS NULL OR v_path = '';
    INSERT INTO public.source_field_catalog AS c
      (id, platform, adapter_id, contract_version, source_path, raw_data_type,
       example_values, occurrence_count, first_seen, last_seen)
    VALUES (gen_random_uuid(), p_platform, 'market-ingest/adapters/'||p_platform, 'v001', v_path,
            nullif(v_obs->>'raw_data_type',''), coalesce(v_obs->'examples', '[]'::jsonb),
            coalesce((v_obs->>'count')::bigint, 1), now(), now())
    ON CONFLICT (platform, source_path, contract_version) DO UPDATE SET
      raw_data_type = coalesce(nullif(EXCLUDED.raw_data_type,''), c.raw_data_type),
      example_values = (
        SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
          SELECT e FROM (
            SELECT jsonb_array_elements(coalesce(c.example_values, '[]'::jsonb)) AS e
            UNION
            SELECT jsonb_array_elements(coalesce(EXCLUDED.example_values, '[]'::jsonb)) AS e
          ) u LIMIT 15
        ) capped
      ),
      occurrence_count = coalesce(c.occurrence_count, 0) + coalesce(EXCLUDED.occurrence_count, 1),
      last_seen = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.source_field_catalog_observe(text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.source_field_catalog_observe(text, jsonb) TO service_role;

-- (C) Sample real staged values for a field + the current live column value.
CREATE OR REPLACE FUNCTION public.market_listing_staging_sample(p_canonical_field text, p_limit int DEFAULT 8)
RETURNS TABLE(staged text, live text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_col text; v_lim int := least(greatest(coalesce(p_limit, 8), 1), 50);
BEGIN
  SELECT column_name INTO v_col FROM information_schema.columns
  WHERE table_schema='public' AND table_name='market_listings' AND column_name = p_canonical_field;
  IF v_col IS NULL THEN RAISE EXCEPTION 'not a market_listings column: %', p_canonical_field; END IF;
  RETURN QUERY EXECUTE format(
    'SELECT s.data->>%L, m.%I::text FROM public.market_listing_staging s
       JOIN public.market_listings m ON m.id = s.record_id
      WHERE s.data ? %L LIMIT %s',
    p_canonical_field, v_col, p_canonical_field, v_lim);
END $$;

REVOKE ALL ON FUNCTION public.market_listing_staging_sample(text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_staging_sample(text, int) TO authenticated, service_role;
