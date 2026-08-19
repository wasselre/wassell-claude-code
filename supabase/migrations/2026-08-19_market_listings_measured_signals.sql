-- App-side computation of the market_listings "measured" signals (مؤشرات مقاسة).
-- Principle: the ingest adapter only MATCHES extracted fields; every DERIVED value
-- is computed by the app. Supersedes the earlier price_per_m2-only trigger.
--   * BEFORE trigger  → scalar signals from row columns
--       (price_per_m2, description_char_count, description_word_count,
--        basic_info_completed_count)
--   * AFTER trigger   → basic_info_missing_keys junction
--   * junction trigger→ feature_count from market_listings__features
-- Basic-info set: price, area, bedrooms, bathrooms, property_type/category, title,
-- district (from the location geo field).
--
-- Applied to prod (wassell-prod) 2026-08-19. Verified: villa 7/7, land 4/7
-- (missing bedrooms/bathrooms/district). NOTE: text[] || 'literal' mis-resolves,
-- so the junction builder uses array_append.

CREATE OR REPLACE FUNCTION public.market_listings_fill_signals()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp' AS $$
DECLARE
  txt  text := coalesce(nullif(btrim(NEW.description_ar), ''), nullif(btrim(NEW.description), ''), '');
  dist text := (public.try_jsonb(NEW.location)) ->> 'district';
  n int := 0;
BEGIN
  NEW.price_per_m2 := CASE WHEN NEW.price IS NOT NULL AND NEW.area IS NOT NULL AND NEW.area > 0
                          THEN round(NEW.price / NEW.area) ELSE NULL END;
  NEW.description_char_count := char_length(txt);
  NEW.description_word_count := CASE WHEN txt = '' THEN 0
                                    ELSE array_length(regexp_split_to_array(txt, '\s+'), 1) END;
  IF NEW.price IS NOT NULL AND NEW.price > 0 THEN n := n + 1; END IF;
  IF NEW.area  IS NOT NULL AND NEW.area  > 0 THEN n := n + 1; END IF;
  IF NEW.bedrooms  IS NOT NULL THEN n := n + 1; END IF;
  IF NEW.bathrooms IS NOT NULL THEN n := n + 1; END IF;
  IF coalesce(nullif(NEW.property_type, ''), nullif(NEW.category, '')) IS NOT NULL THEN n := n + 1; END IF;
  IF coalesce(nullif(NEW.title, ''), '') <> '' THEN n := n + 1; END IF;
  IF coalesce(nullif(dist,  ''), '') <> '' THEN n := n + 1; END IF;
  NEW.basic_info_completed_count := n;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS market_listings_price_per_m2 ON public.market_listings;
DROP TRIGGER IF EXISTS market_listings_signals ON public.market_listings;
CREATE TRIGGER market_listings_signals
  BEFORE INSERT OR UPDATE OF price, area, bedrooms, bathrooms, property_type, category, title, location, description, description_ar
  ON public.market_listings FOR EACH ROW EXECUTE FUNCTION public.market_listings_fill_signals();

CREATE OR REPLACE FUNCTION public.market_listings_fill_missing_keys()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp' AS $$
DECLARE
  dist text := (public.try_jsonb(NEW.location)) ->> 'district';
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NEW.price IS NULL OR NEW.price <= 0 THEN missing := array_append(missing, 'price'); END IF;
  IF NEW.area  IS NULL OR NEW.area  <= 0 THEN missing := array_append(missing, 'area'); END IF;
  IF NEW.bedrooms  IS NULL THEN missing := array_append(missing, 'bedrooms'); END IF;
  IF NEW.bathrooms IS NULL THEN missing := array_append(missing, 'bathrooms'); END IF;
  IF coalesce(nullif(NEW.property_type, ''), nullif(NEW.category, '')) IS NULL THEN missing := array_append(missing, 'property_type'); END IF;
  IF coalesce(nullif(NEW.title, ''), '') = '' THEN missing := array_append(missing, 'title'); END IF;
  IF coalesce(nullif(dist,  ''), '') = '' THEN missing := array_append(missing, 'district'); END IF;
  DELETE FROM public.market_listings__basic_info_missing_keys WHERE record_id = NEW.id;
  IF array_length(missing, 1) > 0 THEN
    INSERT INTO public.market_listings__basic_info_missing_keys (record_id, value)
    SELECT NEW.id, unnest(missing);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS market_listings_missing_keys ON public.market_listings;
CREATE TRIGGER market_listings_missing_keys
  AFTER INSERT OR UPDATE OF price, area, bedrooms, bathrooms, property_type, category, title, location
  ON public.market_listings FOR EACH ROW EXECUTE FUNCTION public.market_listings_fill_missing_keys();

CREATE OR REPLACE FUNCTION public.market_listings_recount_features()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp' AS $$
DECLARE rid uuid := coalesce(NEW.record_id, OLD.record_id);
BEGIN
  UPDATE public.market_listings
     SET feature_count = (SELECT count(*) FROM public.market_listings__features WHERE record_id = rid)
   WHERE id = rid;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS market_listings_feature_count ON public.market_listings__features;
CREATE TRIGGER market_listings_feature_count
  AFTER INSERT OR DELETE OR UPDATE ON public.market_listings__features
  FOR EACH ROW EXECUTE FUNCTION public.market_listings_recount_features();
