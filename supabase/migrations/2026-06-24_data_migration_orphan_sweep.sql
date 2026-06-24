-- T7 — data_migration orphan-record sweep (2026-06-24)
-- =====================================================================
-- Extends data_migration_jobs_watchdog() with a SECOND phase. Phase 1 (existing,
-- preserved verbatim) fails jobs stuck 'running' > 45 min and reflects per-kind.
-- Phase 2 (new) catches the OTHER orphan shape: a data_migration RECORD stuck in
-- a busy state with NO active (queued/running) job — the worker crashed/never
-- ran, or a client-side `import` tab closed mid-run (import creates no job). Such
-- a record would otherwise spin forever (status='extracting'/'migrating' or
-- prep_busy/discuss_busy=true) because Phase 1 only acts via stale RUNNING jobs.
--
-- Phase 2 moves the record to a safe RECOVERABLE state (NO data deleted — only
-- the busy flag/status flips), idempotently (the busy WHERE no longer matches
-- once cleaned), behind a 30-min grace so it never races a freshly-enqueued job
-- or an actively-progressing one (those have an active job and are excluded).
--
-- Rollback: 2026-06-24_data_migration_orphan_sweep_down.sql (executable) —
-- restores the Phase-1-only body. Does NOT touch record_save or worker behavior.

CREATE OR REPLACE FUNCTION public.data_migration_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count   int := 0;
  v_tmp     int := 0;
  v_orphans int := 0;
  v_dm_model uuid;
  c_orphan_grace interval := interval '30 minutes';
  v_msg   text := 'The migration worker did not finish within 45 minutes — it likely crashed mid-run. Press Retry to try again.';
  v_orphan_msg text := 'No active migration job was found while this record was still busy — the worker crashed or a tab closed mid-run. Cleaned up by the watchdog; press Retry to run again.';
BEGIN
  -- ── Phase 1 (UNCHANGED): jobs stuck 'running' > 45 min ────────────────────
  CREATE TEMP TABLE _stale_dmj ON COMMIT DROP AS
    SELECT id, migration_record_id, kind
      FROM public.data_migration_jobs
     WHERE status = 'running'
       AND started_at < now() - interval '45 minutes';

  UPDATE public.data_migration_jobs j
     SET status = 'failed', finished_at = now(), error_message = v_msg
    FROM _stale_dmj s
   WHERE j.id = s.id;

  UPDATE public.records r
     SET data = r.data || jsonb_build_object('status','failed','error_message',v_msg,'phase',NULL),
         updated_at = now()
    FROM _stale_dmj s
   WHERE r.id = s.migration_record_id
     AND s.kind = 'extract'
     AND COALESCE(r.data->>'status','') = 'extracting';

  UPDATE public.records r
     SET data = r.data || jsonb_build_object('prep_busy',false,'error_message',v_msg),
         updated_at = now()
    FROM _stale_dmj s
   WHERE r.id = s.migration_record_id
     AND s.kind = 'plan'
     AND COALESCE((r.data->>'prep_busy')::boolean, false) = true;

  UPDATE public.records r
     SET data = r.data || jsonb_build_object('discuss_busy',false,'error_message',v_msg),
         updated_at = now()
    FROM _stale_dmj s
   WHERE r.id = s.migration_record_id
     AND s.kind = 'discuss'
     AND COALESCE((r.data->>'discuss_busy')::boolean, false) = true;

  SELECT COUNT(*) INTO v_count FROM _stale_dmj;

  -- ── Phase 2 (T7): records stuck BUSY with NO active job ───────────────────
  SELECT id INTO v_dm_model FROM public.models WHERE name = 'data_migration' LIMIT 1;
  -- (v_dm_model NULL when the model is absent → every WHERE below matches nothing.)

  -- 2a. status-busy orphans (extracting/migrating) → failed + clear busy flags.
  UPDATE public.records r
     SET data = r.data || jsonb_build_object(
                  'status','failed', 'error_message',v_orphan_msg, 'phase',NULL,
                  'prep_busy',false, 'discuss_busy',false),
         updated_at = now()
   WHERE r.model_id = v_dm_model
     AND COALESCE(r.data->>'status','') IN ('extracting','migrating')
     AND r.updated_at < now() - c_orphan_grace
     AND NOT EXISTS (SELECT 1 FROM public.data_migration_jobs j
                      WHERE j.migration_record_id = r.id AND j.status IN ('queued','running'));
  GET DIAGNOSTICS v_tmp = ROW_COUNT;  v_orphans := v_orphans + v_tmp;

  -- 2b. prep_busy orphans (and not status-busy) → clear prep_busy.
  UPDATE public.records r
     SET data = r.data || jsonb_build_object('prep_busy',false,'error_message',v_orphan_msg),
         updated_at = now()
   WHERE r.model_id = v_dm_model
     AND COALESCE((r.data->>'prep_busy')::boolean, false) = true
     AND COALESCE(r.data->>'status','') NOT IN ('extracting','migrating')
     AND r.updated_at < now() - c_orphan_grace
     AND NOT EXISTS (SELECT 1 FROM public.data_migration_jobs j
                      WHERE j.migration_record_id = r.id AND j.status IN ('queued','running'));
  GET DIAGNOSTICS v_tmp = ROW_COUNT;  v_orphans := v_orphans + v_tmp;

  -- 2c. discuss_busy orphans (and not status-busy) → clear discuss_busy.
  UPDATE public.records r
     SET data = r.data || jsonb_build_object('discuss_busy',false,'error_message',v_orphan_msg),
         updated_at = now()
   WHERE r.model_id = v_dm_model
     AND COALESCE((r.data->>'discuss_busy')::boolean, false) = true
     AND COALESCE(r.data->>'status','') NOT IN ('extracting','migrating')
     AND r.updated_at < now() - c_orphan_grace
     AND NOT EXISTS (SELECT 1 FROM public.data_migration_jobs j
                      WHERE j.migration_record_id = r.id AND j.status IN ('queued','running'));
  GET DIAGNOSTICS v_tmp = ROW_COUNT;  v_orphans := v_orphans + v_tmp;

  -- Return total things acted on (stale jobs + orphan records recovered).
  RETURN v_count + v_orphans;
END $$;

REVOKE ALL ON FUNCTION public.data_migration_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_jobs_watchdog() TO service_role;
