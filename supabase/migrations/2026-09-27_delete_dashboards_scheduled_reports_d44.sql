-- D44: delete the Dashboards module (dashboards + scheduled reports).
--
-- Code removed in the same change: src/pages/Dashboard/*, the /dashboards,
-- /dashboards/:id and /scheduled-reports routes (now redirect to /settings),
-- the /public/dashboard/:token page (now a "no longer available" notice), the
-- Settings card, the store slice + realtime subscription, /api/analytics,
-- /api/scheduled-reports/run-now, /api/internal/run-report, the report runner,
-- and the worker's reports poll loop. The analytics engine (src/lib/analytics)
-- and metric_definitions are NOT part of D44 and stay.
--
-- Pre-delete state (live, 2026-09-27): 4 dashboards — two private Sales
-- Valuation boards (that feature was deleted in D26/D27) and two public boards
-- still named "New Dashboard" (1 and 4 widgets). 0 scheduled reports and
-- 0 report runs ever. Supabase API logs (24 h retention) showed no
-- get_public_dashboard call.
--
-- WORKER COMPATIBILITY STUBS: the Fly worker currently deployed still calls
-- scheduled_report_claim_due + scheduled_reports_watchdog on every tick (5
-- machines). Dropping them outright would log an RPC error every few seconds
-- until the worker is redeployed. So both are recreated as no-ops (empty set /
-- 0) granted to service_role only. The worker code no longer calls them — DROP
-- both stubs once a worker built from this commit is deployed.
--
-- Guarded with IF EXISTS / to_regclass so it replays on the CI fixture DB
-- (which has a minimal scheduled_reports and no dashboards).
--
-- Snapshots (recoverable):
--   _backup_dashboards_20260927           (4 rows incl. widgets + public tokens)
--   _backup_scheduled_reports_20260927    (0 rows — kept for the column shape)

BEGIN;

DO $backup$
BEGIN
  IF to_regclass('public.dashboards') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE public._backup_dashboards_20260927 AS SELECT * FROM public.dashboards';
  END IF;
  IF to_regclass('public.scheduled_reports') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE public._backup_scheduled_reports_20260927 AS SELECT * FROM public.scheduled_reports';
  END IF;
END $backup$;

DROP FUNCTION IF EXISTS public.get_public_dashboard(text);
DROP FUNCTION IF EXISTS public.scheduled_report_claim_due(text, integer);
DROP FUNCTION IF EXISTS public.scheduled_reports_watchdog();

DROP TABLE IF EXISTS public.scheduled_report_runs;
DROP TABLE IF EXISTS public.scheduled_reports;      -- takes its two triggers with it
DROP FUNCTION IF EXISTS public.scheduled_reports_fill_next_run();
DROP FUNCTION IF EXISTS public.scheduled_report_next_run(text, integer, integer, integer, timestamptz);
DROP TABLE IF EXISTS public.dashboards;             -- also leaves supabase_realtime

-- Worker compatibility stubs (see header). Drop after the next worker deploy.
CREATE FUNCTION public.scheduled_report_claim_due(p_worker_id text, p_limit integer)
RETURNS SETOF jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$ SELECT NULL::jsonb WHERE false $$;

CREATE FUNCTION public.scheduled_reports_watchdog()
RETURNS integer
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$ SELECT 0 $$;

REVOKE ALL ON FUNCTION public.scheduled_report_claim_due(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scheduled_reports_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_report_claim_due(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduled_reports_watchdog() TO service_role;

COMMIT;
