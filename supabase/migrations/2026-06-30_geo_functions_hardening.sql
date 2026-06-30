-- ============================================================================
-- Harden the geo functions (security advisor follow-up)
-- ============================================================================
-- 1. Pin search_path on the two SQL helper functions (function_search_path_mutable).
-- 2. Supabase DEFAULT PRIVILEGES auto-grant EXECUTE to anon+authenticated on every
--    new public function (the ACL carries an explicit `anon=X`, not a PUBLIC grant —
--    so REVOKE FROM PUBLIC is a no-op). Revoke `anon` explicitly on the SECURITY
--    DEFINER functions so an unauthenticated caller can't drive them; the trigger
--    function is revoked from everyone (it only fires as a trigger). The finder
--    calls compile/match with the caller's JWT (role `authenticated`), which keeps
--    execute — so nothing in the app breaks.
-- The definer-only point tables keep RLS-enabled-no-policy by design (accessed
-- solely through these functions); that advisor INFO is intentional.
-- ============================================================================

BEGIN;

ALTER FUNCTION public._geo_point_from_data(jsonb)    SET search_path = public;
ALTER FUNCTION public._geo_district_from_data(jsonb) SET search_path = public;

REVOKE EXECUTE ON FUNCTION public._sync_geo_point() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.wassell_compile_client_geo(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.wassell_compile_client_geo(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.wassell_geo_match(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.wassell_geo_match(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.wassell_search_geo_elements(text, text, text, text, int, boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.wassell_search_geo_elements(text, text, text, text, int, boolean) TO authenticated, service_role;

COMMIT;
