-- Platform-specific campaign settings on Marketing OS executions + ads.
--
-- `platform_settings` holds the REAL ad-platform fields (Meta / Snapchat /
-- TikTok Marketing API names and enum values) for the execution's campaign +
-- ad-set level: objective, optimization goal, budget mode, bid strategy,
-- placements, structured targeting. Schemas live in
-- src/lib/marketingOS/adPlatforms/; field reference in
-- docs/reference/ad-platforms/.
--
-- `creative` on mos_execution_ads is the ad-level twin: format, copy, CTA,
-- destination URL / lead-form id / Spark post id.
--
-- Both are additive and nullable — existing rows and the legacy free-text
-- `targeting` brief keep working untouched. RLS is unchanged: the existing
-- mos_* policies gate whole-row access; these are just new columns.

ALTER TABLE public.mos_campaign_executions
  ADD COLUMN IF NOT EXISTS platform_settings jsonb;

ALTER TABLE public.mos_execution_ads
  ADD COLUMN IF NOT EXISTS creative jsonb;
