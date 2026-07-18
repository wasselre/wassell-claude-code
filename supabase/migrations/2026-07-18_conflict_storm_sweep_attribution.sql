-- conflict_storm_sweep: attribution + storm-duration in the alert (2026-07-18)
-- =====================================================================
-- POSTMORTEM CONTEXT: from 2026-07-05 to 2026-07-18 the sweep correctly
-- detected a REAL storm (~1,600 rollbacks/sec, ~150M failed transactions/day)
-- but the alert carried no attribution, so it fired every 10 minutes for 13
-- days unactioned. The offenders turned out to be two zombie browser tabs on
-- months-old pre-1340f07 SPA bundles tight-looping stale-version record_save
-- retries against dead chat_templates drafts (+ the flood saturated the
-- hosted Postgres log indexer ~9 hours behind, which killed the documented
-- "grep record_save_conflict" runbook exactly when it was needed).
--
-- The threshold (75/s) is NOT changed: the pre-storm baseline is ~0/s and the
-- detector was RIGHT. What changes:
--   1. The alert (and the RPC response) now carry `top_offenders` — the top-5
--      rows from conflict_telemetry_buckets over the last 60s (cooperating
--      clients self-report identity there; empty for non-cooperating clients,
--      in which case aborted/active backend counts remain the fallback).
--   2. `storm_run_minutes` — minutes since the last calm sample in
--      conflict_rate_samples. A storm that has run for hours reads very
--      differently from a fresh one; the worker log prints it too.
--   3. A NEW alert row is inserted (10-min dedup unchanged) — but when the
--      storm has been running >60 min, the dedup key includes the hour so a
--      long-running storm re-alerts hourly instead of only once ever.
-- Detection semantics and all protective behavior are unchanged.

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
  v_offenders      jsonb;
  v_storm_minutes  numeric;
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

  BEGIN
    INSERT INTO public.conflict_rate_samples (sampled_at, rollback_rate, aborted, active, storm)
    VALUES (now(), round(v_rate, 1), v_aborted, v_active, v_storm);
    DELETE FROM public.conflict_rate_samples       WHERE sampled_at   < now() - interval '30 days';
    DELETE FROM public.conflict_telemetry_buckets  WHERE bucket_start < now() - interval '14 days';
  EXCEPTION WHEN others THEN
    RAISE WARNING 'conflict_storm_sweep telemetry persist/prune failed (non-fatal): % %', SQLSTATE, SQLERRM;
  END;

  IF NOT v_storm THEN
    RETURN jsonb_build_object('storm', false, 'rollback_rate', round(v_rate, 1),
                              'aborted', coalesce(v_aborted, 0), 'active', coalesce(v_active, 0));
  END IF;

  -- Attribution: top self-reported offenders in the last 60s (may be empty for
  -- non-cooperating clients — old bundles / server-side loops don't report).
  SELECT coalesce(jsonb_agg(o), '[]'::jsonb) INTO v_offenders
  FROM (
    SELECT service, session_id, tab_id, build_id, record_id, model_id, reject_reason,
           sum(count) AS conflicts
    FROM public.conflict_telemetry_buckets
    WHERE bucket_start >= now() - interval '60 seconds'
    GROUP BY 1,2,3,4,5,6,7
    ORDER BY conflicts DESC LIMIT 5
  ) o;

  -- How long has the storm been running? Minutes since the last calm sample.
  SELECT round(extract(epoch FROM (now() - max(sampled_at))) / 60, 1) INTO v_storm_minutes
  FROM public.conflict_rate_samples WHERE NOT storm;

  -- Dedup: 10 minutes normally; a storm running >60 min re-alerts hourly so a
  -- long-lived storm cannot fall silent after its first alert (the 07-05→07-18
  -- failure mode: one storm, 13 days, alert fatigue then nothing actionable).
  SELECT max(created_at) INTO v_recent
  FROM public.system_alerts
  WHERE kind = 'conflict_storm'
    AND created_at > now() - CASE WHEN coalesce(v_storm_minutes, 0) > 60
                                  THEN interval '60 minutes'
                                  ELSE interval '10 minutes' END;

  IF v_recent IS NULL THEN
    INSERT INTO public.system_alerts (kind, severity, detail)
    VALUES ('conflict_storm', 'critical', jsonb_build_object(
      'rollback_rate_per_sec', round(v_rate, 1),
      'storm_run_minutes', v_storm_minutes,
      'aborted_record_save_backends', v_aborted,
      'active_record_save_backends', v_active,
      'top_offenders', v_offenders,
      'runbook',
        'record_save version-conflict storm. top_offenders (above) names cooperating clients; if EMPTY the ' ||
        'offender is a non-reporting client (old bundle / server loop) — the Postgres logs may lag HOURS under ' ||
        'flood, so identify the hot record live instead: sample pg_locks (locktype=''tuple'', relation=records) ' ||
        'and map page/tuple via ctid, or check pg_stat_statements deltas. Then: ' ||
        'SELECT public.block_conflict_storm_record(''<record-id>'', 15); (terminal reject) — or for a DEAD record ' ||
        'INSERT a record_save_blocks row with mode=''noop'' (instant success breaks any retry loop; NEVER noop a ' ||
        'record still receiving legitimate edits). If one tab is the source, also revoke that user''s auth session.'
    ))
    RETURNING id INTO v_alert;
  END IF;

  RETURN jsonb_build_object('storm', true, 'rollback_rate', round(v_rate, 1),
                            'storm_run_minutes', v_storm_minutes,
                            'aborted', coalesce(v_aborted, 0), 'active', coalesce(v_active, 0),
                            'top_offenders', v_offenders,
                            'alert_id', v_alert);
END;
$$;

GRANT EXECUTE ON FUNCTION public.conflict_storm_sweep() TO service_role;
