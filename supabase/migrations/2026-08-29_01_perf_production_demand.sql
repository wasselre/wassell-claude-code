-- Production-demand correction + video-capacity ceiling.
--
-- Two independent notions the reporting had conflated:
--   • Distribution demand = every required platform placement (sum across platforms).
--   • Production demand    = unique creatives to produce (max across platforms,
--                            because the same video is reused on every platform).
-- Publishing runs 7 days/week; production runs across N working days/week
-- (default 6). This adds that working-days config and lifts BOTH producer roles'
-- VIDEO capacity to a ceiling of 4/working-day (weekly 24 ≥ required 21).
-- Posts are left as-is (already ≥ 7/week for every producer).

BEGIN;

-- 1. Working (production) days per week — the denominator for weekly capacity.
ALTER TABLE public.mos_perf_settings
  ADD COLUMN IF NOT EXISTS production_days_per_week integer NOT NULL DEFAULT 6;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_perf_settings_prod_days_chk') THEN
    ALTER TABLE public.mos_perf_settings
      ADD CONSTRAINT mos_perf_settings_prod_days_chk
      CHECK (production_days_per_week BETWEEN 1 AND 7);
  END IF;
END $$;

-- 2. Video production capacity → 4/working-day for BOTH producer roles.
--    A ceiling, not a target: 4 × 6 working days = 24 weekly ≥ 21 required.
UPDATE public.mos_role_load l
SET daily_new_tasks = 4, updated_at = now()
FROM public.roles r
WHERE l.role_id = r.id
  AND r.key IN ('mos_writer', 'mos_montage')
  AND l.bucket = 'video'
  AND l.daily_new_tasks <> 4;

COMMIT;
