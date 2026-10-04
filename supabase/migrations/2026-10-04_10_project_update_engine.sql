-- Automated project updates — the engine (2026-10-04).
--
-- Every project in the update list (`unit_updates`, تحديثات الوحدات) used to be
-- refreshed by hand: a Claude session read the project's migration_instructions
-- and reconciled the CRM against the developer's portal. On 2026-10-04, 34 of
-- the 37 active projects were past their next_due. This migration adds the
-- queue + audit trail the Fly worker's `project_update` lane drives:
--
--   project_update_settings  one row: kill switch, which sources run on a
--                            schedule, the safety-brake thresholds.
--   project_update_runs      one row per run (a whole portal, or one WhatsApp
--                            batch). status = queue state; outcome = what the
--                            run did (applied / no_change / held / dry_run).
--   project_update_changes   one row per record the run touched, with the
--                            BEFORE and AFTER values of exactly the keys it
--                            changed — so a run can be undone (project_update_revert).
--
-- Changes APPLY on their own (operator decision 2026-10-04: "updates are
-- structured, I should not need to approve"). The safety brake is NOT an
-- approval step: it stops a run that looks broken (a parser misreading every
-- unit as sold, an empty page after a failed login) instead of writing it.
--
-- Hard rules honoured here (CLAUDE.md):
--   * never raise SQLSTATE 40001/40P01 — nothing below raises at all except the
--     revert's not-found, which uses a custom code.
--   * every RPC is service-role only; the tables are readable by admins.

BEGIN;

-- 1. Settings (singleton) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_update_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_enabled         boolean NOT NULL DEFAULT true,
  -- source_type values (unit_updates.source_type) the scheduler enqueues.
  -- A source is listed only once its adapter exists in the worker.
  scheduled_sources  text[]  NOT NULL DEFAULT ARRAY['riva_broker']::text[],
  -- Safety brake: a project whose run would flip more than this share of its
  -- CRM units to sold/reserved (and at least brake_min_units of them) is HELD.
  brake_share        numeric NOT NULL DEFAULT 0.5 CHECK (brake_share > 0 AND brake_share <= 1),
  brake_min_units    int     NOT NULL DEFAULT 6 CHECK (brake_min_units >= 1),
  -- A failing source (e.g. login refused) is retried at most this many times a day.
  max_failed_runs_per_day int NOT NULL DEFAULT 3,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.project_update_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. Runs -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_update_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key       text NOT NULL,               -- 'schedule:riva_broker', 'manual:riva_broker', 'wa:<chat_wid>'
  source_type   text NOT NULL,               -- riva_broker | whatsapp_group | …
  trigger       text NOT NULL CHECK (trigger IN ('schedule','manual','whatsapp')),
  dry_run       boolean NOT NULL DEFAULT false,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  outcome       text CHECK (outcome IN ('applied','no_change','held','partial','dry_run')),
  summary       jsonb,
  error         text,
  attempts      int NOT NULL DEFAULT 0,
  claimed_by    text,
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  reverted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- One open run per key: the five worker machines all tick the scheduler, and
-- this index is what makes that idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS project_update_runs_one_open
  ON public.project_update_runs (run_key) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS project_update_runs_queue
  ON public.project_update_runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS project_update_runs_recent
  ON public.project_update_runs (source_type, created_at DESC);

-- 3. Changes (the audit trail + undo) ---------------------------------------
CREATE TABLE IF NOT EXISTS public.project_update_changes (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES public.project_update_runs(id) ON DELETE CASCADE,
  project_id   uuid,                         -- all_projects record the change belongs to
  record_id    uuid NOT NULL,
  model        text NOT NULL,                -- 'units' | 'all_projects' | 'unit_updates'
  action       text NOT NULL CHECK (action IN ('update','create')),
  -- For 'update': the changed keys only. `before` holds JSON null for a key the
  -- record did not have, so a revert can remove it again.
  before       jsonb,
  after        jsonb NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reverted_at  timestamptz,
  revert_note  text
);
CREATE INDEX IF NOT EXISTS project_update_changes_run ON public.project_update_changes (run_id);
CREATE INDEX IF NOT EXISTS project_update_changes_record ON public.project_update_changes (record_id, created_at DESC);

-- 4. Code allocator high-water marks ----------------------------------------
-- Unit codes (U-n) and project codes (م شn) are allocated BEFORE the record is
-- saved; a plain max(...) over records would hand the same code to two
-- allocations that land between allocate and save. The high-water mark makes
-- every allocation strictly increasing.
CREATE TABLE IF NOT EXISTS public.project_update_code_hwm (
  kind  text PRIMARY KEY,                    -- 'unit' | 'project'
  last  int  NOT NULL
);

-- 5. RLS: admins may read; only the service role writes ---------------------
ALTER TABLE public.project_update_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_update_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_update_changes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_update_code_hwm ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_update_settings_admin_read ON public.project_update_settings;
CREATE POLICY project_update_settings_admin_read ON public.project_update_settings
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
DROP POLICY IF EXISTS project_update_runs_admin_read ON public.project_update_runs;
CREATE POLICY project_update_runs_admin_read ON public.project_update_runs
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
DROP POLICY IF EXISTS project_update_changes_admin_read ON public.project_update_changes;
CREATE POLICY project_update_changes_admin_read ON public.project_update_changes
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));

REVOKE ALL ON public.project_update_settings, public.project_update_runs,
              public.project_update_changes, public.project_update_code_hwm FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.project_update_settings, public.project_update_runs,
              public.project_update_changes, public.project_update_code_hwm FROM authenticated;
GRANT SELECT ON public.project_update_settings, public.project_update_runs,
              public.project_update_changes TO authenticated;

-- 6. RPCs -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.project_update_riyadh_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date $$;

-- Enqueue one run; returns the open run's id (new or already queued/running).
CREATE OR REPLACE FUNCTION public.project_update_enqueue(
  p_source_type text, p_run_key text, p_trigger text,
  p_dry_run boolean DEFAULT false, p_params jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.project_update_runs (run_key, source_type, trigger, dry_run, params)
  VALUES (p_run_key, p_source_type, p_trigger, COALESCE(p_dry_run,false), COALESCE(p_params,'{}'::jsonb))
  ON CONFLICT (run_key) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT r.id INTO v_id FROM public.project_update_runs r
     WHERE r.run_key = p_run_key AND r.status IN ('queued','running') LIMIT 1;
  END IF;
  RETURN v_id;
END $$;

-- The scheduler. Called by every worker machine every few minutes; the unique
-- open-run index + the daily failure cap keep that idempotent and bounded.
-- A source is due when any ACTIVE unit_updates row of that source has
-- next_due <= today (Riyadh). The worker advances next_due per project, so a
-- source stops being due once its run lands.
CREATE OR REPLACE FUNCTION public.project_update_enqueue_due() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s   public.project_update_settings%ROWTYPE;
  src text;
  n   int := 0;
  v_today date := public.project_update_riyadh_today();
BEGIN
  SELECT * INTO s FROM public.project_update_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.is_enabled THEN RETURN 0; END IF;

  FOR src IN
    SELECT DISTINCT u.data->>'source_type'
      FROM public.records u
     WHERE u.model_id = 'aa10c001-2026-4824-9000-000000000001'
       AND COALESCE((u.data->>'is_active')::boolean, false)
       AND u.data->>'source_type' = ANY (s.scheduled_sources)
       AND NULLIF(u.data->>'next_due','') IS NOT NULL
       AND (u.data->>'next_due')::date <= v_today
  LOOP
    -- Stop retrying a source that keeps failing today (login refused, portal
    -- down). No uncapped retry loop — same lesson as the translation cap.
    IF (SELECT count(*) FROM public.project_update_runs r
         WHERE r.source_type = src AND r.trigger = 'schedule' AND r.status = 'failed'
           AND (r.created_at AT TIME ZONE 'Asia/Riyadh')::date = v_today) >= s.max_failed_runs_per_day THEN
      CONTINUE;
    END IF;
    -- A run that already finished today (any outcome) is enough for today; a
    -- held project is re-tried tomorrow via its own next_due.
    IF EXISTS (SELECT 1 FROM public.project_update_runs r
                WHERE r.source_type = src AND r.trigger = 'schedule' AND r.status = 'done'
                  AND NOT r.dry_run
                  AND (r.created_at AT TIME ZONE 'Asia/Riyadh')::date = v_today) THEN
      CONTINUE;
    END IF;
    PERFORM public.project_update_enqueue(src, 'schedule:' || src, 'schedule', false, '{}'::jsonb);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.project_update_claim_next(p_worker text)
RETURNS SETOF public.project_update_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.project_update_runs%ROWTYPE;
BEGIN
  IF NOT (SELECT is_enabled FROM public.project_update_settings WHERE id = 1) THEN RETURN; END IF;
  SELECT * INTO r FROM public.project_update_runs q
   WHERE q.status = 'queued'
   ORDER BY q.created_at
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.project_update_runs q
     SET status = 'running', attempts = r.attempts + 1, claimed_by = p_worker,
         started_at = now(), heartbeat_at = now()
   WHERE q.id = r.id
  RETURNING * INTO r;
  RETURN NEXT r;
END $$;

CREATE OR REPLACE FUNCTION public.project_update_heartbeat(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.project_update_runs SET heartbeat_at = now() WHERE id = p_id AND status = 'running';
$$;

-- Finish only a LIVE run: a run the watchdog already swept stays swept.
CREATE OR REPLACE FUNCTION public.project_update_finish(
  p_id uuid, p_status text, p_outcome text, p_summary jsonb, p_error text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.project_update_runs
     SET status = CASE WHEN p_status IN ('done','failed') THEN p_status ELSE 'failed' END,
         outcome = p_outcome, summary = p_summary, error = p_error, finished_at = now()
   WHERE id = p_id AND status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

-- A run whose machine died: requeue (≤3 attempts) or fail.
CREATE OR REPLACE FUNCTION public.project_update_watchdog() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  WITH stale AS (
    SELECT id, attempts FROM public.project_update_runs
     WHERE status = 'running' AND heartbeat_at < now() - interval '15 minutes'
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.project_update_runs r
     SET status = CASE WHEN s.attempts < 3 THEN 'queued' ELSE 'failed' END,
         error  = CASE WHEN s.attempts < 3 THEN r.error ELSE 'watchdog: worker stopped heart-beating' END,
         finished_at = CASE WHEN s.attempts < 3 THEN NULL ELSE now() END,
         claimed_by = NULL
    FROM stale s WHERE r.id = s.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Allocate n strictly-increasing codes. kind 'unit' → U-n, 'project' → م شn.
CREATE OR REPLACE FUNCTION public.project_update_next_codes(p_kind text, p_n int) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_max int; v_hwm int; v_start int; v_model uuid; v_field text; v_re text; v_prefix text;
BEGIN
  IF p_n IS NULL OR p_n < 1 THEN RETURN ARRAY[]::text[]; END IF;
  IF p_kind = 'unit' THEN
    v_model := '7ca3014d-f658-418e-9c53-2d279c97f009'; v_field := 'unit_code'; v_re := '^U-(\d+)$'; v_prefix := 'U-';
  ELSIF p_kind = 'project' THEN
    v_model := '220c49b9-de57-492d-9eca-c0d9f54fd40f'; v_field := 'project_id'; v_re := '^م ش(\d+)$'; v_prefix := 'م ش';
  ELSE
    RAISE EXCEPTION 'project_update_next_codes: unknown kind %', p_kind USING ERRCODE = 'WS422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('project_update_code_' || p_kind));
  SELECT COALESCE(max((substring(data->>v_field FROM v_re))::int), 0) INTO v_max
    FROM public.records WHERE model_id = v_model AND data->>v_field ~ v_re;
  SELECT last INTO v_hwm FROM public.project_update_code_hwm WHERE kind = p_kind FOR UPDATE;
  v_start := GREATEST(v_max, COALESCE(v_hwm, 0)) + 1;
  INSERT INTO public.project_update_code_hwm (kind, last) VALUES (p_kind, v_start + p_n - 1)
  ON CONFLICT (kind) DO UPDATE SET last = EXCLUDED.last;
  RETURN ARRAY(SELECT v_prefix || (v_start + g)::text FROM generate_series(0, p_n - 1) g);
END $$;

-- Undo a run. A change is reverted only while the record still holds exactly
-- what the run wrote; if someone edited the field since, that change is skipped
-- (and noted) rather than clobbering the newer edit. Created records are
-- deleted only if unchanged since creation.
CREATE OR REPLACE FUNCTION public.project_update_revert(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c record; v_cur jsonb; v_key text; v_match boolean; v_new jsonb;
  n_rev int := 0; n_skip int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.project_update_runs WHERE id = p_run_id) THEN
    RAISE EXCEPTION 'project_update_revert: run % not found', p_run_id USING ERRCODE = 'WS404';
  END IF;
  FOR c IN SELECT * FROM public.project_update_changes
            WHERE run_id = p_run_id AND reverted_at IS NULL ORDER BY id DESC
  LOOP
    SELECT data INTO v_cur FROM public.records WHERE id = c.record_id FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'record no longer exists' WHERE id = c.id;
      n_skip := n_skip + 1; CONTINUE;
    END IF;
    IF c.action = 'create' THEN
      v_match := true;
      FOR v_key IN SELECT jsonb_object_keys(c.after) LOOP
        IF (v_cur -> v_key) IS DISTINCT FROM (c.after -> v_key) THEN v_match := false; END IF;
      END LOOP;
      IF v_match THEN
        DELETE FROM public.records WHERE id = c.record_id;
        UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'deleted' WHERE id = c.id;
        n_rev := n_rev + 1;
      ELSE
        UPDATE public.project_update_changes SET revert_note = 'skipped: edited since creation' WHERE id = c.id;
        n_skip := n_skip + 1;
      END IF;
      CONTINUE;
    END IF;
    v_new := v_cur; v_match := false;
    FOR v_key IN SELECT jsonb_object_keys(c.after) LOOP
      IF (v_cur -> v_key) IS NOT DISTINCT FROM (c.after -> v_key) THEN
        v_match := true;
        IF c.before -> v_key IS NULL OR jsonb_typeof(c.before -> v_key) = 'null' THEN
          v_new := v_new - v_key;
        ELSE
          v_new := jsonb_set(v_new, ARRAY[v_key], c.before -> v_key);
        END IF;
      END IF;
    END LOOP;
    IF v_match THEN
      UPDATE public.records SET data = v_new WHERE id = c.record_id;
      UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'reverted' WHERE id = c.id;
      n_rev := n_rev + 1;
    ELSE
      UPDATE public.project_update_changes SET revert_note = 'skipped: edited since' WHERE id = c.id;
      n_skip := n_skip + 1;
    END IF;
  END LOOP;
  UPDATE public.project_update_runs SET reverted_at = now() WHERE id = p_run_id;
  RETURN jsonb_build_object('reverted', n_rev, 'skipped', n_skip);
END $$;

REVOKE ALL ON FUNCTION public.project_update_enqueue(text,text,text,boolean,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_enqueue_due() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_claim_next(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_heartbeat(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_finish(uuid,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_watchdog() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_next_codes(text,int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_revert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_update_enqueue(text,text,text,boolean,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_enqueue_due() TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_claim_next(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_heartbeat(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_finish(uuid,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_watchdog() TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_next_codes(text,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_revert(uuid) TO service_role;

COMMIT;
