-- 2026-10-05 ~08:00 UTC: Gemini reached the Tier-1 monthly spending cap
-- ($250/month per billing account), so reading and shots are paused until the
-- cap resets (1 Nov), the account reaches Tier 2, or the cap is raised.
-- Machines scaled back (app 8 -> 5, cv 4 -> 1); slot limits follow:
-- 5 general x 3 + 1 cv x 4 = 19. Apify back to 4 (catch-up collection done).
BEGIN;
UPDATE public.mkt_providers SET max_concurrency = 19 WHERE provider_key = 'internal';
UPDATE public.mkt_providers SET max_concurrency = 4  WHERE provider_key = 'apify';
COMMIT;
