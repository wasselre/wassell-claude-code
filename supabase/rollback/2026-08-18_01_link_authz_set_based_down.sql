-- ============================================================================
-- Rollback for Phase 3 · B2A.3 — set-based file_links_select
--
-- Restores the B2A.2 files_select (branches inline) and the Phase 1
-- file_links_select (per-edge wassell_can_access_file), then drops the shared
-- visibility function. Reach is identical either way; only speed differs, so
-- this is safe at any time — it simply makes the link facets slow again.
-- ============================================================================

BEGIN;

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

DROP POLICY IF EXISTS file_links_select ON public.file_links;
CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated
USING (
  public.wassell_can_access_file(file_id, 'view'::text)
  AND EXISTS (SELECT 1 FROM public.unified_records ur
               WHERE ur.id = file_links.record_id
                 AND ur.model_id = file_links.model_id)
);

DROP FUNCTION IF EXISTS public.wassell_my_visible_file_ids();

COMMIT;
