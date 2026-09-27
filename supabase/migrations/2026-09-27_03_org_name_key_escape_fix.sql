-- ============================================================================
-- mkt_org_name_key: correct the diacritic regex as deployed (2026-09-27)
-- ----------------------------------------------------------------------------
-- 2026-09-27_02 is correct on disk, but when it was applied to production the
-- regex was sent with a DOUBLED backslash ('[\\u064B-…]'), so the deployed
-- function matched a literal backslash instead of Arabic diacritics:
-- mkt_org_name_key('رِيفَا') returned 'رِيفَا' instead of 'ريفا'. No data was
-- affected — the only marketer linked (ريفا) has no diacritics. This re-emits
-- the function exactly as 2026-09-27_02 defines it, so production matches the
-- file. Idempotent; a fresh database replaying _02 is already correct.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mkt_org_name_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace(
             translate(regexp_replace(coalesce(p, ''), '[\u064B-\u0652\u0640]', '', 'g'),  -- harakat U+064B..U+0652 + tatweel U+0640
                       'أإآةى', 'اااهي'),
             '(للتسويق العقاري|التسويق العقاري|للتسويق|العقاريه|العقاري|شركه|مؤسسه)', '', 'g'),
           '[[:space:]_.،,|-]+', '', 'g');
$$;

DO $assert$
BEGIN
  IF public.mkt_org_name_key('رِيفَا العقارية') IS DISTINCT FROM 'ريفا' THEN
    RAISE EXCEPTION 'ORG_NAME_KEY_BROKEN: got %', public.mkt_org_name_key('رِيفَا العقارية');
  END IF;
END $assert$;
