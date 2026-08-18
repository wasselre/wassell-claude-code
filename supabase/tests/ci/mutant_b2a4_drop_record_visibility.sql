-- NEGATIVE CONTROL B for B2A.4: record-visibility half removed.
--
-- Leaves only the file-visibility test, so an edge becomes visible whenever the
-- caller may see the FILE — even when they cannot see the record it points at.
-- That leaks the existence of, and the link to, records outside the caller's
-- scope, which is precisely the target-privacy half.
--
-- The runner requires edge fingerprints to DIVERGE under this mutant.
DROP POLICY IF EXISTS file_links_select ON public.file_links;
CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND (
       (SELECT public.wassell_is_admin((SELECT auth.uid())))
    OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
    OR file_id IN (SELECT g.file_id FROM public.wassell_my_granted_file_ids('view') g)
    OR ((SELECT public.wassell_mos_can('read'))
        AND file_id IN (SELECT m.file_id FROM public.wassell_my_marketing_file_ids() m))
    OR (folder_id IS NOT NULL
        AND folder_id IN (SELECT c.folder_id FROM public.wassell_my_cascade_folder_ids('view') c))
  )
);
