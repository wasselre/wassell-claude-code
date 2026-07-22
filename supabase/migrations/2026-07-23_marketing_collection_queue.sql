-- ============================================================================
-- 2026-07-23: Marketing collection worker queue + scheduling + kill switches.
-- ----------------------------------------------------------------------------
-- Connects the provider layer to the existing Fly worker (same deck_jobs pattern:
-- claim FOR UPDATE SKIP LOCKED → run → complete/fail; watchdog reclaims stale
-- leases). ADDITIVE. Nothing auto-runs: collection_enabled defaults FALSE on every
-- account and the global switch defaults PAUSED, so scheduling is off until a pilot
-- account is explicitly enabled.
-- ============================================================================

BEGIN;

-- ── Per-account scheduling config + account-level kill switch ────────────────
ALTER TABLE public.mkt_social_accounts
  ADD COLUMN IF NOT EXISTS collection_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cadence jsonb NOT NULL DEFAULT '{"incremental":"daily","metrics":"daily"}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_incremental_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_metrics_at timestamptz;

-- ── Provider concurrency cap (per-provider throttle) ─────────────────────────
ALTER TABLE public.mkt_providers
  ADD COLUMN IF NOT EXISTS max_concurrency int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS max_backfill_posts int NOT NULL DEFAULT 200;

-- ── Global settings (kill switch + batch caps) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.mkt_settings (key, value) VALUES
  ('collection_paused', 'true'::jsonb),                 -- GLOBAL kill switch (starts paused)
  ('max_accounts_per_batch', '10'::jsonb),
  ('default_backfill_limit', '30'::jsonb),
  ('metric_snapshot_min_interval_hours', '20'::jsonb),  -- suppress duplicate snapshots within this window
  ('max_attempts', '5'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── The queue ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_collection_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN
                      ('discover','backfill','incremental','post_metrics','account_metrics',
                       'paid_ads','attribution','reprocess')),
  provider          text NOT NULL CHECK (provider IN ('apify','youtube','browserbase')),
  social_account_id uuid REFERENCES public.mkt_social_accounts(id) ON DELETE CASCADE,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts          int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 5,
  priority          int NOT NULL DEFAULT 100,
  next_run_at       timestamptz NOT NULL DEFAULT now(),   -- backoff / schedule anchor
  -- lease/lock
  worker_id         text,
  started_at        timestamptz,
  lease_expires_at  timestamptz,
  -- provenance
  ingestion_run_id  uuid,
  result            jsonb,
  error_message     text,
  requested_by      uuid,                                 -- manual runs
  fallback_of       uuid REFERENCES public.mkt_collection_jobs(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

-- Worker claim hot path (due, queued tail).
CREATE INDEX IF NOT EXISTS mkt_collection_jobs_claim_idx
  ON public.mkt_collection_jobs (next_run_at, priority)
  WHERE status = 'queued';
-- Watchdog hot path (running leases).
CREATE INDEX IF NOT EXISTS mkt_collection_jobs_lease_idx
  ON public.mkt_collection_jobs (lease_expires_at)
  WHERE status = 'running';
-- Per-provider running count (concurrency cap).
CREATE INDEX IF NOT EXISTS mkt_collection_jobs_running_provider_idx
  ON public.mkt_collection_jobs (provider)
  WHERE status = 'running';
-- OVERLAP PREVENTION: one active job per (account, kind).
CREATE UNIQUE INDEX IF NOT EXISTS mkt_collection_jobs_one_active_idx
  ON public.mkt_collection_jobs (social_account_id, kind)
  WHERE status IN ('queued','running') AND social_account_id IS NOT NULL;

DROP TRIGGER IF EXISTS mkt_collection_jobs_touch ON public.mkt_collection_jobs;
CREATE TRIGGER mkt_collection_jobs_touch BEFORE UPDATE ON public.mkt_collection_jobs
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();

-- ── RLS: authenticated read (Collection Status UI); writes service-role only ──
ALTER TABLE public.mkt_collection_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_collection_jobs_read ON public.mkt_collection_jobs;
CREATE POLICY mkt_collection_jobs_read ON public.mkt_collection_jobs FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mkt_collection_jobs TO authenticated;
DROP POLICY IF EXISTS mkt_settings_read ON public.mkt_settings;
CREATE POLICY mkt_settings_read ON public.mkt_settings FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mkt_settings TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- Enqueue (overlap-safe): returns existing active job id if one exists.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mkt_job_enqueue(
  p_kind text, p_provider text, p_social_account_id uuid,
  p_params jsonb DEFAULT '{}'::jsonb, p_priority int DEFAULT 100,
  p_requested_by uuid DEFAULT NULL, p_fallback_of uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_max int;
BEGIN
  IF p_social_account_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.mkt_collection_jobs
     WHERE social_account_id = p_social_account_id AND kind = p_kind AND status IN ('queued','running')
     LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;   -- overlap prevented
  END IF;
  SELECT COALESCE((SELECT (value)::int FROM public.mkt_settings WHERE key='max_attempts'),5) INTO v_max;
  INSERT INTO public.mkt_collection_jobs (kind, provider, social_account_id, params, priority, max_attempts, requested_by, fallback_of)
  VALUES (p_kind, p_provider, p_social_account_id, COALESCE(p_params,'{}'::jsonb), p_priority, v_max, p_requested_by, p_fallback_of)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Claim next due job — respects global pause, per-provider concurrency, per-account
-- + per-provider kill switches. FOR UPDATE SKIP LOCKED. Sets a lease.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mkt_job_claim_next(
  p_worker_id text, p_lease_seconds int DEFAULT 600
) RETURNS TABLE (
  job_id uuid, kind text, provider text, social_account_id uuid, params jsonb, attempts int, max_attempts int
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_paused boolean;
BEGIN
  SELECT (value)::boolean INTO v_paused FROM public.mkt_settings WHERE key='collection_paused';
  IF COALESCE(v_paused, true) THEN RETURN; END IF;    -- GLOBAL kill switch

  RETURN QUERY
  UPDATE public.mkt_collection_jobs j
     SET status='running', worker_id=p_worker_id, started_at=now(),
         lease_expires_at=now() + make_interval(secs => p_lease_seconds),
         attempts=j.attempts + 1
   WHERE j.id = (
     SELECT c.id FROM public.mkt_collection_jobs c
      LEFT JOIN public.mkt_social_accounts a ON a.id = c.social_account_id
      JOIN public.mkt_providers pr ON pr.provider_key = c.provider
      WHERE c.status='queued' AND c.next_run_at <= now()
        AND pr.is_enabled                                       -- per-provider kill switch
        AND (c.social_account_id IS NULL OR (a.collection_enabled AND a.is_active))  -- per-account kill switch
        AND (SELECT count(*) FROM public.mkt_collection_jobs r
              WHERE r.status='running' AND r.provider=c.provider) < pr.max_concurrency  -- concurrency cap
      ORDER BY c.priority, c.next_run_at
      FOR UPDATE OF c SKIP LOCKED   -- lock only the jobs row (not the outer-joined account)
      LIMIT 1
   )
   RETURNING j.id, j.kind, j.provider, j.social_account_id, j.params, j.attempts, j.max_attempts;
END $$;

-- Complete (only running → succeeded; late finish after watchdog is a no-op).
CREATE OR REPLACE FUNCTION public.mkt_job_complete(p_job_id uuid, p_result jsonb, p_run_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.mkt_collection_jobs
     SET status='succeeded', result=COALESCE(p_result,'{}'::jsonb), ingestion_run_id=COALESCE(p_run_id, ingestion_run_id),
         finished_at=now(), lease_expires_at=NULL
   WHERE id=p_job_id AND status='running';
$$;

-- Fail (only running): requeue with exponential backoff until max_attempts, then failed.
CREATE OR REPLACE FUNCTION public.mkt_job_fail(p_job_id uuid, p_error text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att int; v_max int; v_delay int;
BEGIN
  SELECT attempts, max_attempts INTO v_att, v_max FROM public.mkt_collection_jobs
   WHERE id=p_job_id AND status='running';
  IF NOT FOUND THEN RETURN 'noop'; END IF;   -- already resolved (watchdog/cancel)
  IF v_att >= v_max THEN
    UPDATE public.mkt_collection_jobs
       SET status='failed', error_message=p_error, finished_at=now(), lease_expires_at=NULL
     WHERE id=p_job_id;
    RETURN 'failed';
  ELSE
    v_delay := LEAST(3600, (power(2, v_att) * 60)::int);   -- 2^attempts min, capped 1h
    UPDATE public.mkt_collection_jobs
       SET status='queued', error_message=p_error, next_run_at=now() + make_interval(secs => v_delay),
           worker_id=NULL, started_at=NULL, lease_expires_at=NULL
     WHERE id=p_job_id;
    RETURN 'requeued';
  END IF;
END $$;

-- Watchdog: reclaim leases whose lease expired (crashed worker) back to queued.
CREATE OR REPLACE FUNCTION public.mkt_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.mkt_collection_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         error_message = COALESCE(error_message,'') || ' [lease expired]',
         next_run_at = now(), worker_id=NULL, started_at=NULL, lease_expires_at=NULL,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
   WHERE status='running' AND lease_expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

-- Manual retry: reset a failed/cancelled job to queued now.
CREATE OR REPLACE FUNCTION public.mkt_job_retry(p_job_id uuid, p_requested_by uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.mkt_collection_jobs
     SET status='queued', attempts=0, next_run_at=now(), error_message=NULL,
         worker_id=NULL, started_at=NULL, lease_expires_at=NULL, finished_at=NULL, requested_by=COALESCE(p_requested_by, requested_by)
   WHERE id=p_job_id AND status IN ('failed','cancelled');
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Scheduler: enqueue due pilot accounts (called by a worker tick). Respects the
-- global pause, per-account enable, cadence, and overlap. Never touches disabled
-- accounts. Caps at max_accounts_per_batch.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mkt_enqueue_due_accounts()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0; v_cap int; v_paused boolean;
BEGIN
  SELECT (value)::boolean INTO v_paused FROM public.mkt_settings WHERE key='collection_paused';
  IF COALESCE(v_paused, true) THEN RETURN 0; END IF;
  SELECT COALESCE((value)::int, 10) INTO v_cap FROM public.mkt_settings WHERE key='max_accounts_per_batch';

  FOR r IN
    SELECT a.id, a.provider, a.last_incremental_at, a.last_metrics_at, a.cadence
      FROM public.mkt_social_accounts a
      JOIN public.mkt_providers pr ON pr.provider_key = a.provider AND pr.is_enabled
     WHERE a.collection_enabled AND a.is_active AND a.provider IS NOT NULL
     ORDER BY a.last_incremental_at NULLS FIRST
     LIMIT v_cap
  LOOP
    -- daily incremental
    IF r.last_incremental_at IS NULL OR r.last_incremental_at < now() - interval '20 hours' THEN
      PERFORM public.mkt_job_enqueue('incremental', r.provider, r.id, '{"reason":"scheduled"}'::jsonb, 100);
      n := n + 1;
    END IF;
    -- daily metrics
    IF r.last_metrics_at IS NULL OR r.last_metrics_at < now() - interval '20 hours' THEN
      PERFORM public.mkt_job_enqueue('post_metrics', r.provider, r.id, '{"reason":"scheduled"}'::jsonb, 120);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Lock down: service-role only.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'mkt_job_enqueue(text,text,uuid,jsonb,int,uuid,uuid)',
    'mkt_job_claim_next(text,int)',
    'mkt_job_complete(uuid,jsonb,uuid)',
    'mkt_job_fail(uuid,text)',
    'mkt_jobs_watchdog()',
    'mkt_job_retry(uuid,uuid)',
    'mkt_enqueue_due_accounts()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;
