-- ============================================================================
-- One-off month starts — September 2026. 2026-09-17.
--
-- Operator, for the first real month (the test month was deleted the same day
-- and September re-chosen from empty): the first organic batch is Tuesday
-- 22 September, the first ad batch is Sunday 20 September, and ads do not wait
-- for a batch day — each goes live the moment it is ready.
--
-- `month_starts` is keyed 'YYYY-MM'; the month compiler (monthGeometry) and the
-- Meta build (ensureMonthMetaCampaigns) read it. Other months follow the
-- template untouched.
-- ============================================================================

BEGIN;

ALTER TABLE public.mos_month_template
  ADD COLUMN IF NOT EXISTS month_starts jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.mos_month_template.month_starts IS
  'One-off starts per month, keyed YYYY-MM: {organic_from, paid_from, ads_live_when_ready}. Read by monthGeometry and ensureMonthMetaCampaigns.';

UPDATE public.mos_month_template
   SET month_starts = month_starts || jsonb_build_object('2026-09', jsonb_build_object(
         'organic_from', '2026-09-22',
         'paid_from', '2026-09-20',
         'ads_live_when_ready', true)),
       updated_at = now();

COMMIT;
