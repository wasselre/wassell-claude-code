-- Conflict-storm hardening (2026-06-21)
-- =====================================================================
-- Follow-up to 2026-06-16_conflict_storm_watchdog.sql after a SECOND live
-- storm (2026-06-21) that the 06-16 watchdog FAILED to catch: system_alerts
-- stayed empty while ~1,700 record_save/sec failed with version_mismatch.
--
-- Root causes of that miss + this fix:
--
--  1) DETECTION WAS UNRELIABLE. conflict_storm_sweep() counted PostgREST
--     backends sitting in 'idle in transaction (aborted)' via an INSTANTANEOUS
--     pg_stat_activity sample and only alerted at >=3. That state lasts
--     microseconds; at 1,700 req/s across ~5 pooled connections an instant
--     sample almost always sees 0-1, so the >=3 gate never tripped.
--     => Re-base detection on pg_stat_database.xact_rollback RATE between
--        sweeps. Every version_mismatch aborts its txn and increments
--        xact_rollback, so a storm shows as hundreds-to-thousands of
--        rollbacks/sec vs. <~10 under normal load. Impossible to miss.
--
--  2) THE STORMING RECORD WAS UNIDENTIFIABLE. The version_mismatch error only
--     logged the version pair ("loaded v8, current v32"), not which row. The
--     PostgREST RPC binds p_id as a parameter, so pg_stat_activity hides it.
--     => Enrich the exception (and a RAISE LOG line) to carry record_id,
--        model_id, the caller's auth.uid(), the version pair, AND the request
--        source (Referer header). This is the durable "request logging" the
--        incident asked for: it survives the txn abort (log output is not
--        transactional) and is queryable via the logs API.
--
--     NOTE — why logging, not a table: a durable IN-DB conflict counter would
--     have to be written by record_save on the conflict path, but that path
--     RAISEs, which rolls the txn back and discards any write. The only
--     autonomous-write escape hatch (dblink self-connect) requires an embedded
--     DB password on this managed instance ("Non-superusers must provide a
--     password") — we do NOT commit credentials to migrations. So conflict
--     telemetry goes to the server log; the block/kill levers below are the
--     stateful protection.
--
--  3) NO BACKEND THROTTLE. An app-level lockout (users.is_active=false) does
--     NOT stop a live, self-refreshing JWT session, and record_save is
--     SECURITY DEFINER + checks the version FIRST, so stripping permissions
--     can't stop the failing writes either. Only neutralising the target (so a
--     save SUCCEEDS and the client's dirty-state clears) or a terminal block
--     stops a stale authorised client.
--     => record_save_blocks + block_conflict_storm_record(): a cheap, terminal
--        per-record block enforced at the top of record_save. kill_conflict_
--        storm_record() (06-16, backup+delete) remains the proven collapse.

BEGIN;

-- 1. Per-record terminal block -------------------------------------------------
-- Saves to a blocked record are rejected immediately and cheaply (one PK probe)
-- at the top of record_save. Populated by block_conflict_storm_record() / the
-- sweep / ops — NEVER by record_save itself (it can't write durably on the
-- aborting conflict path; see header note 2).
CREATE TABLE IF NOT EXISTS public.record_save_blocks (
  record_id     uuid PRIMARY KEY,
  model_id      uuid,
  blocked_until timestamptz NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);
CREATE INDEX IF NOT EXISTS idx_record_save_blocks_until
  ON public.record_save_blocks (blocked_until);

ALTER TABLE public.record_save_blocks ENABLE ROW LEVEL SECURITY;
-- No client policies: only the SECURITY DEFINER functions / service role touch
-- it. (record_save reads it under definer rights, bypassing RLS.)

-- 2. Sweep state (durable snapshot for rate computation) -----------------------
CREATE TABLE IF NOT EXISTS public.conflict_sweep_state (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_rollbacks bigint      NOT NULL,
  last_at        timestamptz NOT NULL
);
ALTER TABLE public.conflict_sweep_state ENABLE ROW LEVEL SECURITY;

-- 3. record_save: add the terminal block check + enriched conflict telemetry ---
-- Preserves the existing signature, return type, frozen path, p_created_by
-- COALESCE semantics, and the 40001/serialization_failure conflict contract so
-- existing clients (which key off error.code==='40001' / 'version_mismatch')
-- are unaffected. ONLY adds: (a) the block fast-reject, (b) richer conflict
-- message + RAISE LOG.
CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id uuid, p_id uuid, p_data jsonb,
  p_created_by uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_model record;
  v_table text;
  v_existing_version int;
  v_user uuid;
  v_headers jsonb;
  v_claims jsonb;
BEGIN
  -- Terminal storm block (2026-06-21). Cheapest possible: one PK probe on a
  -- normally-empty table. Distinct message so logs/clients can tell it apart;
  -- ERRCODE stays serialization_failure (40001) so the existing client conflict
  -- path (reload + breaker) handles it without any client change.
  PERFORM 1 FROM public.record_save_blocks b
   WHERE b.record_id = p_id AND b.blocked_until > now();
  IF FOUND THEN
    RAISE EXCEPTION
      'conflict_storm_blocked: saves to record % are temporarily blocked after a retry storm', p_id
      USING ERRCODE = 'serialization_failure',
            HINT = 'reload the record; the block clears automatically';
  END IF;

  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found', p_model_id; END IF;

  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format('INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', v_table) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by, p_expected_version);
  ELSE
    IF p_expected_version IS NOT NULL THEN
      SELECT version INTO v_existing_version FROM records WHERE id = p_id;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        v_user := auth.uid();
        -- Full attribution capture (2026-06-21). Durable: RAISE LOG output is
        -- NOT transactional, so it survives this txn's abort (unlike a table
        -- write). Scoped catches: the request.* GUCs are absent for non-PostgREST
        -- callers and may be malformed; a parse failure must NEVER mask the
        -- version conflict, so each defaults to NULL and we still RAISE below.
        -- These fields distinguish caller paths definitively:
        --   role=authenticated + browser ua/referer/x-client-info=supabase-js-web
        --     + a session_id  => browser SPA save path.
        --   role=service_role + no browser headers + no session_id
        --     => a server/worker/automation/AI-agent caller (these pass
        --        p_expected_version=NULL or retry-resolve, so should never storm).
        BEGIN v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
        EXCEPTION WHEN others THEN v_headers := NULL; END;
        BEGIN v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
        EXCEPTION WHEN others THEN v_claims := NULL; END;
        RAISE LOG 'record_save_conflict v2 record=% model=% user=% session=% role=% tab=% build=% expected=% current=% ip=% client=% referer=% path=% ua=%',
          p_id, p_model_id, v_user,
          v_claims->>'session_id', v_claims->>'role',
          v_headers->>'x-wassel-tab', v_headers->>'x-wassel-build',
          p_expected_version, v_existing_version,
          coalesce(v_headers->>'x-forwarded-for', v_headers->>'x-real-ip', v_headers->>'cf-connecting-ip'),
          v_headers->>'x-client-info', v_headers->>'referer',
          current_setting('request.path', true),
          v_headers->>'user-agent';
        RAISE EXCEPTION
          'version_mismatch: record was edited by another user (loaded v%, current v%) [record=% model=% user=% session=% role=%]',
          p_expected_version, v_existing_version, p_id, p_model_id, v_user,
          v_claims->>'session_id', v_claims->>'role'
          USING ERRCODE = 'serialization_failure',
                HINT = 'reload the record to see latest changes';
      END IF;
    END IF;

    INSERT INTO records (id, model_id, data, created_by_user_id)
    VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id),
      updated_at = now();
  END IF;
  RETURN p_id;
END;
$function$;

-- 4. Reliable storm detector (rate-based) --------------------------------------
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
  -- Rollbacks/sec that count as a storm. Normal app load is <~10/s; a
  -- version-conflict storm is hundreds-to-thousands/s. 75 is far from both.
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

  -- Secondary instantaneous signal (kept for context; not the gate anymore).
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

  -- Storm. Dedup: at most one fresh alert per 10 minutes.
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

-- 5. Ops levers ----------------------------------------------------------------
-- Terminal per-record block (item 3: "temporarily block saves to the storming
-- record"). Distinct from kill: the row is preserved; saves to it fast-reject
-- until the block expires.
CREATE OR REPLACE FUNCTION public.block_conflict_storm_record(
  p_id uuid, p_minutes int DEFAULT 15, p_reason text DEFAULT 'conflict storm mitigation')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_model uuid; v_until timestamptz := now() + make_interval(mins => greatest(p_minutes, 1));
BEGIN
  SELECT model_id INTO v_model FROM public.records WHERE id = p_id;

  INSERT INTO public.record_save_blocks (record_id, model_id, blocked_until, reason, created_by)
  VALUES (p_id, v_model, v_until, p_reason, coalesce(auth.uid()::text, 'service_role'))
  ON CONFLICT (record_id) DO UPDATE
    SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason,
        model_id = COALESCE(public.record_save_blocks.model_id, EXCLUDED.model_id),
        created_at = now(), created_by = EXCLUDED.created_by;

  INSERT INTO public.system_alerts (kind, severity, detail)
  VALUES ('conflict_storm_blocked', 'info',
          jsonb_build_object('record_id', p_id, 'model_id', v_model,
                             'blocked_until', v_until, 'reason', p_reason));

  RETURN jsonb_build_object('blocked', true, 'record_id', p_id, 'blocked_until', v_until);
END;
$$;

-- Lift a block early (after the source tab is gone / record neutralised).
CREATE OR REPLACE FUNCTION public.unblock_conflict_storm_record(p_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
  DELETE FROM public.record_save_blocks WHERE record_id = p_id;
  SELECT jsonb_build_object('unblocked', true, 'record_id', p_id);
$$;

-- Log -> id bridge: read "current vN" from the version_mismatch log line, then
-- this returns the candidate row(s) at that version with staleness, so the
-- operator can confirm the exact id without guessing.
CREATE OR REPLACE FUNCTION public.conflict_storm_candidates(p_version int)
RETURNS TABLE (record_id uuid, model_id uuid, model_name text, version int,
               updated_at timestamptz, stale interval)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
  SELECT r.id, r.model_id, m.name, r.version, r.updated_at, now() - r.updated_at
  FROM public.records r
  LEFT JOIN public.models m ON m.id = r.model_id
  WHERE r.version = p_version
  ORDER BY r.updated_at ASC;
$$;

-- 6. Automatic per-session throttle (item 3: repeated conflicts become cheap+terminal)
-- ---------------------------------------------------------------------------------
-- record_save itself CANNOT durably count conflicts (its conflict path RAISEs,
-- which rolls the txn back and discards any write; dblink autonomous-commit needs
-- an embedded password we won't ship). So the count lives in a SEPARATE,
-- COMMITTING RPC the client fire-and-forgets on every version_mismatch. Once one
-- (record, session) crosses the threshold in the window, it auto-sets a short
-- record-wide block — after which record_save's top-of-function check fast-rejects
-- every further save (one PK probe + terminal raise), so a blind-retry loop stays
-- cheap and terminal WITHOUT an operator in the loop.
--
-- Honest limit: this is client-cooperative (a CURRENT bundle reports its own
-- conflicts). A genuinely old bundle that never calls record_conflict_report is
-- still caught autonomously by the rate-based conflict_storm_sweep (sec.4) +
-- alert; the DB cannot make a non-cooperating client stop SENDING requests — only
-- close-the-tab / session-revoke / edge rate-limiting does that. The block keeps
-- its per-request cost minimal regardless.
CREATE TABLE IF NOT EXISTS public.record_conflict_counters (
  record_id    uuid NOT NULL,
  session_id   text NOT NULL,            -- JWT session_id ('?' when absent)
  window_start timestamptz NOT NULL,
  count        int NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, session_id)
);
ALTER TABLE public.record_conflict_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_conflict_report(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_session  text;
  v_count    int;
  v_model    uuid;
  c_window   interval := interval '15 seconds';
  c_trip     int := 8;     -- conflicts per (record, session) per window → block
  c_block    interval := interval '5 minutes';
BEGIN
  -- Identify the caller's session from its JWT (not client-supplied → unspoofable
  -- by the page). Falls back to '?' for callers without a session claim.
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

  IF v_count < c_trip THEN
    RETURN jsonb_build_object('count', v_count, 'blocked', false);
  END IF;

  -- Trip: auto-block the record (record-wide, short). record_save fast-rejects
  -- terminally after this. Reason records the offending session for forensics.
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

  RETURN jsonb_build_object('count', v_count, 'blocked', true,
                            'blocked_until', now() + c_block);
END;
$$;

-- 7. Grants — the Fly worker (service role) drives the sweep; ops levers too;
--    record_conflict_report is called by the browser (authenticated). ----------
GRANT EXECUTE ON FUNCTION public.conflict_storm_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION public.block_conflict_storm_record(uuid, int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unblock_conflict_storm_record(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conflict_storm_candidates(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_conflict_report(uuid) TO authenticated, service_role;

COMMIT;
