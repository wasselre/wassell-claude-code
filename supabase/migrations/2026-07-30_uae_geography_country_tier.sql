-- UAE geography, step 1 of 3: the country tier's DATA (safe with the live SPA).
--
-- The location cascade is already country → region → city → district (every
-- `location` field carries all four levels), but the `region` level has no
-- parent_link_field and `regions` has no link to `countries` — so the cascade takes
-- its "no parent link → show all candidates" path. With one country that was
-- invisible; the moment UAE emirates land in `regions`, picking السعودية would list
-- the 7 emirates too.
--
-- This migration adds ONLY the column + the UAE country row + the backfill. It
-- deliberately does NOT add `country_lookup` to the frozen model's JSONB schema:
-- the cascade auto-detects a parent link by scanning the child model's schema for a
-- lookup pointing at the parent's model, so publishing the field before the SPA fix
-- is deployed would immediately filter the region list by country — and 64k existing
-- records (all_projects, market_listings, real_estate_offices) carry region/city/
-- district with NO `country` key, so their region step would render empty.
--
-- Order of operations: this file → deploy the LocationCascadeField default-fallback
-- fix → `2026-07-30b_uae_geography_cascade_country_link.sql`.

BEGIN;

-- ── 1. DDL on the frozen table ───────────────────────────────────────────────
ALTER TABLE public.regions ADD COLUMN IF NOT EXISTS country_lookup text;
CREATE INDEX IF NOT EXISTS regions_country_lookup_idx ON public.regions (country_lookup);

-- ── 2. The UAE country row (countries is unfrozen → plain records insert) ────
INSERT INTO public.records (id, model_id, created_by_user_id, data)
VALUES (
  'd15a0003-0000-4000-8000-000000000002',
  'd15a0001-0000-4000-8000-000000000003',
  NULL,
  jsonb_build_object(
    'name_ar', 'الإمارات العربية المتحدة',
    'name_en', 'United Arab Emirates',
    'display_name', 'الإمارات',
    'iso_code', 'AE',
    'is_active', true
  )
)
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;

-- ── 3. Backfill the existing Saudi regions ──────────────────────────────────
UPDATE public.regions
SET country_lookup = 'd15a0003-0000-4000-8000-000000000001'
WHERE coalesce(country_code, 'SA') = 'SA' AND country_lookup IS NULL;

-- Fail loudly rather than leaving a region that can never appear under any country.
DO $$
DECLARE v_unlinked int;
BEGIN
  SELECT count(*) INTO v_unlinked FROM public.regions WHERE country_lookup IS NULL;
  IF v_unlinked > 0 THEN
    RAISE EXCEPTION '% region(s) still have no country_lookup', v_unlinked;
  END IF;
END $$;

COMMIT;
