-- Catch-up (2026-10-05): the five general worker machines now run two marketing
-- claim loops each (MARKETING_LOOPS=2), i.e. 10 slots. With internal capped at 8,
-- two slots could only ever take collection; let internal work use all 10.
-- Collection is claimed first and bounded by its own providers' caps.
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 10 WHERE provider_key = 'internal';
COMMIT;
