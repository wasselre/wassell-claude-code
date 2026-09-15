-- Revert of half of 2026-09-15_02's A9 block. See the NOTE in that file.
--
-- The 4-column expression index it created could not be inferred by
-- mos_campaign_plan_commit's `ON CONFLICT (content_id, platform, account_id)`,
-- so every organic commit raised 42P10 — the existing wizard path included.
-- The widening and the RPC's ON CONFLICT target are one change; B4 does both.
ALTER TABLE public.mos_publications DROP CONSTRAINT IF EXISTS uq_mos_publications_destination;
DROP INDEX IF EXISTS public.uq_mos_publications_destination;

ALTER TABLE public.mos_publications
  ADD CONSTRAINT mos_publications_content_id_platform_account_id_key
  UNIQUE (content_id, platform, account_id);

COMMENT ON CONSTRAINT mos_publications_content_id_platform_account_id_key
  ON public.mos_publications IS
  'B4 MUST replace this with (content_id, platform, account_id, COALESCE(placement_variant,'''')) '
  'and change mos_campaign_plan_commit''s ON CONFLICT target in the SAME migration. A post''s feed '
  'and story releases share content_id, platform and account_id, so under this 3-column key the '
  'second one is silently swallowed by DO NOTHING — feeds publish, stories do not, no error.';
