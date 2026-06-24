-- T5 — Durable 10-second conflict-storm telemetry (2026-06-24)
-- =====================================================================
-- The 2026-06-16 / 06-21 storms taught us the hard way that Postgres LOGS are
-- the WRONG place for storm attribution: under flood the log is 100% saturated
-- by the `conflict_storm_blocked` reject line (millisecond cadence), which
-- drowns the identity-rich `record_save_conflict` line and makes the caller
-- unidentifiable exactly when you need it. T5 adds a DURABLE, AGGREGATED,
-- IN-DB telemetry surface that survives log loss and names the offender.
--
-- DESIGN (why this is safe + cheap):
--   * record_save is NOT touched. Its conflict path RAISEs → rolls back → any
--     write there is discarded (see 2026-06-21_conflict_storm_hardening header).
--     Telemetry instead rides on record_conflict_report(), which the client
--     fire-and-forgets on every conflict and which runs in its OWN COMMITTED
--     txn (SECURITY DEFINER) — so its writes persist. This is the hook the
--     hardening migration already established for the auto-throttle counters.
--   * NOT one row per failed request. Conflicts are folded into 10-SECOND
--     BUCKETS keyed by (bucket_start, service, session, tab, record, reason);
--     a storm of N rejects against one offender in a 10s window = ONE row whose
--     `count` is incremented + `last_seen_at` advanced. Row GROWTH under a
--     storm is ~6 rows/min/offender (trivial); the cost is a hot-row UPDATE,
--     the SAME shape as the throttle counters already written on this path.
--   * Identity comes from the T2 service-identity headers (x-wassel-service /
--     -tab / -build / -instance) forwarded into request.headers + the JWT
--     claims (session_id, sub) + a model_id lookup. For the browser SPA path
--     (the storm source) service='spa' and tab/build are present.
--   * reject_reason is INFERRED from current block state at report time
--     (blocked ⇒ 'conflict_storm_blocked', else 'version_mismatch') so the
--     record_conflict_report SIGNATURE stays exactly `(uuid)` — no client change,
--     no PostgREST overload ambiguity, pure CREATE OR REPLACE.
--   * The telemetry write is BEST-EFFORT: wrapped so a telemetry failure can
--     NEVER break the protective throttle it rides on (logged via RAISE WARNING,
--     never silently dropped — see CLAUDE.md silent-failure rules).
--
-- Companion durable aggregate: conflict_storm_sweep() (the autonomous rate
-- detector) now also persists each rollback-rate sample to conflict_rate_samples
-- so even a NON-cooperating old bundle (which never calls record_conflict_report)
-- leaves a durable, queryable rate trace that survives log loss.

BEGIN;

-- 1. Per-offender 10-second buckets -------------------------------------------
CREATE TABLE IF NOT EXISTS public.conflict_telemetry_buckets (
  bucket_start  timestamptz NOT NULL,      -- floor(now()) to 10 seconds
  service       text,                      -- x-wassel-service (e.g. 'spa')
  user_id       uuid,                      -- auth.uid()
  session_id    text,                      -- JWT session_id ('?' when absent)
  tab_id        text,                      -- x-wassel-tab (browser tab/page-load)
  build_id      text,                      -- x-wassel-build (deployed bundle SHA)
  instance      text,                      -- x-wassel-instance (browser: null)
  record_id     uuid NOT NULL,
  model_id      uuid,
  reject_reason text,                      -- 'version_mismatch' | 'conflict_storm_blocked'
  count         int  NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Dedup key. NULLS NOT DISTINCT (PG15+) so two NULL-tab rows in the same bucket
-- still collapse instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS conflict_telemetry_buckets_key
  ON public.conflict_telemetry_buckets
     (bucket_start, service, session_id, tab_id, record_id, reject_reason)
  NULLS NOT DISTINCT;

-- "Recent offenders" scans filter on bucket_start.
CREATE INDEX IF NOT EXISTS idx_conflict_telemetry_buckets_recent
  ON public.conflict_telemetry_buckets (bucket_start DESC);

ALTER TABLE public.conflict_telemetry_buckets ENABLE ROW LEVEL SECURITY;
-- No client policies (same posture as record_conflict_counters / record_save_blocks):
-- only the SECURITY DEFINER writer + service_role read/write it. Regular
-- authenticated users must not see other sessions' ids.

-- 2. Durable aggregate rate samples (survives log loss even w/o client cooperation)
CREATE TABLE IF NOT EXISTS public.conflict_rate_samples (
  sampled_at    timestamptz PRIMARY KEY DEFAULT now(),
  rollback_rate numeric NOT NULL,
  aborted       int,
  active        int,
  storm         boolean NOT NULL DEFAULT false
);
ALTER TABLE public.conflict_rate_samples ENABLE ROW LEVEL SECURITY;

-- 3. record_conflict_report() — LAYER-3 body PRESERVED byte-for-byte, plus a
--    best-effort telemetry-bucket write. Signature unchanged: `(uuid)`.
CREATE OR REPLACE FUNCTION public.record_conflict_report(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_session   text;
  v_count     int;
  v_scount    int;
  v_model     uuid;
  c_window    interval := interval '15 seconds';
  c_trip      int := 8;
  c_block     interval := interval '5 minutes';
  c_swindow   interval := interval '30 seconds';
  c_strip     int := 25;
  c_sblock    interval := interval '10 minutes';
  v_blocked   boolean := false;
  v_sblocked  boolean := false;
  -- T5 telemetry locals
  v_headers   jsonb;
  v_reason    text;
  v_rec_blk   boolean;
  v_sess_blk  boolean;
BEGIN
  BEGIN v_session := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '?');
  EXCEPTION WHEN others THEN v_session := '?'; END;

  -- ── T5 telemetry (best-effort; must NEVER break the throttle below) ──────────
  -- Capture identity + infer reject_reason from CURRENT block state (probed
  -- BEFORE the counter upserts that may set a block this call): if a block is
  -- already active, the reject this report corresponds to was a
  -- conflict_storm_blocked; otherwise it was a version_mismatch.
  BEGIN
    BEGIN v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
    EXCEPTION WHEN others THEN v_headers := NULL; END;

    v_rec_blk := EXISTS (SELECT 1 FROM public.record_save_blocks b
                          WHERE b.record_id = p_record_id AND b.blocked_until > now());
    v_sess_blk := v_session <> '?' AND EXISTS (SELECT 1 FROM public.session_save_blocks s
                          WHERE s.session_id = v_session AND s.blocked_until > now());
    v_reason := CASE WHEN v_rec_blk OR v_sess_blk THEN 'conflict_storm_blocked'
                     ELSE 'version_mismatch' END;

    INSERT INTO public.conflict_telemetry_buckets AS t (
      bucket_start, service, user_id, session_id, tab_id, build_id, instance,
      record_id, model_id, reject_reason, count, first_seen_at, last_seen_at)
    VALUES (
      to_timestamp(floor(extract(epoch FROM now()) / 10) * 10),
      v_headers->>'x-wassel-service',
      auth.uid(),
      v_session,
      v_headers->>'x-wassel-tab',
      v_headers->>'x-wassel-build',
      v_headers->>'x-wassel-instance',
      p_record_id,
      (SELECT model_id FROM public.records WHERE id = p_record_id),
      v_reason,
      1, now(), now())
    ON CONFLICT (bucket_start, service, session_id, tab_id, record_id, reject_reason)
    DO UPDATE SET
      count        = t.count + 1,
      last_seen_at = now(),
      user_id      = COALESCE(t.user_id, EXCLUDED.user_id),
      build_id     = COALESCE(EXCLUDED.build_id, t.build_id),
      instance     = COALESCE(EXCLUDED.instance, t.instance),
      model_id     = COALESCE(t.model_id, EXCLUDED.model_id);
  EXCEPTION WHEN others THEN
    -- Telemetry is observability, never protection. A failure here must not
    -- abort the throttle path below. Log loudly (not a silent swallow) and
    -- continue. SQLSTATE/message identify the exact telemetry failure.
    RAISE WARNING 'record_conflict_report telemetry write failed (non-fatal): % %', SQLSTATE, SQLERRM;
  END;

  -- ── Per-(record, session) auto-throttle counter (UNCHANGED from layer 3) ─────
  INSERT INTO public.record_conflict_counters (record_id, session_id, window_start, count, updated_at)
  VALUES (p_record_id, v_session, now(), 1, now())
  ON CONFLICT (record_id, session_id) DO UPDATE SET
    count = CASE WHEN public.record_conflict_counters.window_start < now() - c_window
                 THEN 1 ELSE public.record_conflict_counters.count + 1 END,
    window_start = CASE WHEN public.record_conflict_counters.window_start < now() - c_window
                       THEN now() ELSE public.record_conflict_counters.window_start END,
    updated_at = now()
  RETURNING count INTO v_count;

  IF v_count >= c_trip THEN
    SELECT model_id INTO v_model FROM public.records WHERE id = p_record_id;
    INSERT INTO public.record_save_blocks (record_id, model_id, blocked_until, reason, created_by)
    VALUES (p_record_id, v_model, now() + c_block,
            format('auto-throttle: %s conflicts/%s from session %s', v_count, c_window, v_session),
            'auto_throttle')
    ON CONFLICT (record_id) DO UPDATE
      SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason,
          model_id = COALESCE(public.record_save_blocks.model_id, EXCLUDED.model_id),
          created_at = now(), created_by = 'auto_throttle';
    INSERT INTO public.system_alerts (kind, severity, detail)
    VALUES ('conflict_auto_block', 'warning', jsonb_build_object(
      'record_id', p_record_id, 'model_id', v_model, 'session_id', v_session,
      'count', v_count, 'blocked_for', c_block::text));
    v_blocked := true;
  END IF;

  -- ── Per-session auto-throttle counter (UNCHANGED from layer 3) ───────────────
  IF v_session <> '?' THEN
    INSERT INTO public.session_conflict_counters (session_id, window_start, count, updated_at)
    VALUES (v_session, now(), 1, now())
    ON CONFLICT (session_id) DO UPDATE SET
      count = CASE WHEN public.session_conflict_counters.window_start < now() - c_swindow
                   THEN 1 ELSE public.session_conflict_counters.count + 1 END,
      window_start = CASE WHEN public.session_conflict_counters.window_start < now() - c_swindow
                         THEN now() ELSE public.session_conflict_counters.window_start END,
      updated_at = now()
    RETURNING count INTO v_scount;

    IF v_scount >= c_strip THEN
      INSERT INTO public.session_save_blocks (session_id, blocked_until, reason)
      VALUES (v_session, now() + c_sblock,
              format('auto-throttle: %s conflicts/%s across records', v_scount, c_swindow))
      ON CONFLICT (session_id) DO UPDATE
        SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason, created_at = now();
      INSERT INTO public.system_alerts (kind, severity, detail)
      VALUES ('conflict_session_block', 'critical', jsonb_build_object(
        'session_id', v_session, 'count', v_scount, 'blocked_for', c_sblock::text));
      v_sblocked := true;
    END IF;
  END IF;

  RETURN jsonb_build_object('count', v_count, 'blocked', v_blocked,
                            'session_count', v_scount, 'session_blocked', v_sblocked);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_conflict_report(uuid) TO authenticated, service_role;

-- 4. conflict_storm_sweep() — detection/alert body PRESERVED, plus: persist each
--    rate sample (durable aggregate) + prune old telemetry on the same 30s tick.
CREATE OR REPLACE FUNCTION public.conflict_storm_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_rollbacks      bigint;
  v_prev_rollbacks bigint;
  v_prev_at        timestamptz;
  v_secs           numeric;
  v_rate           numeric := 0;
  v_aborted        int;
  v_active         int;
  v_recent         timestamptz;
  v_alert          bigint;
  v_storm          boolean := false;
  c_threshold      numeric := 75;
BEGIN
  SELECT sum(xact_rollback) INTO v_rollbacks
  FROM pg_stat_database WHERE datname = current_database();

  SELECT last_rollbacks, last_at INTO v_prev_rollbacks, v_prev_at
  FROM public.conflict_sweep_state WHERE id;

  IF v_prev_rollbacks IS NOT NULL THEN
    v_secs := greatest(extract(epoch FROM (now() - v_prev_at)), 1);
    v_rate := greatest(v_rollbacks - v_prev_rollbacks, 0) / v_secs;
  END IF;

  INSERT INTO public.conflict_sweep_state (id, last_rollbacks, last_at)
  VALUES (true, v_rollbacks, now())
  ON CONFLICT (id) DO UPDATE
    SET last_rollbacks = EXCLUDED.last_rollbacks, last_at = EXCLUDED.last_at;

  SELECT
    count(*) FILTER (WHERE state = 'idle in transaction (aborted)'),
    count(*) FILTER (WHERE state = 'active')
  INTO v_aborted, v_active
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
    AND query ILIKE '%p_expected_version%';

  v_storm := v_prev_rollbacks IS NOT NULL AND v_rate >= c_threshold;

  -- T5: durable aggregate sample every tick (survives log loss even when the
  -- storm source is a NON-cooperating bundle that never calls record_conflict_report).
  BEGIN
    INSERT INTO public.conflict_rate_samples (sampled_at, rollback_rate, aborted, active, storm)
    VALUES (now(), round(v_rate, 1), v_aborted, v_active, v_storm);
    -- Retention prune on the same tick (cheap; keeps both tables bounded).
    DELETE FROM public.conflict_rate_samples       WHERE sampled_at   < now() - interval '30 days';
    DELETE FROM public.conflict_telemetry_buckets  WHERE bucket_start < now() - interval '14 days';
  EXCEPTION WHEN others THEN
    RAISE WARNING 'conflict_storm_sweep telemetry persist/prune failed (non-fatal): % %', SQLSTATE, SQLERRM;
  END;

  IF NOT v_storm THEN
    RETURN jsonb_build_object('storm', false, 'rollback_rate', round(v_rate, 1),
                              'aborted', coalesce(v_aborted, 0), 'active', coalesce(v_active, 0));
  END IF;

  SELECT max(created_at) INTO v_recent
  FROM public.system_alerts
  WHERE kind = 'conflict_storm' AND created_at > now() - interval '10 minutes';

  IF v_recent IS NULL THEN
    INSERT INTO public.system_alerts (kind, severity, detail)
    VALUES ('conflict_storm', 'critical', jsonb_build_object(
      'rollback_rate_per_sec', round(v_rate, 1),
      'aborted_record_save_backends', v_aborted,
      'active_record_save_backends', v_active,
      'runbook',
        'record_save version-conflict storm (rollback rate spiked). NEW (T5): identify the offender WITHOUT the logs — ' ||
        'SELECT * FROM public.conflict_storm_now;  -- top sessions/tabs/records, last 60s. Then: ' ||
        'SELECT public.block_conflict_storm_record(''<record-id>'', 15);  -- terminal block, OR ' ||
        'SELECT public.kill_conflict_storm_record(''<record-id>'');  -- backup+delete, collapses the loop. ' ||
        'If one tab is the source, ALSO revoke that user''s auth session (DELETE auth.sessions/auth.refresh_tokens).'
    ))
    RETURNING id INTO v_alert;
  END IF;

  RETURN jsonb_build_object('storm', true, 'rollback_rate', round(v_rate, 1),
                            'aborted', coalesce(v_aborted, 0), 'active', coalesce(v_active, 0),
                            'alert_id', v_alert);
END;
$$;

GRANT EXECUTE ON FUNCTION public.conflict_storm_sweep() TO service_role;

-- 5. conflict_storm_now — top offenders in the last 60 seconds. -----------------
-- A plain view runs with the owner's rights (bypasses the table RLS), so we
-- restrict it to service_role only (ops reads it via the Supabase SQL editor /
-- a future admin screen). Regular authenticated users get no access.
CREATE OR REPLACE VIEW public.conflict_storm_now AS
SELECT
  service, session_id, tab_id, build_id, instance, user_id,
  record_id, model_id, reject_reason,
  sum(count)         AS conflicts,
  min(first_seen_at) AS first_seen,
  max(last_seen_at)  AS last_seen
FROM public.conflict_telemetry_buckets
WHERE bucket_start >= now() - interval '60 seconds'
GROUP BY service, session_id, tab_id, build_id, instance, user_id,
         record_id, model_id, reject_reason
ORDER BY conflicts DESC
LIMIT 50;

REVOKE ALL ON public.conflict_storm_now FROM PUBLIC, authenticated, anon;
GRANT SELECT ON public.conflict_storm_now TO service_role;

COMMIT;

-- =====================================================================
-- DOWN / ROLLBACK
-- =====================================================================
-- The rollback is a DIRECTLY EXECUTABLE companion file (no copy-paste prose):
--   supabase/migrations/2026-06-24_conflict_telemetry_buckets_down.sql
-- It drops conflict_storm_now / conflict_telemetry_buckets / conflict_rate_samples
-- and restores record_conflict_report(uuid) + conflict_storm_sweep() to their
-- exact pre-T5 (layer-3 / hardening) bodies + grants. Validated on a Supabase
-- branch (objects dropped, function bodies byte-restored, deps intact).
-- =====================================================================
