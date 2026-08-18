-- ============================================================================
-- SECURITY CORRECTION — caller-scope the B2A.2 authorization helpers
--
-- Forward-only. Does NOT edit 2026-08-16_06 (applied to production 2026-08-17).
-- Changes NO user's file reach: files_select returns byte-identical id sets
-- before and after. This closes a direct-RPC bypass, not a policy hole.
--
-- ── WHAT WAS WRONG (measured on production, read-only, 2026-08-17) ─────────
-- B2A.2 introduced three SECURITY DEFINER helpers, granted EXECUTE to
-- `authenticated`, that take an ARBITRARY app-user uuid and return sets. All
-- three are set-returning, so PostgREST publishes them at /rest/v1/rpc/<name>.
-- The policy that calls them is safe; calling them DIRECTLY is not:
--
--   caller (authenticated)        via files_select     via direct RPC
--   non-admin, zero grants        1,270 files          another user's 15 view +
--                                                      14 delete grants, their
--                                                      folder set, 1,270
--                                                      marketing file ids
--   identity-less (no app user)   0 files              1,270 marketing ids +
--                                                      another user's 15 grants
--   deactivated user              0 files              1,270 marketing ids +
--                                                      another user's folder set
--
-- Two distinct defects:
--   1. The helpers trust a caller-supplied p_app_uid, so any authenticated
--      caller can enumerate ANY other user's grant topology.
--   2. wassell_marketing_file_ids() enforced nothing internally — the MOS read
--      capability and the identity guard lived only in the policy, so calling
--      the function directly skipped both.
--
-- This discloses file IDs and grant topology, not file bytes: `files` SELECT is
-- still RLS-gated and the storage paths are not returned. It is still a bypass
-- of the authorization boundary and is fixed here.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Helpers become CALLER-SCOPED: they derive the app user from auth.uid()
-- internally and accept no target user at all, so there is nothing to forge.
-- The marketing helper additionally enforces BOTH the identity guard and
-- wassell_mos_can('read') inside itself, so it is safe in isolation rather than
-- only in context.
--
-- The old parameterised helpers are DROPPED, not merely revoked — leaving an
-- unreferenced SECURITY DEFINER function that takes a target user around is how
-- this comes back.
--
-- files_select keeps the identity invariant at the top AND keeps the hoisted
-- wassell_mos_can InitPlan. The latter is now redundant for correctness (the
-- function enforces it) but preserves the fast path: when the caller has no MOS
-- read, the branch short-circuits without the function being called at all.
--
-- ── NOT LIVE, SO REVOKED ───────────────────────────────────────────────────
-- wassell_can_access_file_row and the two boolean grant probes are no longer
-- called by any live policy (B2A.2 replaced the policy that used them). They
-- stay installed because the B2A rollback path recreates a policy that needs
-- them, but EXECUTE is revoked from anon/authenticated. That rollback script
-- re-grants them; see supabase/rollback/2026-08-16_03_file_authz_performance_down.sql.
--
-- Rollback: supabase/rollback/2026-08-17_01_scope_authz_helpers_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Caller-scoped replacements. No target-user parameter exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_my_granted_file_ids(p_kind text)
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT fp.file_id
    FROM public.file_permissions fp
   WHERE fp.user_id = public.wassell_app_user_id((SELECT auth.uid()))
     AND public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
     AND public.wassell_role_satisfies(fp.role, p_kind)
$$;

CREATE OR REPLACE FUNCTION public.wassell_my_cascade_folder_ids(p_kind text)
RETURNS TABLE (folder_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  WITH RECURSIVE seed AS (
    SELECT fp.folder_id AS id
      FROM public.folder_permissions fp
     WHERE fp.user_id = public.wassell_app_user_id((SELECT auth.uid()))
       AND public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
       AND public.wassell_role_satisfies(fp.role, p_kind)
  ), tree AS (
    SELECT id FROM seed
    UNION                      -- UNION, not UNION ALL: terminates on a cycle
    SELECT f.id
      FROM public.folders f
      JOIN tree t ON f.parent_folder_id = t.id
  )
  SELECT id FROM tree
$$;

-- Enforces the identity guard AND the MOS read capability INTERNALLY, so it is
-- safe called directly, not merely safe in the policy's context.
CREATE OR REPLACE FUNCTION public.wassell_my_marketing_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT ma.file_id
    FROM public.mos_assets ma
   WHERE ma.file_id IS NOT NULL
     AND public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
     AND public.wassell_mos_can('read')
$$;

-- ---------------------------------------------------------------------------
-- 2. files_select, rebuilt on the caller-scoped helpers.
--    Identical branch order, identical result sets.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND (
       (SELECT public.wassell_is_admin((SELECT auth.uid())))
    OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
    OR id IN (SELECT g.file_id FROM public.wassell_my_granted_file_ids('view') g)
    OR ((SELECT public.wassell_mos_can('read'))
        AND id IN (SELECT m.file_id FROM public.wassell_my_marketing_file_ids() m))
    OR (folder_id IS NOT NULL
        AND folder_id IN (SELECT c.folder_id FROM public.wassell_my_cascade_folder_ids('view') c))
  )
);

-- ---------------------------------------------------------------------------
-- 3. Remove the forgeable helpers entirely.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.wassell_granted_file_ids(uuid, text);
DROP FUNCTION IF EXISTS public.wassell_cascade_folder_ids(uuid, text);
DROP FUNCTION IF EXISTS public.wassell_marketing_file_ids();

-- ---------------------------------------------------------------------------
-- 4. Grants.
-- ---------------------------------------------------------------------------
DO $g$
DECLARE fn text;
BEGIN
  -- Live policy helpers: authenticated must execute them.
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_my_granted_file_ids(text)',
    'public.wassell_my_cascade_folder_ids(text)',
    'public.wassell_my_marketing_file_ids()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;

  -- Not referenced by any live policy: take EXECUTE away from the app roles.
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_can_access_file_row(uuid,text,uuid,uuid,uuid,boolean,boolean,boolean,boolean)',
    'public.wassell_user_has_file_grants(uuid)',
    'public.wassell_user_has_folder_grants(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
  END LOOP;
END $g$;

COMMIT;
