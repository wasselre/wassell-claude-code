-- ============================================================================
-- Feed / stories ad-set PAIRS for Click-to-WhatsApp campaigns (2026-09-13)
-- ----------------------------------------------------------------------------
-- Meta will not let ONE WhatsApp-destination ad carry a different design per
-- placement (placement asset customization is not supported for messaging
-- objectives: Meta flags the ad «Invalid Creative For Objective» and Ads
-- Manager cannot open it — measured live on C-042, 2026-09-13). The supported
-- way to run the square design in the feed and the vertical one in stories /
-- reels is TWO ad sets per Wassel ad set, each with plain link_data ads:
--
--   mos_ad_sets        variant 'feed'  → Instagram feed + profile feed
--                      variant 'story' → Instagram stories + reels
--   mos_execution_ads  variant 'feed'  = the PRIMARY row (caption, task,
--                                        auto_ad state, square ad id)
--                      variant 'story' = the SHADOW row (vertical ad id),
--                                        created by the worker, shown on the
--                                        execution's Ads tab, hidden on the
--                                        creative's Placements tab
--
-- `pair_id` ties the two ad-set rows (and the two ad rows) together. NULL
-- variant = a legacy single ad set (hand-made in Ads Manager, or synced) —
-- the worker then creates one ad with the square design.
-- Idempotent.
-- ============================================================================

ALTER TABLE public.mos_ad_sets
  ADD COLUMN IF NOT EXISTS placement_variant text,
  ADD COLUMN IF NOT EXISTS pair_id uuid;
ALTER TABLE public.mos_execution_ads
  ADD COLUMN IF NOT EXISTS placement_variant text,
  ADD COLUMN IF NOT EXISTS pair_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_ad_sets_placement_variant_check') THEN
    ALTER TABLE public.mos_ad_sets ADD CONSTRAINT mos_ad_sets_placement_variant_check
      CHECK (placement_variant IS NULL OR placement_variant IN ('feed', 'story'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_execution_ads_placement_variant_check') THEN
    ALTER TABLE public.mos_execution_ads ADD CONSTRAINT mos_execution_ads_placement_variant_check
      CHECK (placement_variant IS NULL OR placement_variant IN ('feed', 'story'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_mos_ad_sets_pair ON public.mos_ad_sets(pair_id) WHERE pair_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mos_execution_ads_pair ON public.mos_execution_ads(pair_id) WHERE pair_id IS NOT NULL;
