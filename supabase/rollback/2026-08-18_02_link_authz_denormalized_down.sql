-- ============================================================================
-- Rollback for Phase 3 · B2A.4
--
-- Restores the B2A.2 files_select and the Phase 1 file_links_select, then
-- removes the denormalized columns and their maintenance.
--
-- WARNING — this rollback is NOT reach-neutral on file_links, by design.
-- The Phase 1 file_links_select routes through wassell_can_access_file, which
-- wraps the B2A-era wassell_can_access_file_row: the decision from BEFORE
-- B2A.2 restored the identity invariant. Rolling back therefore restores the
-- older, uncorrected authority on the link table. files_select is unaffected
-- either way. Only run this if B2A.4 itself is causing a worse problem, and
-- expect the link half to behave as it did on 2026-08-17.
--
-- The columns are dropped LAST so that, if the policy recreation fails, the
-- transaction aborts with the data still intact.
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

DROP TRIGGER  IF EXISTS files_push_authz      ON public.files;
DROP TRIGGER  IF EXISTS file_links_fill_authz ON public.file_links;
DROP FUNCTION IF EXISTS public.tg_files_push_authz();
DROP FUNCTION IF EXISTS public.tg_file_links_fill_authz();

DROP INDEX IF EXISTS public.file_links_uploaded_by_idx;
DROP INDEX IF EXISTS public.file_links_folder_idx;

ALTER TABLE public.file_links
  DROP COLUMN IF EXISTS uploaded_by_user_id,
  DROP COLUMN IF EXISTS folder_id;

COMMIT;
