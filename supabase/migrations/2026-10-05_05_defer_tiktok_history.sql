-- Defer TikTok 12-month history until the Apify cycle resets (2026-10-05).
--
-- Apify billed $72.54 of the $100 monthly limit by 22:30 UTC on 2026-10-04
-- (cycle 2026-09-23 → 2026-10-22). Measured real cost per account's history:
-- ~$0.35 Instagram, ~$0.55 TikTok (Apify's bill is ~2.2x what our runs record;
-- some of tonight's spend was runs cut off by worker restarts). Finishing all 67
-- remaining accounts + normal daily collection to 2026-10-22 projects to ~$113,
-- and at $100 Apify refuses every run, which pauses ALL collection until the
-- cycle ends. So: Instagram history finishes now (~$9); the 42 TikTok accounts
-- keep their DAILY collection but their 12-month history waits.
--
-- How: history_done_at = now() makes incrementalWindow() fetch only new posts.
-- Each deferred account is tagged in provider_metadata.history_deferred_at.
--
-- TO RESUME (after 2026-10-23, or once the Apify limit is raised):
--   UPDATE mkt_social_accounts
--      SET history_done_at = NULL,
--          provider_metadata = provider_metadata - 'history_deferred_at' - 'history_deferred_reason'
--    WHERE provider_metadata ? 'history_deferred_at';
BEGIN;
UPDATE public.mkt_social_accounts
   SET history_done_at = now(),
       provider_metadata = COALESCE(provider_metadata, '{}'::jsonb)
         || jsonb_build_object('history_deferred_at', now(), 'history_deferred_reason', 'apify monthly limit — resume after cycle reset 2026-10-23'),
       updated_at = now()
 WHERE platform = 'tiktok' AND collection_enabled AND history_done_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.mkt_collection_jobs j
                    WHERE j.social_account_id = mkt_social_accounts.id AND j.status = 'running');
COMMIT;
