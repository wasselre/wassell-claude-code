-- ============================================================================
-- geo_elements.country_code — make the anchor layer country-aware
-- ============================================================================
-- As of 2026-07-30 `geo_elements` holds TWO countries: 2,484 active Saudi anchors
-- (Riyadh 2026-06-30 + the 20-city build) and 3,237 UAE anchors. Country existed
-- ONLY inside the `raw` JSONB blob — not a column, not indexed, and not returned
-- or filterable by `wassell_search_geo_elements`. So an unscoped element search
-- mixed Dubai and Riyadh, and a Saudi client could be given a Dubai anchor.
--
-- This is the element-layer twin of the district-resolution problem already fixed
-- for `cities.country_code` / `districts.country_code` (see rankGeoCandidates in
-- api/_lib/matchAgent.ts). Same remedy, same shape: a plain text ISO-2 column that
-- can be equality-checked on the row already fetched, NOT a join up to a countries
-- table.
--
-- Backfilled from `raw->>'country'`, which every row carries and which is set by
-- the dataset builders. Rows with an unrecognised value are left NULL rather than
-- guessed — a NULL is visible and fixable; a wrong country is neither.
-- ============================================================================

BEGIN;

ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS country_code text;

UPDATE public.geo_elements
   SET country_code = CASE raw->>'country'
     WHEN 'Saudi Arabia'         THEN 'SA'
     WHEN 'United Arab Emirates' THEN 'AE'
     ELSE NULL
   END
 WHERE country_code IS DISTINCT FROM CASE raw->>'country'
     WHEN 'Saudi Arabia'         THEN 'SA'
     WHEN 'United Arab Emirates' THEN 'AE'
     ELSE NULL
   END;

CREATE INDEX IF NOT EXISTS geo_elements_country_code_idx
  ON public.geo_elements (country_code) WHERE country_code IS NOT NULL;

COMMENT ON COLUMN public.geo_elements.country_code IS
  'ISO-3166-1 alpha-2 of the anchor''s country, derived from the source dataset''s '
  '`country` field. Used to keep element search inside one country; NULL means the '
  'source country was unrecognised and the row should be investigated, not defaulted.';

-- Keep it filled on every future import. The importer already receives `country`
-- in each row; this just promotes it out of the raw blob into the column.
CREATE OR REPLACE FUNCTION public.wassell_geo_elements_set_country()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.country_code IS NULL THEN
    NEW.country_code := CASE NEW.raw->>'country'
      WHEN 'Saudi Arabia'         THEN 'SA'
      WHEN 'United Arab Emirates' THEN 'AE'
      ELSE NULL
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS geo_elements_set_country ON public.geo_elements;
CREATE TRIGGER geo_elements_set_country
  BEFORE INSERT OR UPDATE OF raw, country_code ON public.geo_elements
  FOR EACH ROW EXECUTE FUNCTION public.wassell_geo_elements_set_country();

COMMIT;
