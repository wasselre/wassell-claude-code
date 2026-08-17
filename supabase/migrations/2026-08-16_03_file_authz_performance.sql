-- ============================================================================
-- Phase 3 · B2A — File authorization performance
--
-- PERFORMANCE ONLY. Not one user gains or loses reach. This implements no part
-- of D1: there is no file_links / unified_records branch here, and B4 remains
-- the place where record-derived access is introduced as a deliberate,
-- independently measurable permission change.
--
-- ── ROOT CAUSE (measured read-only on production, 7,133 files) ─────────────
-- A bare `SELECT count(*) FROM files WHERE file_class='business'` costs
-- 1,688 ms as an admin and 3,727 ms as a non-admin, with 151,741 / 300,614
-- buffer hits. Every buffer access is a `shared hit`, so it is pure CPU. The
-- plan shows the filter as
--
--   (uploaded_by_user_id = wassell_app_user_id(...)) OR wassell_can_access_file(id,'view')
--
-- and BOTH are invoked per row. Per row, the old path performed:
--
--   1. wassell_app_user_id()   -> SELECT id FROM users              (in the policy)
--   2. wassell_is_admin()      -> users JOIN profiles               (inside the fn)
--   3. wassell_app_user_id()   -> SELECT id FROM users AGAIN        (inside the fn)
--   4. SELECT uploaded_by_user_id, folder_id FROM files WHERE id=?  (the row we ALREADY have)
--   5. SELECT role FROM file_permissions ...
--   6. EXISTS (mos_assets ...) and wassell_mos_can('read')          (roles + role_capabilities)
--   7. wassell_folder_cascade_role()  -> RECURSIVE CTE over folders
--
-- Items 1-3 and 6 do not depend on the row at all, and item 4 re-reads the row
-- being filtered. Items 5 and 7 are row-dependent but, on this data, almost
-- always answer "no": file_permissions holds 15 rows across ONE user and
-- folder_permissions 3 rows across three, while 6,665 of 7,133 files have no
-- folder at all.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Hoist everything that is per-CALLER into scalar subqueries, which PostgreSQL
-- evaluates once per statement as InitPlans, and pass the row's own columns in
-- instead of re-reading them. The decision logic itself is NOT duplicated: it
-- moves into wassell_can_access_file_row(), and the original two-argument
-- wassell_can_access_file() becomes a thin wrapper over it, so there is still
-- exactly ONE implementation of who may touch a file.
--
-- The three hoisted "can this branch possibly match" flags are hints, not
-- semantics: passing NULL makes the row function compute the value itself, so
-- the wrapper keeps the original's laziness for the edit/delete/share paths
-- while the SELECT policy passes concrete values it computed once.
--
-- ── WHAT IS DELIBERATELY NOT TOUCHED ───────────────────────────────────────
-- files_update, files_delete, file_permissions_write, document_links_select and
-- file_link_sources_select all keep calling wassell_can_access_file(id, kind)
-- with the same signature and the same answers. The marketing view-only clause,
-- the folder cascade, explicit grants, uploader ownership, RLS enablement,
-- function grants, SECURITY DEFINER search paths and anon/authenticated/
-- service_role reach are all unchanged.
--
-- Equivalence is proved, not asserted: supabase/tests/ci/fixture_b2a_reference_authz.sql
-- pins the pre-B2A function verbatim as wassell_can_access_file__reference and
-- smoke_b2a_authz_perf.sql compares sorted file-ID sets for every user × every
-- kind (view/edit/delete/share) against it.
--
-- Rollback: supabase/rollback/2026-08-16_03_file_authz_performance_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-caller "could this branch match at all" probes.
--
--    Both are SECURITY DEFINER for the same reason the rest of this surface is:
--    file_permissions and folder_permissions carry RLS whose own policies call
--    wassell_can_access_file, so reading them as the caller would recurse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_user_has_file_grants(p_app_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT p_app_uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_permissions WHERE user_id = p_app_uid)
$$;

CREATE OR REPLACE FUNCTION public.wassell_user_has_folder_grants(p_app_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT p_app_uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.folder_permissions WHERE user_id = p_app_uid)
$$;

-- ---------------------------------------------------------------------------
-- 2. The decision, expressed over values the caller already has.
--
--    Branch order is IDENTICAL to the original function, and each branch is
--    reproduced exactly:
--
--      admin                        -> true
--      no identity / no such file   -> false
--      uploader                     -> true
--      explicit grant satisfies     -> true
--      view + marketing library     -> true
--      has a folder                 -> whatever the cascade says (may be NULL)
--      otherwise                    -> false
--
--    Two details that look like nits and are not:
--
--    * wassell_role_satisfies(NULL, kind) is NULL, not false. The original
--      returns that NULL to its caller from the folder branch, so the folder
--      branch here feeds NULL into the same function rather than short-circuiting
--      to false — otherwise a "no access" answer would change from NULL to false
--      and `NOT wassell_can_access_file(...)` would flip from NULL to true.
--    * p_mos_ok / p_has_*_grants are NULLABLE HINTS. NULL means "not hoisted,
--      work it out", which is what the two-argument wrapper passes so that the
--      edit/delete paths keep the original's lazy evaluation order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_can_access_file_row(
  p_file_id           uuid,
  p_kind              text,
  p_uploader          uuid,
  p_folder            uuid,
  p_app_uid           uuid,
  p_is_admin          boolean,
  p_mos_ok            boolean DEFAULT NULL,
  p_has_file_grants   boolean DEFAULT NULL,
  p_has_folder_grants boolean DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT CASE
    WHEN COALESCE(p_is_admin, false) THEN true
    WHEN p_app_uid IS NULL OR p_file_id IS NULL OR p_uploader IS NULL THEN false
    WHEN p_uploader = p_app_uid THEN true
    -- explicit grant
    WHEN COALESCE(p_has_file_grants, true)
         AND COALESCE(public.wassell_role_satisfies(
               (SELECT fp.role FROM public.file_permissions fp
                 WHERE fp.file_id = p_file_id AND fp.user_id = p_app_uid), p_kind), false)
      THEN true
    -- marketing library, view only (unchanged clause, merely reordered so the
    -- hoisted capability can veto before the per-row EXISTS probe runs)
    WHEN p_kind = 'view'
         AND COALESCE(p_mos_ok, public.wassell_mos_can('read'))
         AND EXISTS (SELECT 1 FROM public.mos_assets ma WHERE ma.file_id = p_file_id)
      THEN true
    -- folder cascade: returns the cascade's own answer, NULL included
    WHEN p_folder IS NOT NULL THEN
      public.wassell_role_satisfies(
        CASE WHEN COALESCE(p_has_folder_grants, true)
             THEN public.wassell_folder_cascade_role(p_folder, p_app_uid)
             ELSE NULL END,
        p_kind)
    ELSE false
  END
$$;

-- ---------------------------------------------------------------------------
-- 3. The original entry point, now a wrapper. Same name, same signature, same
--    answers — every existing policy keeps working untouched.
--
--    The admin fallback on the outer COALESCE preserves an easily-missed detail
--    of the original: it checks wassell_is_admin BEFORE looking the file up, so
--    an admin gets `true` even for a file id that does not exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT COALESCE(
    (SELECT public.wassell_can_access_file_row(
              p_file_id, p_kind, f.uploaded_by_user_id, f.folder_id,
              public.wassell_app_user_id((SELECT auth.uid())),
              public.wassell_is_admin((SELECT auth.uid())),
              NULL, NULL, NULL)
       FROM public.files f WHERE f.id = p_file_id),
    public.wassell_is_admin((SELECT auth.uid())) AND p_file_id IS NOT NULL)
$$;

-- ---------------------------------------------------------------------------
-- 4. The SELECT policy, with every per-caller value hoisted into an InitPlan.
--
--    A scalar subquery with no outer reference is evaluated ONCE per statement,
--    not once per row — the documented way to make an RLS predicate stop paying
--    for caller identity 7,133 times. The admin InitPlan short-circuits the
--    entire scan to a constant for administrators, so they run no per-row
--    authorization function at all.
--
--    Semantically identical to `uploaded_by_user_id = app_uid OR
--    wassell_can_access_file(id,'view')`: the uploader test is the third branch
--    of the row function, and admin is the first.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_is_admin((SELECT auth.uid())))
  OR public.wassell_can_access_file_row(
       id, 'view', uploaded_by_user_id, folder_id,
       (SELECT public.wassell_app_user_id((SELECT auth.uid()))),
       false,
       (SELECT public.wassell_mos_can('read')),
       (SELECT public.wassell_user_has_file_grants(
                 (SELECT public.wassell_app_user_id((SELECT auth.uid()))))),
       (SELECT public.wassell_user_has_folder_grants(
                 (SELECT public.wassell_app_user_id((SELECT auth.uid()))))))
);

-- ---------------------------------------------------------------------------
-- 5. Grants: match the surrounding authorization surface exactly. These
--    functions are SECURITY DEFINER, so PUBLIC/anon must not reach them.
-- ---------------------------------------------------------------------------
DO $g$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_user_has_file_grants(uuid)',
    'public.wassell_user_has_folder_grants(uuid)',
    'public.wassell_can_access_file_row(uuid,text,uuid,uuid,uuid,boolean,boolean,boolean,boolean)'
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
