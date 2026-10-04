-- Catch-up (2026-10-05): general machines scaled 5 -> 8 (fly scale count app=8;
-- each was CPU-bound at load ~1.0-1.4), 3 claim loops each = 24 slots.
-- Scale back to 5 and set this back to 15 when the backlog is done.
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 24 WHERE provider_key = 'internal';
COMMIT;
