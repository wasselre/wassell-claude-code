-- 2026-10-05 — The weekly paid rule: five new a week, keep the best of last week.
--
-- Operator, 2026-10-04: "we launch 5 ads per week, and every week we stop. We
-- only keep one ad from the last batch, which is the best ad, and then stop the
-- others." In the September–October plan no ad was ever stopped:
--   • the weekly decision waited for the marketing manager to confirm it
--     (planning.auto_apply_default_decision = false) and its three tasks sat
--     open from 28 Sep;
--   • the ranking kept every ad it could not "judge" (≥ SAR 101 and ≥ 2,000
--     impressions in its own week), and with a project's budget split over 5–7
--     ads almost none could be judged — the default was "keep everything";
--   • mos_settings.meta_auto_ad.status = 'ACTIVE' created every ad LIVE the
--     minute its design was approved, outside the weekly batches, so the swap
--     (which only pauses as many as it activates from ready slots) had nothing
--     to swap. Live designs reached 7 / 6 / 5 per project.
--
-- The rule now lives in the worker (worker/src/marketing/weeklySlate.ts,
-- reconcileWeeklySlates in worker/src/runRefreshCycleJob.ts). This file only
-- switches it on:
--   1. planning.weekly_rule = 'keep_best_of_last_batch' — the refresh lane runs
--      the weekly rule INSTEAD of the ranking swap and stops opening decision
--      tasks (it closes the open ones itself).
--   2. meta_auto_ad.status removed — an approved design's ad is created PAUSED
--      (planning.ads_created_paused = true) and goes live on its batch day; one
--      approved after its batch day goes live on the next round (≤ 5 minutes).
--
-- APPLY ORDER: after the worker carrying reconcileWeeklySlates is deployed. An
-- older worker ignores weekly_rule and would keep the ranking swap running.
-- Nothing here raises SQLSTATE 40001/40P01.
BEGIN;

UPDATE public.mos_settings
   SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object('weekly_rule', 'keep_best_of_last_batch'),
       updated_at = now()
 WHERE key = 'planning';

UPDATE public.mos_settings
   SET value = COALESCE(value, '{}'::jsonb) - 'status',
       updated_at = now()
 WHERE key = 'meta_auto_ad';

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.mos_settings WHERE key = 'planning')
     AND (SELECT value ->> 'weekly_rule' FROM public.mos_settings WHERE key = 'planning')
         IS DISTINCT FROM 'keep_best_of_last_batch' THEN
    RAISE EXCEPTION 'WEEKLY_RULE: planning.weekly_rule was not set';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mos_settings WHERE key = 'meta_auto_ad' AND value ? 'status') THEN
    RAISE EXCEPTION 'WEEKLY_RULE: meta_auto_ad.status still forces new ads live';
  END IF;
END $assert$;

COMMIT;
