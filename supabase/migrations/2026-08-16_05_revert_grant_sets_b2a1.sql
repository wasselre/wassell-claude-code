-- ============================================================================
-- Phase 3 · CORRECTIVE — revert B2A.1 (grant sets, first attempt)
--
-- 2026-08-16_04_file_authz_grant_sets.sql was merged, applied to production at
-- 10:39:29 UTC, and rolled back at 10:41:08 UTC after its own fingerprint gate
-- caught a reach expansion. This file is the repository's record of that
-- rollback, and it is what makes a FRESH database land in the safe state.
--
-- ── WHY _04 IS NOT DELETED ─────────────────────────────────────────────────
-- The production ledger holds a row for it (20260816103929). Deleting the file
-- would leave that row pointing at a migration that no longer exists in the
-- repo — ledger drift between production and a fresh install, and a rewrite of
-- history that already happened. Instead _04 stays as history and _05 corrects
-- it, so every environment converges on the same end state:
--
--   production      : _04 applied 10:39:29, reverted 10:41:08  -> B2A  ✓
--   fresh install   : _04 applied, then _05 reverts it          -> B2A  ✓
--   CI              : same as fresh install                     -> B2A  ✓
--
-- A fresh database is briefly on the flawed policy DURING migration, between
-- _04 and _05. That is acceptable because no client can authenticate against a
-- database that is still being migrated; the invariant that matters is that no
-- environment FINISHES with the flawed policy active.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- _04 restated the decision as a flat OR chain and dropped the identity guard
-- that both the original function and B2A's row function apply before any
-- positive branch:
--
--     IF app_uid IS NULL THEN RETURN false;      -- original, before marketing
--
-- Without it the marketing branch was reachable by callers with no app user,
-- and public.wassell_mos_can('read', <unknown uid>) returns TRUE on this
-- database (wassell_mos_roles yields {viewer} by default). Two identities that
-- must see zero files saw all 1,270 marketing-library files.
--
-- The corrected design ships as B2A.2 in 2026-08-16_06, with the identity
-- invariant hoisted to the top of the policy.
-- ============================================================================

BEGIN;

-- Restore the B2A policy exactly (the row-function form).
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

DROP FUNCTION IF EXISTS public.wassell_granted_file_ids(uuid, text);
DROP FUNCTION IF EXISTS public.wassell_cascade_folder_ids(uuid, text);
DROP FUNCTION IF EXISTS public.wassell_marketing_file_ids();

COMMIT;
