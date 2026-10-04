-- Catch-up speed (2026-10-05): stop post reading from starving collection, and
-- lift the daily caps for the one-off backlog (operator decision 2026-10-05,
-- after topping the Gemini prepaid balance up by $450).
--
-- Measured 2026-10-04:
--   * mkt_job_claim_next ordered by priority alone. Reading jobs
--     (content_process, priority 30-70) always came before collection
--     (incremental / backfill / post_metrics, priority 100), so with ~1,100
--     reads queued, 8 collection jobs sat overdue for hours and 161 accounts had
--     never been collected.
--   * Apify was capped at 2 runs at a time (the plan allows 32), and a large
--     account's 12-month history holds one for 80+ minutes.
--
-- Collection jobs are external provider calls bounded by each provider's
-- max_concurrency, so letting them claim first cannot starve reading: at most
-- apify 4 + youtube 2 + browserbase 2 slots are ever theirs.

BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_job_claim_next(p_worker_id text, p_lease_seconds integer DEFAULT 600)
 RETURNS TABLE(job_id uuid, kind text, provider text, social_account_id uuid, params jsonb, attempts integer, max_attempts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_paused boolean;
BEGIN
  SELECT (value)::boolean INTO v_paused FROM public.mkt_settings WHERE key='collection_paused';
  IF COALESCE(v_paused, true) THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.mkt_collection_jobs j
     SET status='running', worker_id=p_worker_id, started_at=now(),
         lease_expires_at=now() + make_interval(secs => p_lease_seconds), attempts=j.attempts + 1
   WHERE j.id = (
     SELECT c.id FROM public.mkt_collection_jobs c
      LEFT JOIN public.mkt_social_accounts a ON a.id = c.social_account_id
      JOIN public.mkt_providers pr ON pr.provider_key = c.provider
      WHERE c.status='queued' AND c.next_run_at <= now()
        AND pr.is_enabled
        AND (c.social_account_id IS NULL OR (a.collection_enabled AND a.is_active))
        AND (SELECT count(*) FROM public.mkt_collection_jobs rr WHERE rr.status='running' AND rr.provider=c.provider) < pr.max_concurrency
      -- external collection first (bounded by its provider's max_concurrency),
      -- then internal work (reading) by priority — see the header.
      ORDER BY (c.provider = 'internal'), c.priority, c.next_run_at
      FOR UPDATE OF c SKIP LOCKED LIMIT 1
   )
   RETURNING j.id, j.kind, j.provider, j.social_account_id, j.params, j.attempts, j.max_attempts;
END $function$;
REVOKE ALL ON FUNCTION public.mkt_job_claim_next(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_job_claim_next(text, integer) TO service_role;

UPDATE public.mkt_providers SET max_concurrency = 4 WHERE provider_key = 'apify';

-- Catch-up caps. Total spend is unchanged by these (it is set by the backlog);
-- they only stop the backlog from being spread over two weeks. Lower them again
-- once the backlog is done (~$45/month steady state).
UPDATE public.mkt_settings SET value = '3000'::jsonb, updated_at = now() WHERE key = 'cv.max_videos_per_day';
UPDATE public.mkt_settings SET value = '120'::jsonb,  updated_at = now() WHERE key = 'cv.daily_budget_usd';
UPDATE public.mkt_settings SET value = '120'::jsonb,  updated_at = now() WHERE key = 'content.reader_daily_budget_usd';

COMMIT;
