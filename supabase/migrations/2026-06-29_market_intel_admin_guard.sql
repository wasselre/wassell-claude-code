-- ============================================================================
-- Market Intelligence — admin guard + lock the refresh functions to service-role
-- ============================================================================
-- The benchmark tables are readable by every authenticated user (non-sensitive
-- aggregates). RECOMPUTING them, however, is an admin action: revoke EXECUTE on
-- the two refresh functions from PUBLIC and grant only to service_role. The
-- /api/market-intelligence recompute endpoint checks wassell_is_admin first, then
-- calls the refresh via a service-role client.
-- ============================================================================

BEGIN;

-- Admin check reuses the existing public.wassell_is_admin(auth_user_id uuid)
-- (SECURITY DEFINER). The recompute endpoint calls it (defence-in-depth on top
-- of the UI admin gate) before invoking a refresh.

REVOKE EXECUTE ON FUNCTION public.wassell_refresh_market_benchmarks() FROM public;
REVOKE EXECUTE ON FUNCTION public.wassell_refresh_demand_supply() FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_refresh_market_benchmarks() TO service_role;
GRANT EXECUTE ON FUNCTION public.wassell_refresh_demand_supply() TO service_role;

COMMIT;
