-- ============================================================================
-- Competitor collection: 12 months once, then only new posts; views/likes at
-- 7 and 30 days (operator decisions 2026-10-04)
-- ----------------------------------------------------------------------------
-- Before: every run re-bought every post of the last 14 days to refresh
-- views/likes — about 14 paid reads per post for a daily account — and stopped
-- looking at day 14, so the numbers we held were taken at different ages and
-- could not be compared. The "metrics" job was a placeholder that did nothing.
--
-- Now:
--   * mkt_social_accounts.history_done_at — NULL until the account's one-time
--     12-month collection succeeds; after it, runs ask only for posts newer
--     than our newest one (the worker's incrementalWindow).
--   * mkt_content_posts.metrics_7d_at / metrics_30d_at — each post is re-read
--     exactly twice, at 7 and 30 days old. A post we first saw when it was
--     already older than that age is not re-read for it (its first reading
--     already is that late number).
--   * mkt_posts_due_for_metrics / mkt_post_metrics_mark — the worker's
--     post_metrics job lists and marks those posts.
--   * mkt_enqueue_due_accounts — a metrics job is queued only when the account
--     has a post due (at most once per 20 h), not on a blind 20-hour timer.
--   * Every Instagram / TikTok / YouTube account is collected daily
--     ("check all accounts"), except our own Wassel accounts (not a competitor;
--     our posts live in Marketing OS) and a second row for the Alajlan YouTube
--     channel (the same channel is already collected under alajlan_riviera).
--     An account with no post in 30 days still drops to weekly by itself.
-- Apify itself stays disabled here; switching it on is a separate step.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

ALTER TABLE public.mkt_social_accounts ADD COLUMN IF NOT EXISTS history_done_at timestamptz;
COMMENT ON COLUMN public.mkt_social_accounts.history_done_at IS
  'When this account''s one-time 12-month collection succeeded. NULL = not yet: the next incremental run collects the last 12 months.';

ALTER TABLE public.mkt_content_posts
  ADD COLUMN IF NOT EXISTS metrics_7d_at  timestamptz,
  ADD COLUMN IF NOT EXISTS metrics_30d_at timestamptz;
COMMENT ON COLUMN public.mkt_content_posts.metrics_7d_at  IS 'When views/likes were re-read at ~7 days old (post_metrics job).';
COMMENT ON COLUMN public.mkt_content_posts.metrics_30d_at IS 'When views/likes were re-read at ~30 days old (post_metrics job).';

CREATE INDEX IF NOT EXISTS mkt_content_posts_account_published_idx
  ON public.mkt_content_posts (social_account_id, published_at DESC);

CREATE OR REPLACE FUNCTION public.mkt_posts_due_for_metrics(p_account uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (post_id uuid, external_id text, post_url text, stage text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT d.id, d.external_id, d.post_url, d.stage FROM (
    SELECT p.id, p.external_id, p.post_url, '7d'::text AS stage, p.published_at
      FROM public.mkt_content_posts p
     WHERE p.social_account_id = p_account AND p.availability = 'available'
       AND p.metrics_7d_at IS NULL
       AND p.published_at <= now() - interval '7 days'
       AND p.published_at >  now() - interval '14 days'      -- a missed window is skipped, not chased
       AND p.first_seen_at < p.published_at + interval '7 days'
    UNION ALL
    SELECT p.id, p.external_id, p.post_url, '30d', p.published_at
      FROM public.mkt_content_posts p
     WHERE p.social_account_id = p_account AND p.availability = 'available'
       AND p.metrics_30d_at IS NULL
       AND p.published_at <= now() - interval '30 days'
       AND p.published_at >  now() - interval '45 days'
       AND p.first_seen_at < p.published_at + interval '30 days'
  ) d
  ORDER BY d.published_at
  LIMIT GREATEST(0, p_limit);
$$;

CREATE OR REPLACE FUNCTION public.mkt_post_metrics_mark(p_post_ids uuid[], p_stage text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE n integer;
BEGIN
  IF p_stage NOT IN ('7d', '30d') THEN
    RAISE EXCEPTION 'unknown metrics stage %', p_stage USING ERRCODE = '22023';
  END IF;
  UPDATE public.mkt_content_posts
     SET metrics_7d_at  = CASE WHEN p_stage = '7d'  THEN now() ELSE metrics_7d_at  END,
         metrics_30d_at = CASE WHEN p_stage = '30d' THEN now() ELSE metrics_30d_at END,
         updated_at = now()
   WHERE id = ANY (coalesce(p_post_ids, '{}'::uuid[]));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.mkt_posts_due_for_metrics(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mkt_post_metrics_mark(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_posts_due_for_metrics(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_post_metrics_mark(uuid[], text) TO service_role;

-- Re-emitted from the live definition; the only change is met_due.
CREATE OR REPLACE FUNCTION public.mkt_enqueue_due_accounts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n int := 0; v_cap int; v_paused boolean;
BEGIN
  SELECT (value)::boolean INTO v_paused FROM public.mkt_settings WHERE key = 'collection_paused';
  IF COALESCE(v_paused, true) THEN RETURN 0; END IF;
  SELECT COALESCE((value)::int, 10) INTO v_cap FROM public.mkt_settings WHERE key = 'max_accounts_per_batch';

  PERFORM public.mkt_provider_resume_expired();

  FOR r IN
    SELECT d.* FROM (
      SELECT a.id, a.provider, a.last_incremental_at, a.last_metrics_at,
             public.mkt_incremental_due(
               a.last_incremental_at, a.cadence,
               (SELECT max(p.published_at) FROM public.mkt_content_posts p WHERE p.social_account_id = a.id)
             ) AS inc_due,
             -- a views check only when a post is actually due for one (7 / 30 days old)
             ((a.last_metrics_at IS NULL OR a.last_metrics_at < now() - interval '20 hours')
               AND EXISTS (SELECT 1 FROM public.mkt_posts_due_for_metrics(a.id, 1))) AS met_due
        FROM public.mkt_social_accounts a
        JOIN public.mkt_providers pr ON pr.provider_key = a.provider AND pr.is_enabled
       WHERE a.collection_enabled AND a.is_active AND a.provider IS NOT NULL
         AND (pr.paused_until IS NULL OR pr.paused_until <= now())
    ) d
    WHERE d.inc_due OR d.met_due
    ORDER BY LEAST(coalesce(d.last_incremental_at, '-infinity'::timestamptz),
                   coalesce(d.last_metrics_at,     '-infinity'::timestamptz))
    LIMIT v_cap
  LOOP
    IF r.inc_due THEN
      PERFORM public.mkt_job_enqueue('incremental', r.provider, r.id, '{"reason":"scheduled"}'::jsonb, 100);
      n := n + 1;
    END IF;
    IF r.met_due THEN
      PERFORM public.mkt_job_enqueue('post_metrics', r.provider, r.id, '{"reason":"scheduled"}'::jsonb, 120);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $function$;

-- Check every competitor account, daily.
UPDATE public.mkt_social_accounts a
   SET collection_enabled = true,
       cadence = jsonb_set(coalesce(a.cadence, '{}'::jsonb), '{incremental}', '"daily"'),
       updated_at = now()
  FROM public.mkt_organizations o
 WHERE o.id = a.organization_id
   AND a.platform IN ('instagram', 'tiktok', 'youtube')
   AND a.is_active
   AND o.org_type <> 'internal'                                         -- our own Wassel accounts
   AND NOT (a.platform = 'youtube' AND a.handle = 'UCmaKb3mY3e6t5S8sTLaMcmA')  -- duplicate of alajlan_riviera
   AND coalesce(a.provider_metadata->>'disabled_reason', '') <> 'not_found';

COMMIT;
