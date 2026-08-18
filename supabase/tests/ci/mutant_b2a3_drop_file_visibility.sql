-- NEGATIVE CONTROL A for B2A.3: file-visibility half removed.
--
-- Leaves only the record-visibility test, so an edge becomes visible whenever
-- the caller can see the TARGET RECORD — regardless of whether they may see the
-- FILE. Both-sided privacy collapses to one side.
--
-- The runner requires edge fingerprints to DIVERGE under this mutant. If they
-- do not, the suite is not actually testing the file half.
DROP POLICY IF EXISTS file_links_select ON public.file_links;
CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.unified_records ur
               WHERE ur.id = file_links.record_id
                 AND ur.model_id = file_links.model_id)
);
