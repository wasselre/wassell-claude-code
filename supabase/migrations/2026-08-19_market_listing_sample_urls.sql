-- Sample real listing URLs so the cockpit's decision drawer can link to actual
-- source pages (Aqar/any platform) — the operator opens a real ad to see the field
-- in context. Listing URLs are public, so SECURITY DEFINER (avoids per-scope RLS
-- returning zero). Recent non-empty URLs for the platform. Applied to prod 2026-08-19.
CREATE OR REPLACE FUNCTION public.market_listing_sample_urls(p_platform text DEFAULT 'aqar', p_limit int DEFAULT 6)
RETURNS TABLE(source_url text)
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT m.source_url FROM public.market_listings m
  WHERE m.source = p_platform AND m.source_url IS NOT NULL AND m.source_url <> ''
  ORDER BY m.updated_at DESC
  LIMIT least(greatest(coalesce(p_limit, 6), 1), 20);
$$;

REVOKE ALL ON FUNCTION public.market_listing_sample_urls(text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_sample_urls(text, int) TO authenticated, service_role;
