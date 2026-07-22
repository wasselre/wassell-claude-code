-- ============================================================================
-- Marketing Intelligence — Operations & Monitoring layer.
--
-- Observability + alerting so the platform can be operated long-term: if
-- anything breaks, goes stale, gets expensive, or silently stops collecting,
-- we know immediately. No new collection features, no new providers.
--
--   * mkt_ops_alerts      — operational alerts (GENERATED, not sent)
--   * mkt_metric_daily    — daily KPI history for charts
--   * mkt_diagnostics     — latest self-check results
--   * mkt_ops_heartbeats  — component liveness (worker / scheduler / ops)
--
-- Aggregation RPCs power the dashboard reads; mkt_ops_evaluate() is the single
-- entry point the worker calls on a timer to capture metrics, run diagnostics,
-- scan freshness, and generate alerts. All writes are SECURITY DEFINER RPCs;
-- reads are open to authenticated users (operational data, non-sensitive).
-- Every statement is guarded so this file is safe to re-run.
-- ============================================================================

BEGIN;

-- ── configurable thresholds (present + overridable in mkt_settings) ──────────
INSERT INTO public.mkt_settings (key, value) VALUES
  ('ops_worker_offline_seconds', '180'),
  ('ops_scheduler_offline_seconds', '5400'),
  ('ops_org_stale_hours', '26'),
  ('ops_provider_stale_hours', '26'),
  ('ops_ads_stale_hours', '48'),
  ('ops_metrics_stale_hours', '48'),
  ('ops_queue_backlog_count', '25'),
  ('ops_queue_backlog_age_minutes', '30'),
  ('ops_collection_timeout_minutes', '20'),
  ('ops_consecutive_failures_alert', '3'),
  ('ops_cost_spike_factor', '3.0'),
  ('ops_cost_spike_floor_usd', '1.0')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mkt_setting_num(p_key text, p_default numeric)
 RETURNS numeric LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT (value#>>'{}')::numeric FROM public.mkt_settings WHERE key=p_key), p_default);
$$;

-- ── tables ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_ops_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,   -- provider_unavailable | auth_failure | queue_backlog | worker_offline |
                                   -- scheduler_offline | consecutive_failures | cost_spike | org_stale |
                                   -- collection_timeout | provider_no_data | ads_stale | metrics_stale | freshness_gap
  severity        text NOT NULL DEFAULT 'warning',  -- info | warning | critical
  subject_type    text,            -- provider | organization | queue | worker | scheduler | system
  subject_id      text,            -- provider_key / org id / etc.
  title           text NOT NULL,
  body            text,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key       text NOT NULL,
  status          text NOT NULL DEFAULT 'open',      -- open | acknowledged | resolved
  occurrences     int  NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ops_alerts_dedup_uidx ON public.mkt_ops_alerts (dedup_key);
CREATE INDEX IF NOT EXISTS mkt_ops_alerts_open_idx ON public.mkt_ops_alerts (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.mkt_metric_daily (
  day        date NOT NULL,
  metric     text NOT NULL,   -- posts_collected | ads_collected | new_campaigns | new_landing_pages |
                              -- new_projects | items_collected | duplicates_prevented | runs | failures |
                              -- provider_cost_usd | avg_latency_ms | success_rate
  provider   text NOT NULL DEFAULT 'all',
  value      numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, metric, provider)
);
CREATE INDEX IF NOT EXISTS mkt_metric_daily_metric_idx ON public.mkt_metric_daily (metric, day);

CREATE TABLE IF NOT EXISTS public.mkt_diagnostics (
  check_name text PRIMARY KEY,   -- db_connectivity | queue_responsive | worker_heartbeat | scheduler_heartbeat |
                                 -- storage_available | provider_connectivity
  status     text NOT NULL,      -- ok | degraded | down
  detail     text,
  latency_ms int,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mkt_ops_heartbeats (
  component    text PRIMARY KEY,  -- worker | scheduler | ops
  last_beat_at timestamptz NOT NULL DEFAULT now(),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── RLS: authenticated read; writes only via SECURITY DEFINER RPCs ──────────
ALTER TABLE public.mkt_ops_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_metric_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_diagnostics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_ops_heartbeats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_ops_alerts_read     ON public.mkt_ops_alerts;
DROP POLICY IF EXISTS mkt_metric_daily_read   ON public.mkt_metric_daily;
DROP POLICY IF EXISTS mkt_diagnostics_read    ON public.mkt_diagnostics;
DROP POLICY IF EXISTS mkt_ops_heartbeats_read ON public.mkt_ops_heartbeats;
CREATE POLICY mkt_ops_alerts_read     ON public.mkt_ops_alerts     FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_metric_daily_read   ON public.mkt_metric_daily   FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_diagnostics_read    ON public.mkt_diagnostics    FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_ops_heartbeats_read ON public.mkt_ops_heartbeats FOR SELECT TO authenticated USING (true);

-- ── writer RPCs ─────────────────────────────────────────────────────────────

-- Idempotent alert emit: new → insert; recurring → bump occurrences + last_seen
-- and REOPEN if it had been resolved. Returns the alert id.
CREATE OR REPLACE FUNCTION public.mkt_alert_emit(
  p_kind text, p_dedup_key text, p_title text, p_severity text DEFAULT 'warning',
  p_subject_type text DEFAULT NULL, p_subject_id text DEFAULT NULL,
  p_body text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_ops_alerts (kind, dedup_key, title, severity, subject_type, subject_id, body, evidence)
  VALUES (p_kind, p_dedup_key, p_title, p_severity, p_subject_type, p_subject_id, p_body, COALESCE(p_evidence,'{}'::jsonb))
  ON CONFLICT (dedup_key) DO UPDATE SET
    last_seen_at = now(),
    occurrences  = mkt_ops_alerts.occurrences + 1,
    title        = EXCLUDED.title,
    severity     = EXCLUDED.severity,
    body         = EXCLUDED.body,
    evidence     = EXCLUDED.evidence,
    status       = CASE WHEN mkt_ops_alerts.status = 'resolved' THEN 'open' ELSE mkt_ops_alerts.status END,
    resolved_at  = CASE WHEN mkt_ops_alerts.status = 'resolved' THEN NULL ELSE mkt_ops_alerts.resolved_at END
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_alert_set_status(p_id uuid, p_status text, p_user uuid DEFAULT NULL)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mkt_ops_alerts SET
    status = p_status,
    acknowledged_by = CASE WHEN p_status='acknowledged' THEN p_user ELSE acknowledged_by END,
    acknowledged_at = CASE WHEN p_status='acknowledged' THEN now() ELSE acknowledged_at END,
    resolved_at     = CASE WHEN p_status='resolved' THEN now() ELSE resolved_at END
  WHERE id = p_id;
$$;

-- Auto-resolve open alerts of a kind/subject whose condition has cleared.
CREATE OR REPLACE FUNCTION public.mkt_alert_resolve(p_kind text, p_subject_id text)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mkt_ops_alerts SET status='resolved', resolved_at=now()
  WHERE kind=p_kind AND coalesce(subject_id,'')=coalesce(p_subject_id,'') AND status<>'resolved';
$$;

CREATE OR REPLACE FUNCTION public.mkt_heartbeat(p_component text, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.mkt_ops_heartbeats (component, last_beat_at, detail)
  VALUES (p_component, now(), COALESCE(p_detail,'{}'::jsonb))
  ON CONFLICT (component) DO UPDATE SET last_beat_at=now(), detail=EXCLUDED.detail;
$$;

CREATE OR REPLACE FUNCTION public.mkt_diagnostic_set(p_check text, p_status text, p_detail text DEFAULT NULL, p_latency_ms int DEFAULT NULL)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.mkt_diagnostics (check_name, status, detail, latency_ms, checked_at)
  VALUES (p_check, p_status, p_detail, p_latency_ms, now())
  ON CONFLICT (check_name) DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail, latency_ms=EXCLUDED.latency_ms, checked_at=now();
$$;

-- ── daily KPI capture (idempotent recompute + upsert) ───────────────────────
CREATE OR REPLACE FUNCTION public.mkt_metrics_capture(p_day date)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  d0 timestamptz := p_day::timestamptz;
  d1 timestamptz := (p_day + 1)::timestamptz;
  v_runs int; v_fail int; v_recv numeric; v_ins numeric; v_updskip numeric; v_cost numeric; v_lat numeric; v_ok numeric; v_total numeric;
BEGIN
  SELECT count(*) FILTER (WHERE status <> 'running'),
         count(*) FILTER (WHERE status='failed'),
         COALESCE(sum((provider_cost->>'dataset_items')::numeric),0),
         COALESCE(sum(items_inserted),0),
         COALESCE(sum(items_updated + items_skipped),0),
         COALESCE(sum((provider_cost->>'usage_total_usd')::numeric),0),
         AVG(EXTRACT(EPOCH FROM (finished_at - started_at))*1000) FILTER (WHERE finished_at IS NOT NULL),
         count(*) FILTER (WHERE status IN ('succeeded','partial')),
         count(*) FILTER (WHERE status <> 'running')
    INTO v_runs, v_fail, v_recv, v_ins, v_updskip, v_cost, v_lat, v_ok, v_total
    FROM public.mkt_ingestion_runs WHERE started_at >= d0 AND started_at < d1;

  INSERT INTO public.mkt_metric_daily (day, metric, provider, value) VALUES
    (p_day,'runs','all',COALESCE(v_runs,0)),
    (p_day,'failures','all',COALESCE(v_fail,0)),
    (p_day,'items_collected','all',COALESCE(v_recv,0)),
    (p_day,'duplicates_prevented','all',COALESCE(v_updskip,0)),
    (p_day,'provider_cost_usd','all',COALESCE(v_cost,0)),
    (p_day,'avg_latency_ms','all',COALESCE(round(v_lat),0)),
    (p_day,'success_rate','all',CASE WHEN COALESCE(v_total,0)>0 THEN round(v_ok/v_total,4) ELSE 0 END),
    (p_day,'posts_collected','all',(SELECT count(*) FROM public.mkt_content_posts WHERE first_seen_at>=d0 AND first_seen_at<d1)),
    (p_day,'ads_collected','all',(SELECT count(*) FROM public.mkt_paid_ads WHERE first_seen_at>=d0 AND first_seen_at<d1)),
    (p_day,'new_campaigns','all',(SELECT count(*) FROM public.mkt_ad_campaigns WHERE first_seen_at>=d0 AND first_seen_at<d1)),
    (p_day,'new_landing_pages','all',(SELECT count(*) FROM public.mkt_landing_pages WHERE first_seen_at>=d0 AND first_seen_at<d1)),
    (p_day,'new_projects','all',(SELECT count(*) FROM public.mkt_project_organizations WHERE first_observed_at>=d0 AND first_observed_at<d1))
  ON CONFLICT (day, metric, provider) DO UPDATE SET value=EXCLUDED.value, updated_at=now();

  -- per-provider cost / runs / failures
  INSERT INTO public.mkt_metric_daily (day, metric, provider, value)
  SELECT p_day, m.metric, r.provider, m.value FROM (
    SELECT provider,
      'provider_cost_usd' AS mc, COALESCE(sum((provider_cost->>'usage_total_usd')::numeric),0) AS cost,
      count(*) FILTER (WHERE status<>'running') AS runs,
      count(*) FILTER (WHERE status='failed') AS fails
    FROM public.mkt_ingestion_runs WHERE started_at>=d0 AND started_at<d1 GROUP BY provider
  ) r, LATERAL (VALUES ('provider_cost_usd', r.cost), ('runs', r.runs), ('failures', r.fails)) AS m(metric, value)
  ON CONFLICT (day, metric, provider) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
END $$;

-- ── health aggregations (jsonb passthrough for the API) ─────────────────────
CREATE OR REPLACE FUNCTION public.mkt_provider_health()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'provider', p.provider_key,
      'display_name', p.display_name,
      'is_enabled', p.is_enabled,
      'health_status', p.health_status,
      'health_detail', p.health_detail,
      'last_checked_at', p.last_checked_at,
      'last_success', (SELECT max(finished_at) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.status IN ('succeeded','partial')),
      'last_failure', (SELECT max(finished_at) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.status='failed'),
      'consecutive_failures', (SELECT count(*) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.status='failed'
          AND r.started_at > COALESCE((SELECT max(started_at) FROM mkt_ingestion_runs s WHERE s.provider=p.provider_key AND s.status IN ('succeeded','partial')), '-infinity'::timestamptz)),
      'avg_run_duration_ms', (SELECT round(avg(EXTRACT(EPOCH FROM (finished_at-started_at))*1000)) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.finished_at IS NOT NULL AND r.started_at > now()-interval '14 days'),
      'avg_response_ms', (SELECT round(avg(EXTRACT(EPOCH FROM (finished_at-started_at))*1000)) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.finished_at IS NOT NULL AND r.started_at > now()-interval '14 days'),
      'runs_14d', (SELECT count(*) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.status<>'running' AND r.started_at > now()-interval '14 days'),
      'success_rate', (SELECT CASE WHEN count(*) FILTER (WHERE status<>'running')>0
          THEN round(count(*) FILTER (WHERE status IN ('succeeded','partial'))::numeric / count(*) FILTER (WHERE status<>'running'),4) ELSE NULL END
          FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.started_at > now()-interval '14 days'),
      'error_rate', (SELECT CASE WHEN count(*) FILTER (WHERE status<>'running')>0
          THEN round(count(*) FILTER (WHERE status='failed')::numeric / count(*) FILTER (WHERE status<>'running'),4) ELSE NULL END
          FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.started_at > now()-interval '14 days'),
      'cost_today', (SELECT COALESCE(sum((provider_cost->>'usage_total_usd')::numeric),0) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.started_at >= date_trunc('day', now())),
      'cost_month', (SELECT COALESCE(sum((provider_cost->>'usage_total_usd')::numeric),0) FROM mkt_ingestion_runs r WHERE r.provider=p.provider_key AND r.started_at >= date_trunc('month', now()))
    ) AS row
    FROM mkt_providers p ORDER BY p.provider_key
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.mkt_org_health()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'is_stale')::boolean DESC NULLS LAST), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'organization_id', o.id,
      'name_ar', o.name_ar, 'name_en', o.name_en, 'org_type', o.org_type,
      'accounts', (SELECT count(*) FROM mkt_social_accounts a WHERE a.organization_id=o.id AND a.collection_enabled),
      'last_success_collection', (SELECT max(a.last_synced_at) FROM mkt_social_accounts a WHERE a.organization_id=o.id),
      'last_metrics_update', (SELECT max(a.last_metrics_at) FROM mkt_social_accounts a WHERE a.organization_id=o.id),
      'last_new_content', (SELECT max(first_seen_at) FROM mkt_content_posts c WHERE c.organization_id=o.id),
      'last_paid_ad', (SELECT max(first_seen_at) FROM mkt_paid_ads pa WHERE pa.organization_id=o.id),
      'cadence', (SELECT to_jsonb(a.cadence) FROM mkt_social_accounts a WHERE a.organization_id=o.id AND a.collection_enabled LIMIT 1),
      'next_scheduled_run', (SELECT min(j.next_run_at) FROM mkt_collection_jobs j JOIN mkt_social_accounts a ON a.id=j.social_account_id WHERE a.organization_id=o.id AND j.status IN ('pending','retrying')),
      'consecutive_failures', (SELECT count(*) FROM mkt_ingestion_runs r JOIN mkt_social_accounts a ON a.id=r.source_account_id WHERE a.organization_id=o.id AND r.status='failed'
          AND r.started_at > COALESCE((SELECT max(s.started_at) FROM mkt_ingestion_runs s JOIN mkt_social_accounts a2 ON a2.id=s.source_account_id WHERE a2.organization_id=o.id AND s.status IN ('succeeded','partial')), '-infinity'::timestamptz)),
      'is_stale', (SELECT COALESCE(max(a.last_synced_at) < now() - (mkt_setting_num('ops_org_stale_hours',26) * interval '1 hour'), true)
          FROM mkt_social_accounts a WHERE a.organization_id=o.id AND a.collection_enabled)
    ) AS row
    FROM mkt_organizations o
    WHERE EXISTS (SELECT 1 FROM mkt_social_accounts a WHERE a.organization_id=o.id AND a.collection_enabled)
       OR o.meta_confirmed
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.mkt_queue_health()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'queued',     (SELECT count(*) FROM mkt_collection_jobs WHERE status='pending'),
    'running',    (SELECT count(*) FROM mkt_collection_jobs WHERE status='running'),
    'retrying',   (SELECT count(*) FROM mkt_collection_jobs WHERE status='retrying'),
    'succeeded_24h', (SELECT count(*) FROM mkt_collection_jobs WHERE status='succeeded' AND finished_at > now()-interval '24 hours'),
    'failed_24h',    (SELECT count(*) FROM mkt_collection_jobs WHERE status='failed' AND updated_at > now()-interval '24 hours'),
    'retried_total', (SELECT COALESCE(sum(GREATEST(attempts-1,0)),0) FROM mkt_collection_jobs WHERE attempts>1),
    'oldest_queued_at',  (SELECT min(created_at) FROM mkt_collection_jobs WHERE status='pending'),
    'longest_running_at',(SELECT min(started_at) FROM mkt_collection_jobs WHERE status='running')
  );
$$;

CREATE OR REPLACE FUNCTION public.mkt_cost_summary()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH runs AS (
    SELECT r.*, (r.provider_cost->>'usage_total_usd')::numeric AS usd, (r.provider_cost->>'dataset_items')::numeric AS items,
           j.kind AS kind, a.organization_id AS org_id
    FROM mkt_ingestion_runs r
    LEFT JOIN mkt_collection_jobs j ON j.ingestion_run_id = r.id
    LEFT JOIN mkt_social_accounts a ON a.id = r.source_account_id
  )
  SELECT jsonb_build_object(
    'today_usd',   (SELECT COALESCE(sum(usd),0) FROM runs WHERE started_at >= date_trunc('day', now())),
    'month_usd',   (SELECT COALESCE(sum(usd),0) FROM runs WHERE started_at >= date_trunc('month', now())),
    'total_usd',   (SELECT COALESCE(sum(usd),0) FROM runs),
    'runs_month',  (SELECT count(*) FROM runs WHERE started_at >= date_trunc('month', now()) AND status<>'running'),
    'items_month', (SELECT COALESCE(sum(items),0) FROM runs WHERE started_at >= date_trunc('month', now())),
    'avg_per_run', (SELECT CASE WHEN count(*) FILTER (WHERE status<>'running')>0 THEN round(sum(usd)/count(*) FILTER (WHERE status<>'running'),4) ELSE 0 END FROM runs WHERE started_at >= date_trunc('month', now())),
    'avg_per_item',(SELECT CASE WHEN COALESCE(sum(items),0)>0 THEN round(sum(usd)/sum(items),4) ELSE 0 END FROM runs WHERE started_at >= date_trunc('month', now())),
    'by_provider', (SELECT COALESCE(jsonb_object_agg(provider, o), '{}'::jsonb) FROM (SELECT provider, jsonb_build_object('usd', round(COALESCE(sum(usd),0),4), 'runs', count(*) FILTER (WHERE status<>'running'), 'items', COALESCE(sum(items),0)) o FROM runs WHERE started_at >= date_trunc('month', now()) GROUP BY provider) p),
    'by_kind',     (SELECT COALESCE(jsonb_object_agg(COALESCE(kind,'other'), o), '{}'::jsonb) FROM (SELECT kind, jsonb_build_object('usd', round(COALESCE(sum(usd),0),4), 'runs', count(*)) o FROM runs WHERE started_at >= date_trunc('month', now()) AND status<>'running' GROUP BY kind) k),
    'by_org',      (SELECT COALESCE(jsonb_agg(o), '[]'::jsonb) FROM (SELECT jsonb_build_object('organization_id', org_id, 'name', (SELECT COALESCE(name_ar,name_en) FROM mkt_organizations WHERE id=org_id), 'usd', round(COALESCE(sum(usd),0),4), 'runs', count(*)) o FROM runs WHERE started_at >= date_trunc('month', now()) AND org_id IS NOT NULL GROUP BY org_id ORDER BY sum(usd) DESC NULLS LAST) og),
    'spike', (SELECT CASE WHEN today > mkt_setting_num('ops_cost_spike_floor_usd',1.0) AND avg7 > 0 AND today > avg7 * mkt_setting_num('ops_cost_spike_factor',3.0)
                     THEN jsonb_build_object('is_spike', true, 'today_usd', round(today,4), 'avg7_usd', round(avg7,4))
                     ELSE jsonb_build_object('is_spike', false, 'today_usd', round(today,4), 'avg7_usd', round(avg7,4)) END
              FROM (SELECT (SELECT COALESCE(sum(usd),0) FROM runs WHERE started_at >= date_trunc('day', now())) AS today,
                           (SELECT COALESCE(avg(dc),0) FROM (SELECT date_trunc('day', started_at) dd, sum(usd) dc FROM runs WHERE started_at >= now()-interval '8 days' AND started_at < date_trunc('day', now()) GROUP BY 1) z) AS avg7) q)
  );
$$;

-- ── freshness scan → emits alerts, returns summary counts ───────────────────
CREATE OR REPLACE FUNCTION public.mkt_freshness_scan()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r record; v_org int:=0; v_gap int:=0; v_prov int:=0; v_ads int:=0; v_met int:=0;
  org_h numeric := mkt_setting_num('ops_org_stale_hours',26);
  prov_h numeric := mkt_setting_num('ops_provider_stale_hours',26);
  ads_h numeric := mkt_setting_num('ops_ads_stale_hours',48);
  met_h numeric := mkt_setting_num('ops_metrics_stale_hours',48);
BEGIN
  -- stale organizations (enabled accounts not synced within cadence window)
  FOR r IN
    SELECT o.id, COALESCE(o.name_ar,o.name_en) nm, max(a.last_synced_at) ls
    FROM mkt_organizations o JOIN mkt_social_accounts a ON a.organization_id=o.id AND a.collection_enabled
    GROUP BY o.id, nm
  LOOP
    IF r.ls IS NULL OR r.ls < now() - (org_h * interval '1 hour') THEN
      PERFORM mkt_alert_emit('org_stale', 'org_stale:'||r.id, 'مؤسسة متوقفة عن التجميع — '||COALESCE(r.nm,'?'),
        'warning','organization',r.id::text, 'آخر تجميع ناجح: '||COALESCE(r.ls::text,'never'),
        jsonb_build_object('last_synced_at', r.ls, 'threshold_hours', org_h));
      v_org := v_org + 1;
      IF r.ls IS NOT NULL AND r.ls < now() - (org_h * 3 * interval '1 hour') THEN
        PERFORM mkt_alert_emit('freshness_gap','freshness_gap:'||r.id,'فجوة طويلة في التجميع — '||COALESCE(r.nm,'?'),
          'critical','organization',r.id::text,'لا يوجد تجميع منذ '||round(EXTRACT(EPOCH FROM (now()-r.ls))/3600)||' ساعة',
          jsonb_build_object('last_synced_at', r.ls));
        v_gap := v_gap + 1;
      END IF;
    ELSE
      PERFORM mkt_alert_resolve('org_stale', r.id::text);
      PERFORM mkt_alert_resolve('freshness_gap', r.id::text);
    END IF;
    -- metrics stale
    IF EXISTS (SELECT 1 FROM mkt_social_accounts a WHERE a.organization_id=r.id AND a.collection_enabled
              AND (a.last_metrics_at IS NULL OR a.last_metrics_at < now() - (met_h * interval '1 hour'))) THEN
      PERFORM mkt_alert_emit('metrics_stale','metrics_stale:'||r.id,'مقاييس قديمة — '||COALESCE(r.nm,'?'),
        'info','organization',r.id::text,NULL,jsonb_build_object('threshold_hours', met_h));
      v_met := v_met + 1;
    ELSE
      PERFORM mkt_alert_resolve('metrics_stale', r.id::text);
    END IF;
  END LOOP;

  -- ads not refreshed (confirmed advertiser with ads whose newest last_seen is stale)
  FOR r IN
    SELECT o.id, COALESCE(o.name_ar,o.name_en) nm, max(pa.last_seen_at) ls, count(*) c
    FROM mkt_organizations o JOIN mkt_paid_ads pa ON pa.organization_id=o.id
    WHERE o.meta_confirmed GROUP BY o.id, nm
  LOOP
    IF r.c > 0 AND (r.ls IS NULL OR r.ls < now() - (ads_h * interval '1 hour')) THEN
      PERFORM mkt_alert_emit('ads_stale','ads_stale:'||r.id,'إعلانات لم تُحدَّث — '||COALESCE(r.nm,'?'),
        'warning','organization',r.id::text,'أحدث ظهور: '||COALESCE(r.ls::text,'?'),jsonb_build_object('last_seen_at', r.ls, 'ad_count', r.c));
      v_ads := v_ads + 1;
    ELSE
      PERFORM mkt_alert_resolve('ads_stale', r.id::text);
    END IF;
  END LOOP;

  -- providers returning no data / no recent success
  FOR r IN SELECT provider_key pk, display_name dn FROM mkt_providers WHERE is_enabled LOOP
    IF NOT EXISTS (SELECT 1 FROM mkt_ingestion_runs x WHERE x.provider=r.pk AND x.status IN ('succeeded','partial') AND x.started_at > now() - (prov_h * interval '1 hour'))
       AND EXISTS (SELECT 1 FROM mkt_ingestion_runs x WHERE x.provider=r.pk) THEN
      PERFORM mkt_alert_emit('provider_no_data','provider_no_data:'||r.pk,'مزوّد لا يُرجع بيانات — '||r.dn,
        'warning','provider',r.pk,'لا تشغيل ناجح خلال '||prov_h||' ساعة',jsonb_build_object('threshold_hours', prov_h));
      v_prov := v_prov + 1;
    ELSE
      PERFORM mkt_alert_resolve('provider_no_data', r.pk);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('org_stale',v_org,'freshness_gap',v_gap,'provider_no_data',v_prov,'ads_stale',v_ads,'metrics_stale',v_met);
END $$;

-- ── SQL-side diagnostics (heartbeat ages + queue) → upsert + worker_offline alert ──
CREATE OR REPLACE FUNCTION public.mkt_run_diagnostics()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  wb timestamptz; sb timestamptz; enabled_n int; ok_n int;
  woff numeric := mkt_setting_num('ops_worker_offline_seconds',180);
  soff numeric := mkt_setting_num('ops_scheduler_offline_seconds',5400);
  prov_h numeric := mkt_setting_num('ops_provider_stale_hours',26);
BEGIN
  PERFORM mkt_diagnostic_set('db_connectivity','ok','reachable',0);
  PERFORM mkt_diagnostic_set('queue_responsive','ok', (SELECT count(*)::text||' jobs' FROM mkt_collection_jobs),0);

  SELECT last_beat_at INTO wb FROM mkt_ops_heartbeats WHERE component='worker';
  IF wb IS NULL THEN
    PERFORM mkt_diagnostic_set('worker_heartbeat','down','no heartbeat recorded',NULL);
    PERFORM mkt_alert_emit('worker_offline','worker_offline','العامل غير متصل (لا نبضة)','critical','worker','worker','No worker heartbeat',jsonb_build_object());
  ELSIF wb < now() - (woff * interval '1 second') THEN
    PERFORM mkt_diagnostic_set('worker_heartbeat','down','stale: '||round(EXTRACT(EPOCH FROM (now()-wb)))||'s',NULL);
    PERFORM mkt_alert_emit('worker_offline','worker_offline','العامل غير متصل','critical','worker','worker','Heartbeat stale '||round(EXTRACT(EPOCH FROM (now()-wb)))||'s',jsonb_build_object('last_beat_at', wb));
  ELSE
    PERFORM mkt_diagnostic_set('worker_heartbeat','ok','fresh',round(EXTRACT(EPOCH FROM (now()-wb))*1000)::int);
    PERFORM mkt_alert_resolve('worker_offline','worker');
  END IF;

  SELECT last_beat_at INTO sb FROM mkt_ops_heartbeats WHERE component='scheduler';
  IF sb IS NULL OR sb < now() - (soff * interval '1 second') THEN
    PERFORM mkt_diagnostic_set('scheduler_heartbeat', CASE WHEN sb IS NULL THEN 'down' ELSE 'degraded' END, COALESCE('stale: '||round(EXTRACT(EPOCH FROM (now()-sb)))||'s','no heartbeat'),NULL);
    PERFORM mkt_alert_emit('scheduler_offline','scheduler_offline','المُجدوِل متوقف','warning','scheduler','scheduler',NULL,jsonb_build_object('last_beat_at', sb));
  ELSE
    PERFORM mkt_diagnostic_set('scheduler_heartbeat','ok','fresh',NULL);
    PERFORM mkt_alert_resolve('scheduler_offline','scheduler');
  END IF;

  -- provider_connectivity derived from recent run success (no HTTP; storage_available is set by the worker)
  SELECT count(*) FILTER (WHERE is_enabled),
         count(*) FILTER (WHERE is_enabled AND EXISTS (SELECT 1 FROM mkt_ingestion_runs x WHERE x.provider=p.provider_key AND x.status IN ('succeeded','partial') AND x.started_at > now() - (prov_h * interval '1 hour')))
    INTO enabled_n, ok_n FROM mkt_providers p;
  PERFORM mkt_diagnostic_set('provider_connectivity',
    CASE WHEN enabled_n=0 THEN 'down' WHEN ok_n=enabled_n THEN 'ok' WHEN ok_n=0 THEN 'down' ELSE 'degraded' END,
    ok_n||'/'||enabled_n||' providers with recent success', NULL);

  RETURN (SELECT COALESCE(jsonb_object_agg(check_name, jsonb_build_object('status',status,'detail',detail,'latency_ms',latency_ms,'checked_at',checked_at)),'{}'::jsonb) FROM mkt_diagnostics);
END $$;

-- ── master evaluator: capture + diagnostics + freshness + queue/cost/failure alerts ──
CREATE OR REPLACE FUNCTION public.mkt_ops_evaluate()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  fresh jsonb; diag jsonb; cost jsonb; q jsonb; r record;
  backlog_n numeric := mkt_setting_num('ops_queue_backlog_count',25);
  backlog_age numeric := mkt_setting_num('ops_queue_backlog_age_minutes',30);
  timeout_m numeric := mkt_setting_num('ops_collection_timeout_minutes',20);
  cons_n numeric := mkt_setting_num('ops_consecutive_failures_alert',3);
  n_pending int; oldest timestamptz;
BEGIN
  PERFORM mkt_heartbeat('ops', jsonb_build_object('at', now()));
  PERFORM mkt_metrics_capture(current_date);
  PERFORM mkt_metrics_capture(current_date - 1);
  diag := mkt_run_diagnostics();
  fresh := mkt_freshness_scan();
  cost := mkt_cost_summary();
  q := mkt_queue_health();

  -- queue backlog
  SELECT count(*), min(created_at) INTO n_pending, oldest FROM mkt_collection_jobs WHERE status='pending';
  IF n_pending >= backlog_n OR (oldest IS NOT NULL AND oldest < now() - (backlog_age * interval '1 minute')) THEN
    PERFORM mkt_alert_emit('queue_backlog','queue_backlog','تكدّس في قائمة المهام','warning','queue','queue',
      n_pending||' مهمة معلّقة',jsonb_build_object('pending', n_pending, 'oldest', oldest));
  ELSE
    PERFORM mkt_alert_resolve('queue_backlog','queue');
  END IF;

  -- collection timeout: running jobs past the ceiling
  FOR r IN SELECT id, kind, provider, started_at FROM mkt_collection_jobs WHERE status='running' AND started_at < now() - (timeout_m * interval '1 minute') LOOP
    PERFORM mkt_alert_emit('collection_timeout','collection_timeout:'||r.id,'مهمة تجاوزت المهلة — '||r.kind,'warning','queue',r.id::text,
      'قيد التشغيل منذ '||round(EXTRACT(EPOCH FROM (now()-r.started_at))/60)||' دقيقة',jsonb_build_object('provider', r.provider, 'started_at', r.started_at));
  END LOOP;

  -- cost spike
  IF (cost->'spike'->>'is_spike')::boolean THEN
    PERFORM mkt_alert_emit('cost_spike','cost_spike:'||current_date,'ارتفاع غير معتاد في التكلفة','critical','system','cost',
      'تكلفة اليوم '||(cost->'spike'->>'today_usd')||'$ مقابل متوسط '||(cost->'spike'->>'avg7_usd')||'$',cost->'spike');
  ELSE
    PERFORM mkt_alert_resolve('cost_spike', 'cost');
  END IF;

  -- consecutive provider failures
  FOR r IN SELECT provider_key pk, display_name dn FROM mkt_providers WHERE is_enabled LOOP
    IF (SELECT count(*) FROM mkt_ingestion_runs x WHERE x.provider=r.pk AND x.status='failed'
        AND x.started_at > COALESCE((SELECT max(s.started_at) FROM mkt_ingestion_runs s WHERE s.provider=r.pk AND s.status IN ('succeeded','partial')),'-infinity'::timestamptz)) >= cons_n THEN
      PERFORM mkt_alert_emit('consecutive_failures','consecutive_failures:'||r.pk,'إخفاقات متتالية — '||r.dn,'critical','provider',r.pk,NULL,
        jsonb_build_object('threshold', cons_n));
    ELSE
      PERFORM mkt_alert_resolve('consecutive_failures', r.pk);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('evaluated_at', now(), 'freshness', fresh, 'diagnostics', diag, 'queue', q,
    'cost_spike', cost->'spike', 'open_alerts', (SELECT count(*) FROM mkt_ops_alerts WHERE status='open'));
END $$;

-- ── top-level dashboard summary ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_ops_dashboard()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH ph AS (SELECT mkt_provider_health() AS v), q AS (SELECT mkt_queue_health() AS v)
  SELECT jsonb_build_object(
    'generated_at', now(),
    'providers', (SELECT v FROM ph),
    'provider_counts', (SELECT jsonb_build_object(
        'healthy', count(*) FILTER (WHERE e->>'health_status'='healthy' OR ((e->>'success_rate')::numeric >= 0.8 AND (e->>'consecutive_failures')::int = 0)),
        'degraded', count(*) FILTER (WHERE (e->>'consecutive_failures')::int BETWEEN 1 AND 2 OR ((e->>'success_rate')::numeric < 0.8 AND (e->>'success_rate') IS NOT NULL)),
        'offline', count(*) FILTER (WHERE (e->>'consecutive_failures')::int >= 3 OR NOT (e->>'is_enabled')::boolean),
        'total', count(*))
      FROM jsonb_array_elements((SELECT v FROM ph)) e),
    'queue', (SELECT v FROM q),
    'diagnostics', (SELECT COALESCE(jsonb_object_agg(check_name, jsonb_build_object('status',status,'detail',detail,'checked_at',checked_at)),'{}'::jsonb) FROM mkt_diagnostics),
    'heartbeats', (SELECT COALESCE(jsonb_object_agg(component, last_beat_at),'{}'::jsonb) FROM mkt_ops_heartbeats),
    'cost', mkt_cost_summary(),
    'open_alerts', (SELECT count(*) FROM mkt_ops_alerts WHERE status='open'),
    'critical_alerts', (SELECT count(*) FROM mkt_ops_alerts WHERE status='open' AND severity='critical'),
    'last_success_collection', (SELECT max(finished_at) FROM mkt_ingestion_runs WHERE status IN ('succeeded','partial')),
    'last_failed_collection', (SELECT max(finished_at) FROM mkt_ingestion_runs WHERE status='failed'),
    'jobs_running', (SELECT count(*) FROM mkt_collection_jobs WHERE status='running'),
    'avg_collection_duration_ms', (SELECT round(avg(EXTRACT(EPOCH FROM (finished_at-started_at))*1000)) FROM mkt_ingestion_runs WHERE finished_at IS NOT NULL AND started_at > now()-interval '7 days'),
    'collections_today', (SELECT count(*) FROM mkt_ingestion_runs WHERE started_at >= date_trunc('day',now()) AND status<>'running'),
    'failures_today', (SELECT count(*) FROM mkt_ingestion_runs WHERE started_at >= date_trunc('day',now()) AND status='failed'),
    'collection_paused', COALESCE((SELECT (value#>>'{}')::boolean FROM mkt_settings WHERE key='collection_paused'), false)
  );
$$;

COMMIT;