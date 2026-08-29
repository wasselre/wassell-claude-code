-- 2026-08-29  Server-authoritative auto-kill for record_save version-conflict storms.
--
-- WHY: every prior storm (see docs/conflict-storm-hardening.md + the
-- supabase-cpu-version-conflict-storm memory) ended with a HUMAN hunting the hot
-- record/session by hand. The existing auto-throttle (record_conflict_report) is
-- CLIENT-COOPERATIVE — a non-cooperating client (old bundle, headless/cloud
-- browser, zombie serverless instance) never calls it, so the counter never
-- trips; and even when it does, it blocks in 'reject' mode, which the incident
-- history proves does NOT stop a non-cooperating loop (only 'noop' — returning
-- SUCCESS — makes a retry loop end).
--
-- The 2026-08-29 storm: a 6-day-old Windows/Chrome session on a Vultr datacenter
-- IP, authed as the owner, looping record_save on a followups record (loaded v2,
-- current v3) at ~1,158 rollbacks/sec → 76% CPU. It never called
-- record_conflict_report and was on the CURRENT build, so no existing layer
-- reached it. Manual fix = session noop-block + auth-session revoke.
--
-- THIS MIGRATION makes that automatic and requires NO worker deploy and NO
-- pg_cron (not enabled here): the Fly worker already calls conflict_storm_sweep()
-- every 30s. Two pieces:
--
-- 1. NEW record-block mode 'noop_stale' on record_save_blocks. Unlike 'noop'
--    (which no-ops ALL writes to the record — unsafe on a record that also gets
--    legitimate/automation writes), 'noop_stale' ONLY silences a STALE write
--    (p_expected_version present AND <> current). A stale write is wrong by
--    definition and must never be applied, so silencing it loses no real data:
--      • automation writes (p_expected_version = NULL)         → pass through, write normally
--      • in-version writes (p_expected_version = current)       → pass through, write normally
--      • stale writes (the storm)                               → RETURN success WITHOUT writing → the loop ends
--    This is why it is SAFE to apply automatically, even on a live record.
--
-- 2. conflict_storm_sweep() gains an auto-detect step that runs ONLY during a
--    confirmed global rollback storm (rate >= 75/s). It locates the single
--    hammered record via the xmax method (the row FOR UPDATE-locked thousands of
--    times/sec sits FAR ahead of every other recently-locked row — measured
--    8,000,000 xids ahead in this incident) and noop_stale-blocks it for 30 min
--    + raises a system_alert. Because noop_stale is data-safe, a rare mis-target
--    cannot corrupt or lose data; worst case is a 30-min self-clearing block.
--
-- Containment still complements the code fix in the followups save path
-- (task_84045e7b) — this stops the CPU bleed; the client fix stops the loop being
-- created in the first place.

BEGIN;

-- ── 1. record_save: honor the new 'noop_stale' record-block mode ──────────────
-- Re-emitted verbatim from the live definition with only the noop_stale branches
-- added (top record-block check + the version-conflict branch).
CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id uuid, p_id uuid, p_data jsonb,
  p_created_by uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_model record; v_table text; v_existing_version int; v_user uuid; v_headers jsonb; v_claims jsonb; v_session text; v_block_mode text;
BEGIN
  BEGIN v_claims := nullif(current_setting('request.jwt.claims', true),'')::jsonb; EXCEPTION WHEN others THEN v_claims := NULL; END;
  v_session := v_claims->>'session_id';
  IF v_session IS NOT NULL THEN
    SELECT s.mode INTO v_block_mode FROM public.session_save_blocks s WHERE s.session_id = v_session AND s.blocked_until > now();
    IF FOUND THEN
      IF v_block_mode = 'noop' THEN RETURN p_id; END IF;
      RAISE EXCEPTION 'conflict_storm_blocked: this session is rate-limited after repeated version conflicts'
        USING ERRCODE='serialization_failure', HINT='reload the page to continue';
    END IF;
  END IF;
  v_block_mode := NULL;
  SELECT b.mode INTO v_block_mode FROM public.record_save_blocks b WHERE b.record_id = p_id AND b.blocked_until > now();
  IF FOUND THEN
    IF v_block_mode = 'noop' THEN RETURN p_id; END IF;
    -- 'noop_stale' does NOT block here: it must let automation (NULL expected) and
    -- in-version writes through, and only silences a stale write in the conflict
    -- branch below. Any other mode (e.g. 'reject') is a terminal block.
    IF v_block_mode IS DISTINCT FROM 'noop_stale' THEN
      RAISE EXCEPTION 'conflict_storm_blocked: saves to record % are temporarily blocked after a retry storm', p_id
        USING ERRCODE='serialization_failure', HINT='reload the record; the block clears automatically';
    END IF;
  END IF;
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found', p_model_id; END IF;
  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format('INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', v_table) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by, p_expected_version);
  ELSE
    IF p_expected_version IS NOT NULL THEN
      -- FOR UPDATE (2026-07-18): lock the row BEFORE the version check so
      -- check+write are atomic. Without it, two writers could both pass the
      -- check and the second silently overwrote the first's committed data.
      SELECT version INTO v_existing_version FROM records WHERE id = p_id FOR UPDATE;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        -- AUTO-KILL containment: on a record flagged 'noop_stale' by the storm
        -- sweep, a stale writer succeeds WITHOUT writing so its retry loop ends.
        -- The write is stale (loaded v <> current v) and must never be applied.
        IF v_block_mode = 'noop_stale' THEN
          RETURN p_id;
        END IF;
        v_user := auth.uid();
        BEGIN v_headers := nullif(current_setting('request.headers', true),'')::jsonb; EXCEPTION WHEN others THEN v_headers := NULL; END;
        RAISE LOG 'record_save_conflict v2 record=% model=% user=% session=% role=% tab=% build=% expected=% current=% ip=% client=% referer=% path=% ua=%',
          p_id, p_model_id, v_user, v_session, v_claims->>'role', v_headers->>'x-wassel-tab', v_headers->>'x-wassel-build',
          p_expected_version, v_existing_version, coalesce(v_headers->>'x-forwarded-for',v_headers->>'x-real-ip',v_headers->>'cf-connecting-ip'),
          v_headers->>'x-client-info', v_headers->>'referer', current_setting('request.path', true), v_headers->>'user-agent';
        RAISE EXCEPTION 'version_mismatch: record was edited by another user (loaded v%, current v%) [record=% model=% user=% session=% role=%]',
          p_expected_version, v_existing_version, p_id, p_model_id, v_user, v_session, v_claims->>'role'
          USING ERRCODE='serialization_failure', HINT='reload the record to see latest changes';
      END IF;
    END IF;
    INSERT INTO records (id, model_id, data, created_by_user_id) VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id), updated_at = now();
  END IF;
  RETURN p_id;
END;
$function$;

-- ── 2. conflict_storm_sweep: auto-noop_stale the hammered record during a storm ─
-- Re-emitted verbatim from the live definition with the AUTO-KILL nested block
-- added just before the storm-branch RETURN.
CREATE OR REPLACE FUNCTION public.conflict_storm_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
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
  v_auto_killed    jsonb := '[]'::jsonb;
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

  SELECT coalesce(jsonb_agg(o), '[]'::jsonb) INTO v_offenders
  FROM (
    SELECT service, session_id, tab_id, build_id, record_id, model_id, reject_reason,
           sum(count) AS conflicts
    FROM public.conflict_telemetry_buckets
    WHERE bucket_start >= now() - interval '60 seconds'
    GROUP BY 1,2,3,4,5,6,7
    ORDER BY conflicts DESC LIMIT 5
  ) o;

  SELECT round(extract(epoch FROM (now() - max(sampled_at))) / 60, 1) INTO v_storm_minutes
  FROM public.conflict_rate_samples WHERE NOT storm;

  -- ── AUTO-KILL (2026-08-29): find the hammered record via xmax and noop_stale it ──
  -- Only reached during a confirmed storm. The row being FOR UPDATE-locked
  -- ~thousands/sec has, by far, the newest xmax; it sits a huge distance ahead of
  -- every other recently-locked row. noop_stale is data-safe (only silences stale
  -- writes), so we act on that single dominant row automatically.
  DECLARE
    v_target       uuid;
    v_target_model uuid;
    v_target_ver   int;
    v_top_age      bigint;
    v_next_age     bigint;
    v_gap          bigint;
    v_recent_ns    timestamptz;
  BEGIN
    SELECT id, model_id, version, age(xmax)::bigint
      INTO v_target, v_target_model, v_target_ver, v_top_age
    FROM records
    WHERE xmax <> '0'::xid
    ORDER BY age(xmax) ASC
    LIMIT 1;

    IF v_target IS NOT NULL THEN
      SELECT age(xmax)::bigint INTO v_next_age
      FROM records
      WHERE xmax <> '0'::xid AND id <> v_target
      ORDER BY age(xmax) ASC
      LIMIT 1;

      -- Dominance gap: how far the #1 churner leads the #2 recently-locked row.
      -- During a real storm this is enormous (8,000,000 in the 2026-08-29 case);
      -- a merely-busy record leads by only a handful. 50,000 is a conservative
      -- floor that a genuine hammer clears by orders of magnitude.
      v_gap := COALESCE(v_next_age, v_top_age) - v_top_age;

      IF v_gap >= 50000
         AND NOT EXISTS (SELECT 1 FROM public.record_save_blocks b
                          WHERE b.record_id = v_target AND b.blocked_until > now()) THEN
        INSERT INTO public.record_save_blocks (record_id, model_id, blocked_until, reason, created_by, mode)
        VALUES (v_target, v_target_model, now() + interval '30 minutes',
                format('auto noop_stale: hammered record (version frozen at %s, xmax %s xids ahead of field) during %s rollbacks/s storm',
                       v_target_ver, v_gap, round(v_rate,1)),
                'auto_noop_stale', 'noop_stale')
        ON CONFLICT (record_id) DO UPDATE
          SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason,
              model_id = COALESCE(public.record_save_blocks.model_id, EXCLUDED.model_id),
              created_at = now(), created_by = 'auto_noop_stale', mode = 'noop_stale';

        v_auto_killed := jsonb_build_array(jsonb_build_object(
          'record_id', v_target, 'model_id', v_target_model,
          'frozen_version', v_target_ver, 'xmax_gap', v_gap));

        SELECT max(created_at) INTO v_recent_ns FROM public.system_alerts
         WHERE kind = 'conflict_auto_noop_stale'
           AND detail->>'record_id' = v_target::text
           AND created_at > now() - interval '30 minutes';
        IF v_recent_ns IS NULL THEN
          INSERT INTO public.system_alerts (kind, severity, detail)
          VALUES ('conflict_auto_noop_stale', 'critical', jsonb_build_object(
            'record_id', v_target, 'model_id', v_target_model, 'frozen_version', v_target_ver,
            'xmax_gap', v_gap, 'rollback_rate_per_sec', round(v_rate,1),
            'action', 'auto noop_stale block for 30m: stale writers now succeed-without-writing so their retry loop ends; automation + in-version writes are unaffected',
            'note', 'if this record must NOT be write-suppressed, DELETE its record_save_blocks row. Identify the client from the record_save_conflict Postgres log line (session/build/ip) and, if it is one runaway session, revoke it.'));
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'conflict_storm_sweep auto-kill failed (non-fatal): % %', SQLSTATE, SQLERRM;
  END;

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
      'auto_killed', v_auto_killed,
      'runbook',
        'record_save version-conflict storm. The sweep AUTO-noop_stale-blocks the dominant hammered record (see auto_killed); ' ||
        'that alone collapses most storms (stale writers now succeed-without-writing, so their loop ends). ' ||
        'If auto_killed is EMPTY, no single record dominated — identify the hot record live: sample pg_locks (locktype=''tuple'', ' ||
        'relation=records) via ctid, or SELECT id,version,xmax FROM records WHERE xmax<>0 ORDER BY age(xmax) LIMIT 5. Then ' ||
        'INSERT a record_save_blocks row with mode=''noop_stale'' (data-safe: only silences stale writes). If ONE session is the ' ||
        'source (see the record_save_conflict Postgres log line), also noop-block or revoke that auth session.'
    ))
    RETURNING id INTO v_alert;
  END IF;

  RETURN jsonb_build_object('storm', true, 'rollback_rate', round(v_rate, 1),
                            'storm_run_minutes', v_storm_minutes,
                            'aborted', coalesce(v_aborted, 0), 'active', coalesce(v_active, 0),
                            'top_offenders', v_offenders,
                            'auto_killed', v_auto_killed,
                            'alert_id', v_alert);
END;
$function$;

COMMIT;
