-- Catch-up (2026-10-05): the two dedicated cv machines also run 4 marketing
-- claim loops each (CV_MARKETING_LOOPS), so 8 general x 3 + 2 cv x 4 = 32 slots.
-- Set back to 15 (and scale app back to 5) when the backlog is done.
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 32 WHERE provider_key = 'internal';
COMMIT;
