-- Catch-up (2026-10-05): general machines run 3 claim loops each (15 slots).
-- Internal work (media downloads, reads) was capped at 10, so with collection
-- winding down five slots sat idle while 4,000+ media jobs waited. Collection is
-- still claimed first and bounded by its own providers' caps.
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 15 WHERE provider_key = 'internal';
COMMIT;
