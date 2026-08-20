-- Field-specific sample listing URLs. When p_canonical_field is a real
-- market_listings column, return one listing per DISTINCT value of that column
-- (varied real examples) with the value alongside, so the operator opens ads that
-- actually show the field taking different values. Otherwise recent generic listings.
-- Return type changes (adds field_value) → drop the old signature first.
-- Applied to prod 2026-08-19.
DROP FUNCTION IF EXISTS public.market_listing_sample_urls(text, int);

CREATE OR REPLACE FUNCTION public.market_listing_sample_urls(
  p_platform text DEFAULT 'aqar',
  p_limit int DEFAULT 6,
  p_canonical_field text DEFAULT NULL
) RETURNS TABLE(source_url text, field_value text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_col text;
  v_lim int := least(greatest(coalesce(p_limit, 6), 1), 20);
BEGIN
  IF nullif(p_canonical_field, '') IS NOT NULL THEN
    SELECT column_name INTO v_col FROM information_schema.columns
    WHERE table_schema='public' AND table_name='market_listings' AND column_name = p_canonical_field;
  END IF;

  IF v_col IS NOT NULL THEN
    -- One listing per distinct value of the column → the operator sees varied values.
    RETURN QUERY EXECUTE format(
      'SELECT DISTINCT ON (m.%1$I) m.source_url, m.%1$I::text
         FROM public.market_listings m
        WHERE m.source = %2$L AND m.source_url IS NOT NULL AND m.source_url <> ''''
          AND m.%1$I IS NOT NULL
        ORDER BY m.%1$I, m.updated_at DESC
        LIMIT %3$s', v_col, p_platform, v_lim);
  ELSE
    RETURN QUERY
      SELECT m.source_url, NULL::text
      FROM public.market_listings m
      WHERE m.source = p_platform AND m.source_url IS NOT NULL AND m.source_url <> ''
      ORDER BY m.updated_at DESC
      LIMIT v_lim;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.market_listing_sample_urls(text, int, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_sample_urls(text, int, text) TO authenticated, service_role;
