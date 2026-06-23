-- ============================================================================
-- 2026-06-23: data_migration_jobs queue for the Fly.io worker pipeline
-- ----------------------------------------------------------------------------
-- Moves the long AI VISION work of the Data Migration wizard off the
-- browser-held HTTP request (POST /api/migrate, maxDuration 300) and onto the
-- always-on Fly.io worker, exactly like deck_jobs / generation_jobs /
-- file_preview_jobs / document_jobs.
--
-- WHY: extraction for a `units` target is multi-call source-fusion (discover →
-- fuse_batch per ~20 units) and every fuse batch re-sends the brochure /
-- floor-plan PDFs to Claude. Large image-heavy brochures (1-4 MB) blow past the
-- 300 s wall; Vercel kills the function mid-flight, the browser throws
-- `TypeError: Failed to fetch`, and because the old in-tab job died on reload
-- before its catch ran, the record froze at status='extracting',
-- error_message=null. (Two real migrations — الماجدية 174 / 183 — hit this.)
--
-- Three file-heavy actions move to the worker:
--   - 'extract'  : the whole source-fusion run (discover + batched fuse) OR the
--                  single project-profile extract. discover/fuse are NOT
--                  separate job kinds — they run inside ONE 'extract' job so the
--                  unit index, prompt cache, and auto-split stay in one worker
--                  run (matching the old client orchestration).
--   - 'plan'     : the pre-extraction clarify-chat turn (reads the files).
--   - 'discuss'  : the post-extraction recount/revise chat turn (re-reads files).
-- ('import' is reserved in the CHECK for symmetry — the local record-write
-- import step stays client-side; it is not the 300 s wall.)
--
-- Architecture (same queue pattern + rules as deck_jobs):
--   1. POST /api/migrate {action:'extract'|'plan'|'discuss'} validates auth,
--      RLS-gates the source record, writes the busy/status field server-side
--      (service role — so NO browser write registers in the realtime echo-dedup
--      and the worker's updates are never suppressed), inserts ONE job via
--      data_migration_job_enqueue, pings the worker /wake, and returns 202.
--   2. The worker's migration poll loop claims via data_migration_job_claim_next
--      (FOR UPDATE SKIP LOCKED), runs the copied migrateAgent pipeline with NO
--      timeout, and patches the data_migration record at every phase
--      (status / phase / progress_done / progress_total / raw_table / prep_* /
--      summary). The SPA gets those via Supabase Realtime — no held HTTP.
--   3. data_migration_jobs_watchdog() sweeps jobs stuck 'running' >45 min
--      (worker crash / fly machine stop) and reflects the failure onto the
--      record so the UI exits its spinner. 45 min is well above the worst-case
--      multi-batch run (sequential batches, each a few min). The Fly worker
--      invokes it on its watchdog interval (pg_cron is NOT enabled here).
--
-- Auth: the worker uses the service-role key (writes bypass RLS). Ownership was
-- validated by /api/migrate (caller's JWT could SELECT the source record)
-- before enqueue; job.user_id scopes the signed-URL minting of source_files.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_migration_jobs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The `data_migration` record (in public.records) this job writes into.
  -- CASCADE so deleting the migration cancels any pending/running job.
  migration_record_id uuid        NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  -- auth.users id of the submitter. Scopes signed-URL minting of source_files.
  user_id             uuid        NOT NULL,
  kind                text        NOT NULL
                                  CHECK (kind IN ('plan','extract','discuss','import')),
  status              text        NOT NULL DEFAULT 'queued'
                                  CHECK (status IN ('queued','running','done','failed','cancelled')),
  attempts            int         NOT NULL DEFAULT 0,
  -- Frozen snapshot of the turn-specific request: { fields, mode, language,
  -- guidance } for extract; { fields, language, userText, ... } for plan/discuss.
  -- The worker reads source_files + prep/raw_table from the record itself.
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result              jsonb,
  error_message       text,
  worker_id           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────
-- Worker claim hot path (queued tail only).
CREATE INDEX IF NOT EXISTS data_migration_jobs_queued_by_age_idx
  ON public.data_migration_jobs (created_at)
  WHERE status = 'queued';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS data_migration_jobs_running_by_started_idx
  ON public.data_migration_jobs (started_at)
  WHERE status = 'running';

-- ONE-ACTIVE-JOB-PER-RECORD guarantee. data_migration_job_enqueue relies on
-- this index to collapse concurrent enqueues (double-click / double-fire) into
-- one job — a record never has two queued/running jobs at once.
CREATE UNIQUE INDEX IF NOT EXISTS data_migration_jobs_one_active_per_record_idx
  ON public.data_migration_jobs (migration_record_id)
  WHERE status IN ('queued','running');

-- Per-record + per-user lookup (debugging / status reads).
CREATE INDEX IF NOT EXISTS data_migration_jobs_record_idx
  ON public.data_migration_jobs (migration_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS data_migration_jobs_user_idx
  ON public.data_migration_jobs (user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- RLS — users may SELECT their own jobs (status reads); all writes are
-- service-role only (the API enqueues, the worker updates, CASCADE deletes).
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.data_migration_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "data_migration_jobs_owner_select" ON public.data_migration_jobs;
CREATE POLICY "data_migration_jobs_owner_select"
  ON public.data_migration_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- RPC: data_migration_job_enqueue
-- ----------------------------------------------------------------------
-- The single enqueue path. Inserts one job unless an active (queued/running)
-- job already exists for the record (partial unique index makes it race-safe).
-- Returns the job id either way (idempotent — a double-fire returns the in-flight
-- job's id instead of erroring).
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_migration_job_enqueue(
  p_record_id uuid,
  p_user_id   uuid,
  p_kind      text,
  p_payload   jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.data_migration_jobs (migration_record_id, user_id, kind, payload)
  VALUES (p_record_id, p_user_id, p_kind, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (migration_record_id) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- An active job already exists — return it (idempotent enqueue).
    SELECT id INTO v_id
      FROM public.data_migration_jobs
     WHERE migration_record_id = p_record_id
       AND status IN ('queued','running')
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.data_migration_job_enqueue(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_job_enqueue(uuid, uuid, text, jsonb) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: data_migration_job_claim_next
-- ----------------------------------------------------------------------
-- Atomically claims the oldest queued job. FOR UPDATE SKIP LOCKED so multiple
-- worker machines never claim the same row. Returns 0 rows when idle.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_migration_job_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id              uuid,
  migration_record_id uuid,
  user_id             uuid,
  kind                text,
  payload             jsonb,
  attempts            int
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.data_migration_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = data_migration_jobs.attempts + 1
   WHERE id = (
     SELECT id
       FROM public.data_migration_jobs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING id, migration_record_id, user_id, kind, payload, attempts;
$$;

REVOKE ALL ON FUNCTION public.data_migration_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_job_claim_next(text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: data_migration_job_complete / _fail — both guarded by status='running'
-- so a late finish after the watchdog (or a cancel) already moved the job is a
-- harmless no-op.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_migration_job_complete(p_job_id uuid, p_result jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.data_migration_jobs
       SET status        = 'done',
           finished_at   = now(),
           result        = p_result,
           error_message = NULL
     WHERE id = p_job_id
       AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.data_migration_job_complete(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_job_complete(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.data_migration_job_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.data_migration_jobs
       SET status        = 'failed',
           finished_at   = now(),
           error_message = p_error
     WHERE id = p_job_id
       AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.data_migration_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_job_fail(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: data_migration_job_cancel
-- ----------------------------------------------------------------------
-- Cancels the active (queued/running) job for a record. The worker checks the
-- job's status between fuse batches and aborts gracefully; a queued job simply
-- never starts. Returns true if a job was moved to 'cancelled'.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_migration_job_cancel(p_record_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.data_migration_jobs
       SET status      = 'cancelled',
           finished_at = now()
     WHERE migration_record_id = p_record_id
       AND status IN ('queued','running')
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.data_migration_job_cancel(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_job_cancel(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Watchdog — sweep jobs stuck 'running' >45 min (crash / machine stop) to
-- 'failed', and reflect the failure onto the record so the UI exits its
-- spinner via Realtime. Reflection is per-kind and guarded so it never clobbers
-- a terminal state the worker already wrote on success:
--   extract  → status='failed' + error_message (only if still 'extracting')
--   plan     → clear prep_busy + transient error_message (status untouched —
--              planning is optional / re-runnable)
--   discuss  → clear discuss_busy + transient error_message
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_migration_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
  v_msg   text := 'The migration worker did not finish within 45 minutes — it likely crashed mid-run. Press Retry to try again.';
BEGIN
  CREATE TEMP TABLE _stale_dmj ON COMMIT DROP AS
    SELECT id, migration_record_id, kind
      FROM public.data_migration_jobs
     WHERE status = 'running'
       AND started_at < now() - interval '45 minutes';

  UPDATE public.data_migration_jobs j
     SET status = 'failed', finished_at = now(), error_message = v_msg
    FROM _stale_dmj s
   WHERE j.id = s.id;

  -- extract: flip the record to failed (only if still mid-extraction).
  UPDATE public.records r
     SET data = r.data || jsonb_build_object('status','failed','error_message',v_msg,'phase',NULL),
         updated_at = now()
    FROM _stale_dmj s
   WHERE r.id = s.migration_record_id
     AND s.kind = 'extract'
     AND COALESCE(r.data->>'status','') = 'extracting';

  -- plan: just clear the busy flag + surface a transient error.
  UPDATE public.records r
     SET data = r.data || jsonb_build_object('prep_busy',false,'error_message',v_msg),
         updated_at = now()
    FROM _stale_dmj s
   WHERE r.id = s.migration_record_id
     AND s.kind = 'plan'
     AND COALESCE((r.data->>'prep_busy')::boolean, false) = true;

  -- discuss: clear the busy flag + surface a transient error.
  UPDATE public.records r
     SET data = r.data || jsonb_build_object('discuss_busy',false,'error_message',v_msg),
         updated_at = now()
    FROM _stale_dmj s
   WHERE r.id = s.migration_record_id
     AND s.kind = 'discuss'
     AND COALESCE((r.data->>'discuss_busy')::boolean, false) = true;

  SELECT COUNT(*) INTO v_count FROM _stale_dmj;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.data_migration_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_jobs_watchdog() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- pg_cron schedule (best-effort — extension NOT enabled on wassell-prod, so
-- this is a no-op and the Fly worker calls data_migration_jobs_watchdog() on
-- its watchdog interval instead, same as every other queue).
-- ────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('data_migration_jobs_watchdog');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule(
      'data_migration_jobs_watchdog',
      '*/5 * * * *',
      $cmd$SELECT public.data_migration_jobs_watchdog();$cmd$
    );
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────
-- One-time cleanup: unstick any legacy migration frozen mid-run (status
-- 'extracting'/'migrating'). Before this migration there is no jobs table, so
-- every such record is a dead in-tab job (incl. the two reported records
-- 09067350… and de35cd3b…). Flip them to 'failed' with a clear retry message so
-- the UI offers Retry instead of spinning forever.
-- ────────────────────────────────────────────────────────────────────────
UPDATE public.records
   SET data = data || jsonb_build_object(
         'status','failed',
         'error_message','Extraction was interrupted. Press Retry to continue.',
         'phase', NULL),
       updated_at = now()
 WHERE model_id = (SELECT id FROM public.models WHERE name = 'data_migration')
   AND data->>'status' IN ('extracting','migrating');

COMMIT;
