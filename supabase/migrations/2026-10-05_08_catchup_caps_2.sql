-- Catch-up caps, second raise (2026-10-05 ~00:45 UTC). With shots on dedicated
-- machines the backlog moved faster than the first caps assumed: 3,000 videos
-- were admitted in the Riyadh day by 00:44 UTC (cap reached; 368 waiting and
-- ~2,600 more arriving as collected posts are read), and shot spend was $83 of
-- $120 with ~$90 still to come. Reaching cv.daily_budget_usd FAILS jobs
-- terminally (budget_exceeded), so it must sit above the backlog's cost.
-- Total spend is set by the backlog, not by these numbers.
-- Set back after the catch-up: cv.max_videos_per_day 500, cv.daily_budget_usd 30,
-- content.reader_daily_budget_usd 25.
BEGIN;
UPDATE public.mkt_settings SET value = '10000'::jsonb, updated_at = now() WHERE key = 'cv.max_videos_per_day';
UPDATE public.mkt_settings SET value = '250'::jsonb,   updated_at = now() WHERE key = 'cv.daily_budget_usd';
UPDATE public.mkt_settings SET value = '200'::jsonb,   updated_at = now() WHERE key = 'content.reader_daily_budget_usd';
COMMIT;
