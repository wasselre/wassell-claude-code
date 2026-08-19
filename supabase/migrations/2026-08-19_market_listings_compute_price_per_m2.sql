-- price_per_m2 is a DERIVED value (price ÷ area). Computing it in the scraper/
-- adapter is a separation-of-concerns leak — the app (server) should own it, the
-- same way project rollups are trigger-computed. This BEFORE trigger fills it on
-- every write regardless of the write path (record_save / market_listing_merge /
-- direct), so the adapter never sets it. Existing values are already price÷area
-- (the old adapter computed the same), so no backfill is needed.
--
-- Applied to prod (wassell-prod) 2026-08-19.

CREATE OR REPLACE FUNCTION public.market_listings_fill_price_per_m2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.price_per_m2 := CASE
    WHEN NEW.price IS NOT NULL AND NEW.area IS NOT NULL AND NEW.area > 0
    THEN round(NEW.price / NEW.area)
    ELSE NULL
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS market_listings_price_per_m2 ON public.market_listings;
CREATE TRIGGER market_listings_price_per_m2
  BEFORE INSERT OR UPDATE OF price, area ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public.market_listings_fill_price_per_m2();
