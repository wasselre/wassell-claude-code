-- ============================================================================
-- Phase 3 · B2A.2 — set-based grant and folder resolution, identity-guarded
--
-- Retry of B2A.1 (2026-08-16_04, reverted by _05). PERFORMANCE ONLY: no D1
-- record-derived access, no new grants, no change to view/edit/delete/share
-- reach. B2A stays installed underneath and is not edited.
--
-- ── THE BUG THIS FIXES ─────────────────────────────────────────────────────
-- B2A.1 restated the decision as a flat OR chain, which dropped the identity
-- guard the original applies before ANY positive branch:
--
--     IF wassell_is_admin(auth.uid()) THEN RETURN true;
--     IF app_uid IS NULL THEN RETURN false;        <-- this line
--     ... uploader / grant / marketing / folder ...
--
-- The marketing branch then became reachable without an app user, and on this
-- database wassell_mos_can('read', <unknown uid>) is TRUE — wassell_mos_roles
-- returns {viewer} for an unmapped identity. Two identities that must see zero
-- files saw all 1,270 marketing-library files for 99 seconds in production.
--
-- ── THE INVARIANT, HOISTED ─────────────────────────────────────────────────
-- Every positive branch now sits behind one top-level test:
--
--     (SELECT wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
--
-- Guarding the ADMIN branch with it too is stricter than the original and
-- provably equivalent: wassell_is_admin only returns true via a users row with
-- is_active = true, and wassell_app_user_id resolves any such row, so
-- is_admin(uid) implies app_user_id(uid) IS NOT NULL. Nothing can be admin and
-- identity-less at the same time.
--
-- Structuring it this way means a future edit CANNOT add a branch that escapes
-- the guard without moving it, which is exactly how B2A.1 failed.
--
-- ── DESIGN (unchanged from B2A.1, and still the point) ─────────────────────
-- Each branch is a SET the planner hashes once and semi-joins, so per-row cost
-- is a hash lookup that does not grow with grant count. InitPlan arrays were
-- rejected: `id = ANY(array)` is a linear scan per row and degrades as grants
-- grow. The suite carries a 3,000-grant persona and a 12-deep folder chain to
-- keep that honest.
--
-- The folder cascade descends ONCE from the caller's granted folders instead of
-- walking up per row. Equivalent because wassell_role_satisfies is monotone in
-- owner > editor > viewer: "the maximum ancestor role satisfies" holds exactly
-- when "some ancestor grant satisfies", the maximum being one of the grants.
--
-- ── NOT TOUCHED ────────────────────────────────────────────────────────────
-- wassell_can_access_file (2-arg) and wassell_can_access_file_row keep their
-- B2A definitions, so files_update, files_delete, file_permissions_write and
-- document_links_select are unaffected. wassell_mos_can is NOT changed here:
-- its default-viewer behaviour for unknown identities is a separate security
-- concern with its own impact analysis (see docs/prd/access-control.md).
--
-- Rollback: supabase/rollback/2026-08-16_06_file_authz_grant_sets_v2_down.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_granted_file_ids(p_app_uid uuid, p_kind text)
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT fp.file_id
    FROM public.file_permissions fp
   WHERE p_app_uid IS NOT NULL
     AND fp.user_id = p_app_uid
     AND public.wassell_role_satisfies(fp.role, p_kind)
$$;

CREATE OR REPLACE FUNCTION public.wassell_cascade_folder_ids(p_app_uid uuid, p_kind text)
RETURNS TABLE (folder_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  WITH RECURSIVE seed AS (
    SELECT fp.folder_id AS id
      FROM public.folder_permissions fp
     WHERE p_app_uid IS NOT NULL
       AND fp.user_id = p_app_uid
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

-- Row-independent, so it is hoisted out of the per-row path. It is NOT a
-- capability check: the caller still gates it on wassell_mos_can('read'), and
-- from B2A.2 on, on the identity guard as well.
CREATE OR REPLACE FUNCTION public.wassell_marketing_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT ma.file_id FROM public.mos_assets ma WHERE ma.file_id IS NOT NULL
$$;

DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  -- THE IDENTITY INVARIANT. Nothing below may grant anything without it.
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND (
       (SELECT public.wassell_is_admin((SELECT auth.uid())))
    OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
    OR id IN (SELECT g.file_id FROM public.wassell_granted_file_ids(
                (SELECT public.wassell_app_user_id((SELECT auth.uid()))), 'view') g)
    OR ((SELECT public.wassell_mos_can('read'))
        AND id IN (SELECT m.file_id FROM public.wassell_marketing_file_ids() m))
    OR (folder_id IS NOT NULL
        AND folder_id IN (SELECT c.folder_id FROM public.wassell_cascade_folder_ids(
                (SELECT public.wassell_app_user_id((SELECT auth.uid()))), 'view') c))
  )
);

DO $g$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_granted_file_ids(uuid,text)',
    'public.wassell_cascade_folder_ids(uuid,text)',
    'public.wassell_marketing_file_ids()'
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
END $g$;

COMMIT;
