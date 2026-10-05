-- Catch-up (2026-10-05 ~06:20 UTC): Apify 8 -> 16 runs at once for the resumed
-- TikTok 12-month history (33 accounts, each run up to ~1 h). The plan allows
-- 32; total cost is unchanged (each account is collected once). With 40 claim
-- slots, reading keeps >= 24. Set back to 4 after the catch-up.
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 16 WHERE provider_key = 'apify';
COMMIT;
