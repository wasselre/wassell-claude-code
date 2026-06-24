-- T5 ROLLBACK — undo 2026-06-24_conflict_telemetry_buckets.sql (executable).
-- =====================================================================
-- Directly runnable (no prose). Drops the three T5 objects and restores
-- record_conflict_report(uuid) + conflict_storm_sweep() to their EXACT pre-T5
-- bodies — i.e. the layer-3 (2026-06-21_conflict_storm_layer3_session_ratelimit)
-- and hardening (2026-06-21_conflict_storm_hardening) versions, WITHOUT the T5
-- telemetry-bucket write / rate-sample / prune. record_save is NOT touched.
-- Verified on a Supabase branch: drops all objects, byte-restores both function
-- bodies, functions stay callable, dependency data intact.

BEGIN;

DROP VIEW  IF EXISTS public.conflict_storm_now;
DROP TABLE IF EXISTS public.conflict_telemetry_buckets;
DROP TABLE IF EXISTS public.conflict_rate_samples;

-- Restore record_conflict_report(uuid) — pre-T5 (layer-3) body, no telemetry.
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
BEGIN
  BEGIN
    v_session := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '?');
  EXCEPTION WHEN others THEN v_session := '?'; END;

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

-- Restore conflict_storm_sweep() — pre-T5 (hardening) body, no rate-sample/prune.
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
        'record_save version-conflict storm (rollback rate spiked). Identify the row from the Postgres logs: the version_mismatch ERROR now carries [record=<uuid> model=<uuid> user=<uuid>] and the "current vN" (or grep "record_save_conflict"). Then: ' ||
        'SELECT public.block_conflict_storm_record(''<record-id>'', 15);  -- terminal block, OR ' ||
        'SELECT public.kill_conflict_storm_record(''<record-id>'');  -- backup+delete, collapses the loop (a save then succeeds, clearing the client''s dirty-retry). ' ||
        'If one tab is the source, ALSO revoke that user''s auth session (DELETE auth.sessions/auth.refresh_tokens) — an app-level lockout (users.is_active) does NOT stop a live self-refreshing JWT.'
    ))
    RETURNING id INTO v_alert;
  END IF;

  RETURN jsonb_build_object('storm', true, 'rollback_rate', round(v_rate, 1),
                            'aborted', coalesce(v_aborted, 0), 'active', coalesce(v_active, 0),
                            'alert_id', v_alert);
END;
$$;

GRANT EXECUTE ON FUNCTION public.conflict_storm_sweep() TO service_role;

COMMIT;
