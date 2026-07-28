-- ============================================================================
-- Marketing Portfolio — the operational fields a campaign record was missing.
--
-- The portfolio's forms collected a handful of fields and the detail view did
-- not exist at all, so several things a campaign genuinely has — how its budget
-- is spent, what conversion it is buying, where its tracking comes from, which
-- areas and property types it covers — had nowhere to live.
--
-- These are CAMPAIGN-LEVEL INTENT. The platform campaigns underneath still
-- carry their own budget_kind / conversion_event / tracking_template, because
-- what Meta is told and what TikTok is told are not the same sentence. Nothing
-- here merges the platform layer into a universal parent form.
--
-- Idempotent. Safe to re-run.
-- ============================================================================
BEGIN;

ALTER TABLE public.mkt_internal_campaigns
  ADD COLUMN IF NOT EXISTS budget_kind text,
  ADD COLUMN IF NOT EXISTS conversion_objective text,
  ADD COLUMN IF NOT EXISTS tracking_template text,
  ADD COLUMN IF NOT EXISTS locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS property_types jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_camp_budget_kind_check') THEN
    ALTER TABLE public.mkt_internal_campaigns ADD CONSTRAINT mkt_camp_budget_kind_check
      CHECK (budget_kind IS NULL OR budget_kind IN ('daily', 'lifetime'));
  END IF;
END $$;

COMMENT ON COLUMN public.mkt_internal_campaigns.budget_kind IS
  'daily | lifetime — how the campaign budget is meant to be spent. Platform campaigns carry their own.';
COMMENT ON COLUMN public.mkt_internal_campaigns.conversion_objective IS
  'The outcome this campaign is buying (lead form, call, visit). Platform-specific events live on mkt_platform_campaigns.';
COMMENT ON COLUMN public.mkt_internal_campaigns.period_override_reason IS
  'Why this campaign runs outside its plan period. Required for such dates; stamped with who and when.';

COMMIT;
