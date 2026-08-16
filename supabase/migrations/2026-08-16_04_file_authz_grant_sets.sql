-- ============================================================================
-- Phase 3 · B2A.1 — set-based grant and folder resolution
--
-- Forward-only follow-up to B2A (20260816095637), which is LIVE and is NOT
-- edited here. PERFORMANCE ONLY: no D1 record-derived access, no new grants,
-- no change to view/edit/delete/share reach.
--
-- ── WHAT B2A LEFT ON THE TABLE ─────────────────────────────────────────────
-- B2A hoisted every per-CALLER value into InitPlans and killed the redundant
-- self-lookup. Measured on production it took admin 1,724 -> 6.5 ms and a
-- marketing non-admin 3,797 -> 180 ms, with buffers 300,614 -> 33,916.
--
-- One persona stayed at 519.9 ms: the only user holding BOTH explicit file
-- grants AND folder grants. For them both hoisted flags are true, so the two
-- row-dependent probes still run for all 7,134 rows:
--
--     (SELECT role FROM file_permissions WHERE file_id = <row> AND user_id = me)
--     wassell_folder_cascade_role(<row folder>, me)     -- RECURSIVE, per row
--
-- Those are index probes, not scans, but 7,134 of them cost ~4.75 buffers each.
--
-- ── WHY NOT InitPlan ARRAYS ────────────────────────────────────────────────
-- Hoisting the granted ids into an array and testing `id = ANY(arr)` would fix
-- THIS user (15 grants) and quietly break a future one: array membership is a
-- linear scan per row, so at a few thousand grants it is worse than the probe
-- it replaced. Rejected on cardinality grounds, and the smoke proves the point
-- with a synthetic 3,000-grant persona.
--
-- ── THE DESIGN ─────────────────────────────────────────────────────────────
-- Express each branch as a SET the planner can hash ONCE and semi-join:
--
--     id        IN (SELECT ... wassell_granted_file_ids(me, kind))
--     folder_id IN (SELECT ... wassell_cascade_folder_ids(me, kind))
--     id        IN (SELECT ... wassell_marketing_file_ids())
--
-- Each is a subquery with no outer reference, so it is evaluated once and
-- hashed; per-row cost becomes a hash lookup that does not grow with grant
-- count. All three are SECURITY DEFINER because file_permissions and
-- folder_permissions carry RLS whose own policies call wassell_can_access_file
-- — reading them as the caller would recurse.
--
-- ── THE FOLDER CASCADE IS INVERTED, AND THAT IS SAFE ───────────────────────
-- The original walks UP from a file's folder to its ancestors and takes the MAX
-- role found. Doing that per row is the expensive part. This walks DOWN from
-- the user's granted folders to every descendant, once.
--
-- Equivalent because wassell_role_satisfies is MONOTONE in owner > editor >
-- viewer: "the maximum ancestor role satisfies kind" holds exactly when "some
-- ancestor grant's role satisfies kind" holds — the maximum IS one of the
-- grants. So filtering each grant by satisfies() and unioning descendants
-- yields the same file set as computing the max and then filtering.
--
-- ── WHAT IS NOT TOUCHED ────────────────────────────────────────────────────
-- wassell_can_access_file (2-arg) and wassell_can_access_file_row keep their
-- definitions from B2A, so files_update, files_delete, file_permissions_write
-- and document_links_select are byte-for-byte unaffected. Only the files_select
-- policy is replaced. Equivalence of that policy is proved against the pinned
-- pre-B2A reference oracle for every persona x every operation.
--
-- Rollback: supabase/rollback/2026-08-16_04_file_authz_grant_sets_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The three sets.
-- ---------------------------------------------------------------------------

-- Files the caller holds an explicit grant on that satisfies `p_kind`.
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

-- Every folder reachable from a grant the caller holds, walking DOWN. Includes
-- the granted folders themselves. A folder can be reached from more than one
-- grant; DISTINCT collapses that.
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

-- Files that are marketing-library assets. Row-independent, so it is hoisted
-- out of the per-row path entirely; the caller still gates it on
-- wassell_mos_can('read'), exactly as before.
CREATE OR REPLACE FUNCTION public.wassell_marketing_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT ma.file_id FROM public.mos_assets ma WHERE ma.file_id IS NOT NULL
$$;

-- ---------------------------------------------------------------------------
-- 2. files_select, restated set-wise.
--
--    Branch order matches the original decision exactly:
--      admin -> uploader -> explicit grant -> marketing (view only) -> folder.
--    OR is commutative here because every branch is a pure predicate, so the
--    resulting id set is identical regardless of evaluation order.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_is_admin((SELECT auth.uid())))
  OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
  OR id IN (SELECT g.file_id FROM public.wassell_granted_file_ids(
              (SELECT public.wassell_app_user_id((SELECT auth.uid()))), 'view') g)
  OR ((SELECT public.wassell_mos_can('read'))
      AND id IN (SELECT m.file_id FROM public.wassell_marketing_file_ids() m))
  OR (folder_id IS NOT NULL
      AND folder_id IN (SELECT c.folder_id FROM public.wassell_cascade_folder_ids(
              (SELECT public.wassell_app_user_id((SELECT auth.uid()))), 'view') c))
);

-- ---------------------------------------------------------------------------
-- 3. Grants: identical posture to the B2A helpers.
-- ---------------------------------------------------------------------------
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
