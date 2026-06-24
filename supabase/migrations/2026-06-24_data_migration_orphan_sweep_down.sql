-- T7 ROLLBACK — restore data_migration_jobs_watchdog() to its pre-T7 (Phase-1-
-- only) body, dropping the orphan-record sweep. Directly executable. Verified on
-- a Supabase branch (function body byte-restored). Touches nothing else.

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
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.data_migration_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_migration_jobs_watchdog() TO service_role;
