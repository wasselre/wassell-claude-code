-- Resume the TikTok 12-month history deferred by 2026-10-05_05 (operator
-- decision 2026-10-05 ~06:10 UTC): the Apify monthly limit was raised from
-- $100 to $175 for the cycle ending 2026-10-22 ($84.20 used at the time;
-- daily collection alone ~ $2.60/day). Applied live together with one
-- 'incremental' job per account (reason 'history_catchup').
BEGIN;
UPDATE public.mkt_social_accounts
   SET history_done_at = NULL,
       provider_metadata = provider_metadata - 'history_deferred_at' - 'history_deferred_reason',
       updated_at = now()
 WHERE provider_metadata ? 'history_deferred_at';
COMMIT;
