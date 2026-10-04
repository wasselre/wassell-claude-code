-- Catch-up (2026-10-05): Apify 4 -> 8 runs at once. 201 accounts still owed
-- their 12-month history and each run holds a slot for up to ~90 minutes, so at
-- 4 the history alone would take ~25 hours. The Apify plan allows 32 concurrent
-- runs / 64 GB; the general machines now run 3 claim loops each (15 slots), so
-- reading keeps at least 7. Spend is set by the backlog, not by this number.
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 8 WHERE provider_key = 'apify';
COMMIT;
