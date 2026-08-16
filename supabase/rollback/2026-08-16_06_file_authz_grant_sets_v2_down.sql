-- ============================================================================
-- Rollback for Phase 3 · B2A.2 — set-based grant and folder resolution
--
-- Restores the B2A files_select policy verbatim and drops the three set
-- helpers. B2A stays installed, so rolling back lands on the verified, already
-- live B2A behaviour rather than all the way back to the slow original.
-- Reach is unchanged in either direction.
-- ============================================================================

BEGIN;

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
