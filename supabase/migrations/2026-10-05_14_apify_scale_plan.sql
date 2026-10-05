-- 2026-10-05: Apify upgraded to the Scale plan by the operator ($199/month of
-- included usage, then pay-as-you-go; 128 concurrent runs; Silver discount).
-- The monthly usage limit was set to $300 through the Apify API (steady
-- collection ~ $80/month + the two TikTok histories ~ $7; the cap stays as a
-- brake against a runaway like the $56 re-buy earlier today).
--
-- 1. Apify jobs at once: 4 -> 8, so a daily round of ~236 Instagram/TikTok
--    accounts finishes sooner. Well under Scale's 128.
-- 2. Resume the Rakez / Thiraa TikTok 12-month histories deferred by
--    2026-10-05_13 (applied live together with one 'incremental' job per
--    account, reason 'history_catchup'; the chunking fix 93d0b3a7 stops the
--    re-buy that deferred them).
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 8 WHERE provider_key = 'apify';
UPDATE public.mkt_social_accounts
   SET history_done_at = NULL,
       provider_metadata = provider_metadata - 'history_deferred_at' - 'history_deferred_reason',
       updated_at = now()
 WHERE provider_metadata ? 'history_deferred_at';
COMMIT;
