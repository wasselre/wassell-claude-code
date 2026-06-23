-- ============================================================================
-- 2026-06-23: workflow_jobs queue + records capture trigger (Phase 1)
-- ----------------------------------------------------------------------------
-- Server-authoritative workflow execution. The browser/client engine
-- (src/lib/workflowEngine.ts) only fires for writes that happen in a browser
-- tab; a follow-up completed by the call webhook, the AI agent, a migration,
-- the on_due sweeper, or raw admin SQL never triggers the create/update
-- workflows. This queue closes that gap: the DATABASE captures every write to
-- an enrolled model and the Fly worker becomes the authoritative executor.
--
--   record write (any path) ──AFTER trigger──▶ workflow_jobs (one row/event)
--                                              │  carries OLD.data + NEW.data
--                                              ▼
--                         Fly worker poll loop ── runs ALL matching active
--                         workflows for (model_id, event) ── logs workflow_runs
--                         ── executes actions (writes via record_save, which
--                            re-fires this trigger at depth+1)
--
-- This is the 8th queue on the Fly worker (deck / generation / file_preview /
-- pdf_compress / document / data_migration / scheduled_reports), same
-- claim-FOR-UPDATE-SKIP-LOCKED + watchdog pattern.
--
-- SAFETY POSTURE — this migration is INERT on landing:
--   * The capture trigger only enqueues for models listed in
--     workflow_capture_models. That table starts EMPTY, so on deploy the
--     trigger does ONE indexed PK probe per records write and returns — no
--     rows are ever enqueued until a model is explicitly enrolled. This lets
--     us add the trigger to the hottest table in the app with zero behavioral
--     change, then enroll a sandbox model, prove the pipeline, and only then
--     enroll `followups`.
--   * Enrolling a model is also the server-authoritative switch: the client
--     engine reads this same allowlist and SKIPS client-side execution for
--     enrolled models (no double-fire). One source of truth, server + client.
--
-- DUMB CAPTURE, SMART WORKER: the trigger does NOT evaluate which workflow
-- matches — it only records "model X record Y changed, here is before/after,
-- here is the actor". The worker decides eligibility. Keeps the trigger cheap,
-- decoupled from workflow config, and safe.
--
-- search_path gotcha (see memory): triggers on `records` firing via record_save
-- run with a restricted search_path, and pgcrypto's gen_random_bytes (extensions
-- schema) fails there. All functions here SET search_path = public, pg_temp and
-- use gen_random_uuid() (pg_catalog).
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Allowlist / feature flag — which models run server-authoritative.
-- Empty by default ⇒ the whole pipeline is inert. Readable by authenticated
-- (the client engine reads it to know which models to STOP executing); writes
-- are service-role / admin only.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_capture_models (
  model_id   uuid        PRIMARY KEY REFERENCES public.models(id) ON DELETE CASCADE,
  enabled    boolean     NOT NULL DEFAULT true,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workflow_capture_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workflow_capture_models_read" ON public.workflow_capture_models;
CREATE POLICY "workflow_capture_models_read"
  ON public.workflow_capture_models FOR SELECT
  TO authenticated
  USING (true);
-- No INSERT/UPDATE/DELETE policy ⇒ only service_role (which bypasses RLS) can
-- enroll/unenroll a model. Enrollment is a deliberate, reviewed migration step.

-- ────────────────────────────────────────────────────────────────────────
-- Queue table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What changed.
  model_id        uuid        NOT NULL,
  record_id       uuid        NOT NULL,
  trigger_event   text        NOT NULL CHECK (trigger_event IN ('create','update','delete')),
  -- The transition. previous_data is NULL for create; new_data is NULL for
  -- delete. only_on_change conditions REQUIRE both images — this is why we
  -- enqueue the full before/after and never refetch the record (which would
  -- have moved on by claim time).
  previous_data   jsonb,
  new_data        jsonb,
  changed_fields  text[]      NOT NULL DEFAULT '{}',
  -- Who/what triggered the write. auth.uid() for a browser save through
  -- record_save; NULL for service-role / cron / webhook ⇒ the worker resolves
  -- current_user to the system fallback.
  actor_user_id   uuid,
  source          text        NOT NULL DEFAULT 'records_trigger',
  -- Recursion control. A workflow action that writes a record re-fires this
  -- trigger; the worker stamps depth+1 / origin_run_id / parent_job_id via
  -- GUCs (set_config) around its record_save calls so the lineage is captured.
  depth           int         NOT NULL DEFAULT 0,
  -- Lineage pointers are OBSERVABILITY, not integrity. Intentionally NO FK on
  -- parent_job_id: the capture trigger's job INSERT runs inside the SAME
  -- transaction as the workflow's record write (it's an AFTER trigger on that
  -- write), so a FK violation here — e.g. a pruned/absent parent — would abort
  -- a real record write. Lineage bookkeeping must never be able to fail a write.
  parent_job_id   uuid,
  origin_run_id   uuid,
  -- Observability fingerprint of the event (NOT a uniqueness constraint — a
  -- legitimate A→B→A transition repeats the hash and must NOT be dropped).
  idempotency_key text,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','completed','failed','dead','skipped')),
  skip_reason     text,
  attempts        int         NOT NULL DEFAULT 0,
  max_attempts    int         NOT NULL DEFAULT 5,
  available_at    timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Worker claim hot path: pending + due, oldest first.
CREATE INDEX IF NOT EXISTS workflow_jobs_claimable_idx
  ON public.workflow_jobs (available_at)
  WHERE status = 'pending';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS workflow_jobs_processing_by_locked_idx
  ON public.workflow_jobs (locked_at)
  WHERE status = 'processing';

-- Per-record history (debugging / the future Logs surface).
CREATE INDEX IF NOT EXISTS workflow_jobs_record_idx
  ON public.workflow_jobs (record_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- RLS — authenticated users may SELECT jobs for records they could see is NOT
-- enforced here (the snapshots can contain arbitrary record data); jobs are an
-- internal execution log. SELECT is admin-only; all writes service-role only.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.workflow_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workflow_jobs_admin_select" ON public.workflow_jobs;
CREATE POLICY "workflow_jobs_admin_select"
  ON public.workflow_jobs FOR SELECT
  TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

-- ────────────────────────────────────────────────────────────────────────
-- Capture trigger function.
--
-- Fires AFTER INSERT/UPDATE/DELETE on records FOR EACH ROW. Order: this runs
-- after the BEFORE triggers (version bump, project-rollup fill) so NEW.data is
-- the final image. It only ever INSERTs into workflow_jobs — it never writes
-- back to records, so it cannot itself drive the recursion loop.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_records_capture_workflow_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_model    uuid;
  v_event    text;
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[];
  v_depth    int;
  v_origin   uuid;
  v_parent   uuid;
  v_max      int := 5;   -- MAX_WORKFLOW_DEPTH
BEGIN
  -- 1) Resolve the row image + event.
  IF TG_OP = 'DELETE' THEN
    v_model := OLD.model_id; v_event := 'delete'; v_old := OLD.data; v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_model := NEW.model_id; v_event := 'create'; v_old := NULL; v_new := NEW.data;
  ELSE
    v_model := NEW.model_id; v_event := 'update'; v_old := OLD.data; v_new := NEW.data;
  END IF;

  -- 2) ALLOWLIST GATE FIRST — the cheap PK probe that keeps this trigger inert
  --    until a model is enrolled. Runs before the jsonb no-op compare so that
  --    every write to a non-enrolled model (i.e. all of them on landing) costs
  --    just one index lookup and returns.
  PERFORM 1 FROM public.workflow_capture_models
   WHERE model_id = v_model AND enabled = true;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 2b) No-op guard (enrolled updates only): a data-less touch — the all_projects
  --     rollup touch does `UPDATE records SET data=data`, a version-only bump,
  --     etc. — must not enqueue an event.
  IF v_event = 'update' AND v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NULL;
  END IF;

  -- 3) changed_fields = keys whose value differs between old and new.
  SELECT COALESCE(array_agg(k), '{}')
    INTO v_changed
    FROM (
      SELECT DISTINCT k
        FROM (
          SELECT jsonb_object_keys(COALESCE(v_old, '{}'::jsonb)) AS k
          UNION
          SELECT jsonb_object_keys(COALESCE(v_new, '{}'::jsonb))
        ) ks
       WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k)
    ) d;

  -- 4) Recursion lineage from GUCs the worker sets around its record_save calls.
  --    Absent (a genuine user/external write) ⇒ depth 0, no origin/parent.
  v_depth  := COALESCE(NULLIF(current_setting('wassell.workflow_depth', true), '')::int, 0);
  v_origin := NULLIF(current_setting('wassell.workflow_origin_run', true), '')::uuid;
  v_parent := NULLIF(current_setting('wassell.workflow_parent_job', true), '')::uuid;

  -- 5) Depth cap — never silent. Record a 'skipped' job so the cutoff is
  --    visible in the logs instead of an event vanishing.
  IF v_depth > v_max THEN
    INSERT INTO public.workflow_jobs
      (model_id, record_id, trigger_event, previous_data, new_data, changed_fields,
       actor_user_id, depth, parent_job_id, origin_run_id, status, skip_reason)
    VALUES
      (v_model, COALESCE(NEW.id, OLD.id), v_event, v_old, v_new, v_changed,
       auth.uid(), v_depth, v_parent, v_origin, 'skipped',
       'max_workflow_depth_exceeded (' || v_depth || ' > ' || v_max || ')');
    RETURN NULL;
  END IF;

  -- 6) Enqueue the event.
  INSERT INTO public.workflow_jobs
    (model_id, record_id, trigger_event, previous_data, new_data, changed_fields,
     actor_user_id, depth, parent_job_id, origin_run_id, idempotency_key)
  VALUES
    (v_model, COALESCE(NEW.id, OLD.id), v_event, v_old, v_new, v_changed,
     auth.uid(), v_depth, v_parent, v_origin,
     -- md5() (pg_catalog), NOT pgcrypto digest()/gen_random_bytes() — those
     -- live in the extensions schema and fail under the records-trigger's
     -- restricted search_path (see memory: visits rating-token trigger).
     md5(COALESCE(NEW.id, OLD.id)::text || ':' || v_event || ':' || v_depth::text || ':' ||
         md5(COALESCE(v_new, v_old, '{}'::jsonb)::text)));

  RETURN NULL;  -- AFTER trigger; return value ignored.
END $fn$;

DROP TRIGGER IF EXISTS records_capture_workflow_event ON public.records;
CREATE TRIGGER records_capture_workflow_event
  AFTER INSERT OR UPDATE OR DELETE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_capture_workflow_event();

-- ────────────────────────────────────────────────────────────────────────
-- RPC: workflow_job_claim_next — atomically claim the oldest due pending job.
-- FOR UPDATE SKIP LOCKED so the 5-machine worker fleet never double-claims.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.workflow_job_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id          uuid,
  model_id        uuid,
  record_id       uuid,
  trigger_event   text,
  previous_data   jsonb,
  new_data        jsonb,
  changed_fields  text[],
  actor_user_id   uuid,
  depth           int,
  origin_run_id   uuid,
  attempts        int
) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.workflow_jobs
     SET status     = 'processing',
         locked_by  = p_worker_id,
         locked_at  = now(),
         updated_at = now(),
         attempts   = workflow_jobs.attempts + 1
   WHERE id = (
     SELECT id FROM public.workflow_jobs
      WHERE status = 'pending' AND available_at <= now()
      ORDER BY available_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING id, model_id, record_id, trigger_event, previous_data, new_data,
             changed_fields, actor_user_id, depth, origin_run_id, attempts;
$$;

REVOKE ALL ON FUNCTION public.workflow_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_job_claim_next(text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: workflow_job_complete — only touches 'processing' rows (late finish
-- after the watchdog requeued it is a harmless no-op).
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.workflow_job_complete(p_job_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH updated AS (
    UPDATE public.workflow_jobs
       SET status = 'completed', completed_at = now(), updated_at = now(), error = NULL
     WHERE id = p_job_id AND status = 'processing'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.workflow_job_complete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_job_complete(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: workflow_job_fail — retry with backoff until max_attempts, then 'dead'.
-- Only touches 'processing' rows.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.workflow_job_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_attempts int;
  v_max      int;
BEGIN
  SELECT attempts, max_attempts INTO v_attempts, v_max
    FROM public.workflow_jobs WHERE id = p_job_id AND status = 'processing';
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_attempts >= v_max THEN
    UPDATE public.workflow_jobs
       SET status = 'dead', error = p_error, completed_at = now(), updated_at = now(),
           locked_at = NULL, locked_by = NULL
     WHERE id = p_job_id;
  ELSE
    -- Exponential-ish backoff: 30s × attempts.
    UPDATE public.workflow_jobs
       SET status = 'pending', error = p_error, updated_at = now(),
           locked_at = NULL, locked_by = NULL,
           available_at = now() + make_interval(secs => 30 * v_attempts)
     WHERE id = p_job_id;
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.workflow_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_job_fail(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Watchdog — requeue jobs stuck 'processing' beyond the lease (worker crash /
-- machine stop). 10 min lease is well above a normal run (a workflow is a few
-- DB writes + maybe one WhatsApp send). Returns count requeued/killed.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.workflow_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH stale AS (
    SELECT id, attempts, max_attempts
      FROM public.workflow_jobs
     WHERE status = 'processing'
       AND locked_at < now() - interval '10 minutes'
  ),
  bumped AS (
    UPDATE public.workflow_jobs j
       SET status       = CASE WHEN s.attempts >= s.max_attempts THEN 'dead' ELSE 'pending' END,
           locked_at    = NULL,
           locked_by    = NULL,
           available_at = now(),
           error        = COALESCE(j.error, 'watchdog: worker lease expired (>10m processing)'),
           updated_at   = now()
      FROM stale s
     WHERE j.id = s.id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM bumped;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.workflow_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_jobs_watchdog() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: record_save_workflow — the worker's lineage-aware write path.
--
-- When the worker executes a workflow action that creates/updates a record, it
-- MUST write through this wrapper (not record_save directly) so the child
-- workflow_jobs row the capture trigger enqueues carries depth+1 / origin /
-- parent. set_config(..., is_local := true) is TRANSACTION-scoped, and a plpgsql
-- function body is one transaction, so the nested record_save (and the AFTER
-- capture trigger it fires) see these GUCs — and they cannot leak across the
-- pooled connection to an unrelated request. Returns record_save's saved id.
--
-- p_depth is the CHILD depth (caller passes parentJob.depth + 1). The trigger
-- enqueues at this depth and self-skips past MAX_WORKFLOW_DEPTH.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_save_workflow(
  p_model_id        uuid,
  p_id              uuid,
  p_data            jsonb,
  p_created_by      uuid,
  p_expected_version integer,
  p_depth           int,
  p_origin_run      uuid,
  p_parent_job      uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM set_config('wassell.workflow_depth',      p_depth::text,                  true);
  PERFORM set_config('wassell.workflow_origin_run', COALESCE(p_origin_run::text,''), true);
  PERFORM set_config('wassell.workflow_parent_job', COALESCE(p_parent_job::text,''), true);
  v_id := public.record_save(p_model_id, p_id, p_data, p_created_by, p_expected_version);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.record_save_workflow(uuid, uuid, jsonb, uuid, integer, int, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_save_workflow(uuid, uuid, jsonb, uuid, integer, int, uuid, uuid) TO service_role;

COMMIT;

