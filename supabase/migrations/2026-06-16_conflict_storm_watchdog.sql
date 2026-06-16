-- Conflict-storm watchdog (2026-06-16)
-- =====================================================================
-- Safety net for the record_save version-conflict retry storm (the
-- 2026-06-16 incident: a stale browser tab hammered record_save ~1k req/s
-- with a wedged version, pinning Postgres CPU for ~13 days undetected).
--
-- The client-side fixes (permanent breaker + reload-on-conflict in
-- appStore.ts) eliminate the SOURCE for any current/future client. This
-- migration adds the LAST line of defense — detection + a loud alert — so
-- that even an old/buggy client can never again run unnoticed: the Fly
-- worker calls conflict_storm_sweep() on a short interval, and a storm
-- raises a system_alerts row + a loud worker log within ~1 minute.
--
-- Detection is READ-ONLY (no instrumentation of record_save, which would
-- be rolled back by the conflict's own transaction abort anyway): it counts
-- PostgREST backends wedged in a record_save version-conflict via
-- pg_stat_activity. Normal load leaves ~0; a storm leaves several at once.

-- 1. Operational alert feed -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_alerts (
  id          bigserial PRIMARY KEY,
  kind        text        NOT NULL,
  severity    text        NOT NULL DEFAULT 'warning',
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_kind_created
  ON public.system_alerts (kind, created_at DESC);

ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;
-- Operational metadata (no customer data) — any signed-in user may read it
-- so the app can surface a banner. Writes happen only through the
-- SECURITY DEFINER functions below / service role.
DROP POLICY IF EXISTS system_alerts_select ON public.system_alerts;
CREATE POLICY system_alerts_select ON public.system_alerts
  FOR SELECT TO authenticated USING (true);

-- 2. Read-only storm detector ----------------------------------------------
CREATE OR REPLACE FUNCTION public.conflict_storm_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_aborted int;
  v_active  int;
  v_recent  timestamptz;
  v_alert   bigint;
BEGIN
  -- 'idle in transaction (aborted)' on the record_save RPC = a save that just
  -- failed the version check and is mid-rollback. A handful simultaneously is
  -- the signature of a retry storm; normal load leaves ~0.
  SELECT
    count(*) FILTER (WHERE state = 'idle in transaction (aborted)'),
    count(*) FILTER (WHERE state = 'active')
  INTO v_aborted, v_active
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
    AND query ILIKE '%p_expected_version%';

  IF coalesce(v_aborted, 0) < 3 THEN
    RETURN jsonb_build_object('storm', false, 'aborted', coalesce(v_aborted,0), 'active', coalesce(v_active,0));
  END IF;

  -- Storm. Dedup: at most one fresh alert per 10 minutes.
  SELECT max(created_at) INTO v_recent
  FROM public.system_alerts
  WHERE kind = 'conflict_storm' AND created_at > now() - interval '10 minutes';

  IF v_recent IS NULL THEN
    INSERT INTO public.system_alerts (kind, severity, detail)
    VALUES ('conflict_storm', 'critical', jsonb_build_object(
      'aborted_record_save_backends', v_aborted,
      'active_record_save_backends', v_active,
      'runbook', 'record_save version-conflict storm. Find the hammered record in the Postgres logs (version_mismatch lines: the "current vN" maps to a row at that version), then SELECT public.kill_conflict_storm_record(''<record-id>''). Client-side fixes make this rare; an alert here usually means a pre-fix tab is still open.'
    ))
    RETURNING id INTO v_alert;
  END IF;

  RETURN jsonb_build_object('storm', true, 'aborted', v_aborted, 'active', v_active, 'alert_id', v_alert);
END;
$$;

-- 3. One-call kill helper (the proven mitigation) --------------------------
-- Backs up then deletes a wedged record. The storming client's next save then
-- takes the INSERT path (row gone -> no version check -> succeeds), which
-- breaks the retry loop (proven live 2026-06-16: 1,280 -> 7 req/s). The record
-- reappears at v1, intact. Unfrozen (records-table) models only.
CREATE OR REPLACE FUNCTION public.kill_conflict_storm_record(p_id uuid, p_reason text DEFAULT 'conflict storm mitigation')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_model uuid;
BEGIN
  SELECT model_id INTO v_model FROM public.records WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('killed', false, 'reason', 'record not found in records table (frozen model or bad id?)');
  END IF;

  CREATE TABLE IF NOT EXISTS public._backup_conflict_storm_kills (
    backed_up_at timestamptz NOT NULL DEFAULT now(),
    reason text,
    LIKE public.records
  );
  INSERT INTO public._backup_conflict_storm_kills
    SELECT now(), p_reason, r.* FROM public.records r WHERE r.id = p_id;

  DELETE FROM public.records WHERE id = p_id;

  INSERT INTO public.system_alerts (kind, severity, detail)
  VALUES ('conflict_storm_killed', 'info',
          jsonb_build_object('record_id', p_id, 'model_id', v_model, 'reason', p_reason));

  RETURN jsonb_build_object('killed', true, 'record_id', p_id, 'model_id', v_model);
END;
$$;

-- 4. Grants — the Fly worker (service role) drives the sweep ----------------
GRANT EXECUTE ON FUNCTION public.conflict_storm_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION public.kill_conflict_storm_record(uuid, text) TO service_role;
