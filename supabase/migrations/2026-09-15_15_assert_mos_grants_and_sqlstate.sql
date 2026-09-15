-- ============================================================================
-- Two standing guards for the Group-C objects. 2026-09-15. Asserts only.
--
--  1. NO anon EXECUTE on any function this build added. Supabase's
--     ALTER DEFAULT PRIVILEGES grants anon on every new function in `public`,
--     and `REVOKE … FROM PUBLIC` does not remove it — so the default is OPEN
--     and each migration has to close it by name. This fails the migration if
--     one is ever forgotten, instead of shipping a definer reader to the
--     internet. (It fired for real on 2026-09-15: `mos_month_exceptions` and
--     `mos_row_summary` were both anon-callable, with a gate that passed for
--     anon because `auth.uid()` is NULL there too.)
--
--  2. NO function raises SQLSTATE 40001 / 40P01. PostgREST re-runs a
--     transaction that aborts with either one FOREVER — see CLAUDE.md
--     "Never raise SQLSTATE 40001 / 40P01". WS409 for conflicts, WS429 for
--     rate limits.
--
-- Both are cheap catalogue reads. Safe to re-run.
-- ============================================================================

BEGIN;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'mos_month_exceptions', 'mos_row_summary', 'mos_row_bucket',
       'mos_subject_bucket', 'mos_subject_workflow_key', 'mos_subject_version_id',
       'mos_spread_effort_mode', 'mos_exception_is_platform_rejection',
       'mos_caller_is_trusted_service')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:ANON_CAN_EXECUTE — %', v_bad;
  END IF;
END $$;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'mos_plan_consume_reservation', 'mos_perf_place_open_task',
       'workflow_role_path_start', 'workflow_advance_role_path',
       'mos_plan_start_due', 'mos_month_exceptions', 'mos_row_summary',
       'mos_spread_effort_mode', 'mos_caller_is_trusted_service')
     AND pg_get_functiondef(p.oid) ~ '''40001''|''40P01''|serialization_failure|deadlock_detected';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:RETRYABLE_SQLSTATE in %', v_bad;
  END IF;
END $$;

-- mos_content_v must stay an INVOKER view. CREATE OR REPLACE VIEW replaces
-- reloptions rather than preserving them, so an unrelated edit can silently
-- turn it into a definer view and widen what every caller reads through it.
DO $$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'mos_content_v';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'MOS:VIEW_SECURITY_INVOKER_LOST mos_content_v — options are %', v_opts;
  END IF;
END $$;

COMMIT;
