-- ============================================================================
-- Apify: collect what is new, stop cleanly when the month's budget is spent
-- ----------------------------------------------------------------------------
-- Measured against Apify's own billing for the cycle 2026-08-23 → 2026-09-22
-- (plan limit $29/month):
--
--   $31.65 spent  ·  9,961 posts paid for  ·  221 of them new (2.2%)
--
-- The budget ran out on 2026-09-06 and nothing was collected for the rest of the
-- cycle. The same thing happened 2026-08-02 → 08-22. Four causes live in the
-- database side of the pipeline and are fixed here; the collection itself
-- (date cutoffs, TikTok downloads only for new videos, storage cleanup) is in
-- worker/src/marketing/apifyLifecycle.ts.
--
-- 1. THE SCHEDULER RAN EVERY 20 HOURS, NOT DAILY. `last_incremental_at < now()
--    - 20 hours` made every account due 1.2 times a day (measured: 1.21–1.24
--    runs/account/day). It also READ `cadence` and never used it. Due-ness is
--    now anchored on the Riyadh calendar day, and cadence is honoured.
--
-- 2. DORMANT ACCOUNTS COST THE SAME AS ACTIVE ONES. Six accounts produced one
--    new post between them in the cycle and cost ~$4.20. An account with no
--    post in 30 days (or none ever) is now checked WEEKLY. It returns to daily
--    by itself the day a new post is stored.
--
-- 3. A SPENT BUDGET WAS TREATED AS A TEMPORARY OUTAGE. Apify's 403 "Monthly
--    usage hard limit exceeded" fell into the generic 'unavailable' bucket, was
--    retried 5× with backoff, and — because `last_incremental_at` only moves on
--    success — the account was due again on the very next tick. ~450 failed
--    jobs a day, 15,120 in total, and 46,008 junk ingestion-run rows in August.
--    The worker now classifies it as 'budget_exhausted' and calls
--    mkt_provider_pause_for_budget(), which pauses the provider until the cycle
--    end Apify reports, cancels its queued work, raises ONE critical alert and
--    pushes it to admins' phones. The existing ops alerts DID fire, but as dozens
--    of per-organisation "stale" alerts that never said why, on a settings page.
--
-- 4. BLOCKED ACCOUNTS STARVED YOUTUBE. The scheduler took the 10 oldest accounts
--    and only THEN checked whether they were due. The 22 blocked Apify accounts
--    never got newer, so they filled all 10 slots on every tick: YouTube — free,
--    and working — has not run once since 2026-09-06. The due test now happens
--    BEFORE the limit, and paused providers are excluded from the candidate set.
--
-- Backward-compatible: new nullable columns + new functions; the replaced
-- scheduler keeps its signature and return value.
-- ============================================================================

BEGIN;

-- ── provider pause ──────────────────────────────────────────────────────────
ALTER TABLE public.mkt_providers
  ADD COLUMN IF NOT EXISTS paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason text;

COMMENT ON COLUMN public.mkt_providers.paused_until IS
  'While in the future, the scheduler enqueues nothing for this provider and the worker refuses to start runs. Set by mkt_provider_pause_for_budget; cleared by mkt_provider_resume_expired.';

ALTER TABLE public.mkt_providers DROP CONSTRAINT IF EXISTS mkt_providers_health_status_check;
ALTER TABLE public.mkt_providers ADD CONSTRAINT mkt_providers_health_status_check
  CHECK (health_status = ANY (ARRAY['not_configured','connected','auth_failed','rate_limited','unavailable','config_invalid','budget_exhausted']));

-- ── is this account due for an incremental run? ─────────────────────────────
-- Pure apart from p_now, so it is testable with fixed inputs.
CREATE OR REPLACE FUNCTION public.mkt_incremental_due(
  p_last timestamptz, p_cadence jsonb, p_newest_post timestamptz, p_now timestamptz DEFAULT now()
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_mode text; v_day_start timestamptz;
BEGIN
  IF p_last IS NULL THEN RETURN true; END IF;                     -- never collected
  v_mode := lower(coalesce(p_cadence->>'incremental', 'daily'));
  -- Dormant: nothing published in 30 days, or nothing stored at all.
  IF p_newest_post IS NULL OR p_newest_post < p_now - interval '30 days' THEN
    v_mode := 'weekly';
  END IF;
  -- Start of today in Riyadh. "Not yet run today" gives exactly one run per
  -- calendar day; a rolling N-hour window drifts and over-runs (the 20-hour bug).
  v_day_start := (date_trunc('day', p_now AT TIME ZONE 'Asia/Riyadh')) AT TIME ZONE 'Asia/Riyadh';
  IF v_mode = 'weekly' THEN
    RETURN p_last < v_day_start - interval '6 days';
  END IF;
  RETURN p_last < v_day_start;                                    -- daily (and any unknown value)
END $$;

-- ── pause a provider whose monthly budget is spent ──────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_provider_pause_for_budget(
  p_provider text, p_until timestamptz, p_detail text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_until timestamptz; v_cancelled int := 0; v_new boolean; v_key text;
  v_until_local text; v_title text; v_body text; v_push text; v_pushed int := 0;
BEGIN
  IF p_until IS NULL OR p_until <= now() THEN
    RAISE EXCEPTION 'mkt_provider_pause_for_budget: pause end must be in the future (got %)', p_until USING ERRCODE = '22023';
  END IF;

  UPDATE public.mkt_providers
     SET paused_until    = GREATEST(coalesce(paused_until, p_until), p_until),
         pause_reason    = 'budget_exhausted',
         health_status   = 'budget_exhausted',
         health_detail   = left(coalesce(p_detail, 'monthly usage limit reached'), 500),
         last_checked_at = now(),
         updated_at      = now()
   WHERE provider_key = p_provider
  RETURNING paused_until INTO v_until;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mkt_provider_pause_for_budget: unknown provider %', p_provider USING ERRCODE = '22023';
  END IF;

  v_until_local := to_char(v_until AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI');

  -- Everything queued for this provider would hit the same wall. Cancel it; the
  -- scheduler re-creates it after the pause (the backlog lives in the data —
  -- "newer than the last stored post" — not in the queue).
  UPDATE public.mkt_collection_jobs
     SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL,
         error_message = format('paused: %s monthly budget used up until %s (Riyadh)', p_provider, v_until_local)
   WHERE provider = p_provider AND status = 'queued';
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- ONE alert per provider per cycle. Serialise concurrent callers so two
  -- workers hitting the wall together cannot both notify.
  v_key := format('budget:%s:%s', p_provider, to_char(v_until, 'YYYY-MM-DD'));
  PERFORM pg_advisory_xact_lock(hashtext(v_key));
  v_new := NOT EXISTS (SELECT 1 FROM public.mkt_ops_alerts WHERE dedup_key = v_key AND status <> 'resolved');

  v_title := format('نفدت ميزانية %s الشهرية — التجميع متوقف حتى %s', p_provider, v_until_local);
  -- Explicit || throughout: an E'' literal cannot continue a plain literal on
  -- the next line (42601), which is how the first apply of this file failed.
  v_body  := format(
    'استُهلك الحد الشهري لحساب %1$s، فأوقفنا جمع محتوى المنافسين تلقائياً حتى يتجدد الحد في %2$s بتوقيت الرياض. ' ||
    'لن يُجمع أي منشور جديد من إنستقرام وتيك توك قبل ذلك. لاستئناف أسرع ارفع الحد من إعدادات الفوترة في %1$s.' ||
    E'\n\n' ||
    'The %1$s monthly usage limit is spent, so competitor collection is paused until the limit renews at %2$s (Riyadh). ' ||
    'No new Instagram or TikTok posts are collected until then. To resume sooner, raise the limit in %1$s billing settings.',
    p_provider, v_until_local);
  v_push := format('نفدت ميزانية %s — جمع محتوى المنافسين متوقف حتى %s', p_provider, v_until_local);

  PERFORM public.mkt_alert_emit(
    p_kind => 'provider_budget_exhausted', p_dedup_key => v_key, p_title => v_title,
    p_severity => 'critical', p_subject_type => 'provider', p_subject_id => p_provider,
    p_body => v_body,
    p_evidence => jsonb_build_object('paused_until', v_until, 'detail', p_detail, 'cancelled_jobs', v_cancelled));

  IF v_new THEN
    INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
    SELECT u.id, 'ops_alert', 'وصل — تنبيه تشغيل', v_push, '/settings/marketing-ops',
           'budget-' || p_provider, v_key || ':' || u.id
      FROM public.users u
      JOIN public.profiles pf ON pf.id = u.profile_id
     WHERE u.is_active AND pf.is_admin;
    GET DIAGNOSTICS v_pushed = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('paused_until', v_until, 'cancelled_jobs', v_cancelled,
                            'alert_new', v_new, 'admins_notified', v_pushed);
END $$;

-- ── lift pauses whose time has come ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_provider_resume_expired()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  WITH lifted AS (
    UPDATE public.mkt_providers
       SET paused_until = NULL, pause_reason = NULL,
           health_status = 'connected',
           health_detail = 'budget pause ended ' || to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI') || ' (Riyadh); the next run confirms the account is usable',
           updated_at = now()
     WHERE paused_until IS NOT NULL AND paused_until <= now()
    RETURNING provider_key
  )
  UPDATE public.mkt_ops_alerts a
     SET status = 'resolved', resolved_at = now()
    FROM lifted l
   WHERE a.kind = 'provider_budget_exhausted' AND a.subject_id = l.provider_key AND a.status <> 'resolved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ── end a job that hit a paused provider WITHOUT retrying it ───────────────
CREATE OR REPLACE FUNCTION public.mkt_job_cancel_paused(p_job_id uuid, p_error text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.mkt_collection_jobs
     SET status = 'cancelled', error_message = p_error, finished_at = now(), lease_expires_at = NULL
   WHERE id = p_job_id AND status = 'running';
  RETURN CASE WHEN FOUND THEN 'cancelled' ELSE 'noop' END;
END $$;

-- ── the scheduler ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_enqueue_due_accounts()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
             (a.last_metrics_at IS NULL OR a.last_metrics_at < now() - interval '20 hours') AS met_due
        FROM public.mkt_social_accounts a
        JOIN public.mkt_providers pr ON pr.provider_key = a.provider AND pr.is_enabled
       WHERE a.collection_enabled AND a.is_active AND a.provider IS NOT NULL
         AND (pr.paused_until IS NULL OR pr.paused_until <= now())
    ) d
    -- Filter to DUE accounts before the limit. Limiting first let accounts that
    -- could never succeed occupy every slot (the YouTube starvation, 09-06 →).
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
END $$;

-- ── service-role only, same posture as the rest of the queue ────────────────
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'mkt_incremental_due(timestamptz,jsonb,timestamptz,timestamptz)',
    'mkt_provider_pause_for_budget(text,timestamptz,text)',
    'mkt_provider_resume_expired()',
    'mkt_job_cancel_paused(uuid,text)',
    'mkt_enqueue_due_accounts()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;
