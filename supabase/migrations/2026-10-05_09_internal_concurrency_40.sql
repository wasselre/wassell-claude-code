-- Catch-up (2026-10-05 ~06:00 UTC): dedicated cv machines scaled 2 -> 4
-- (fly scale count cv=4), each running 4 marketing claim loops alongside its
-- shot loops: 8 general x 3 + 4 cv x 4 = 40 slots. Set back to 15 when the
-- backlog is done (and scale app back to 5, cv back to 1-2).
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 40 WHERE provider_key = 'internal';
COMMIT;
