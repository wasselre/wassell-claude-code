-- ============================================================================
-- The 22 September ad batch is TWO per project, not five. 2026-09-20.
--
-- Operator decision, after the capacity audit that day. September was started
-- on the 20th for a first batch on the 22nd — two working days of runway
-- against a template that assumes ten (`lead_time_working_days`). Fifteen
-- creatives plus the Tuesday row is 18 design units due ready on Mon 21, and
-- one designer at five a day has ten. Measured: that batch stays unreachable
-- at 5, 6 and even 8 designs a day, and only opens at 9 — it is a two-day
-- WINDOW, not a shortage of throughput, so no rate fixes it.
--
-- The honest answer to a batch with too little runway is a SMALLER batch. Six
-- creatives on the 22nd (2 x 3 projects), full slates of five from the 29th on.
-- Every other date is untouched.
--
-- `creative_overrides` is read by `creativesFor` / `slateOverridesFor` and
-- reaches the engine as `PaidPolicy.slateOn`. It lives in the DATABASE, beside
-- the month's other one-off starts, so the decision survives a reload and
-- reaches the confirm — a draft held in a browser would not.
-- ============================================================================

BEGIN;

UPDATE public.mos_month_template
   SET month_starts = jsonb_set(
         month_starts,
         '{2026-09,creative_overrides}',
         jsonb_build_array(jsonb_build_object('batch_day', '2026-09-22', 'creatives', 2)),
         true),
       updated_at = now()
 WHERE month_starts ? '2026-09';

DO $$
DECLARE v jsonb;
BEGIN
  SELECT month_starts -> '2026-09' -> 'creative_overrides' INTO v
    FROM public.mos_month_template LIMIT 1;
  IF v IS NULL OR jsonb_array_length(v) <> 1
     OR v -> 0 ->> 'batch_day' <> '2026-09-22'
     OR (v -> 0 ->> 'creatives')::int <> 2 THEN
    RAISE EXCEPTION 'MOS:SEPT22_OVERRIDE_NOT_SET got %', v;
  END IF;
END $$;

COMMIT;
