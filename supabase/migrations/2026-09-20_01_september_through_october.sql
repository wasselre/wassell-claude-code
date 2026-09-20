-- ============================================================================
-- September 2026 runs THROUGH October as one plan. 2026-09-20.
--
-- Operator, on the 20th with ten days of September left: "We will do September
-- and October. The tasks should be scheduled for the entire month of September
-- and October, just like it's one month, but it's not one." And: "For this
-- month only, the first ad batch will be on Tuesday instead of Sunday" — so the
-- first organic batch and the first ad batch land on the same day, Tue 22 Sep,
-- which is 3 posts + 5 ad designs = 8 designs.
--
-- Both are DATA in `mos_month_template.month_starts`, keyed 'YYYY-MM':
--
--   organic_from 2026-09-22  the first row publishes Tuesday (unchanged)
--   paid_from    2026-09-22  WAS 2026-09-20. It now also ANCHORS the weekly ad
--                            rhythm, so the batches are 22 + 29 Sep and 6, 13,
--                            20, 27 Oct — every one a Tuesday. (With no
--                            operator start the anchor is the week's Sunday, so
--                            every other month is untouched.)
--   through      2026-10     the cycle runs eight whole weeks, Sun 6 Sep →
--                            Sat 31 Oct, contiguous, as ONE plan. October is
--                            then NOT planned separately: `monthCoveredBy`
--                            hands it to September and both `month_compile`
--                            and `month_confirm` refuse it.
--   ads_live_when_ready      unchanged: each ad goes live when it is approved.
--
-- It changes NO money. `budget_per_project` stays a monthly figure over a
-- longer window and the page says so — prorating or doubling it here would be
-- the app making a spending decision for the operator.
-- ============================================================================

BEGIN;

UPDATE public.mos_month_template
   SET month_starts = month_starts || jsonb_build_object('2026-09', jsonb_build_object(
         'organic_from', '2026-09-22',
         'paid_from', '2026-09-22',
         'ads_live_when_ready', true,
         'through', '2026-10')),
       updated_at = now();

DO $$
DECLARE v jsonb;
BEGIN
  SELECT month_starts -> '2026-09' INTO v FROM public.mos_month_template LIMIT 1;
  IF v IS NULL
     OR v ->> 'paid_from' <> '2026-09-22'
     OR v ->> 'organic_from' <> '2026-09-22'
     OR v ->> 'through' <> '2026-10'
     OR (v ->> 'ads_live_when_ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'MOS:MONTH_STARTS_NOT_SET got %', v;
  END IF;
END $$;

COMMIT;
