-- NEGATIVE CONTROL for B2A.2.
--
-- Installs the B2A.2 policy with ONE thing removed: the top-level identity
-- invariant. This is byte-for-byte what B2A.1 shipped, and it is the exact
-- defect that reached production on 2026-08-16 at 10:39:29 UTC.
--
-- The runner applies this, re-measures the policy fingerprints, and REQUIRES
-- that they diverge for the identity-less personas. A suite that stays green
-- against this mutant is not testing the thing it claims to test — which is
-- precisely what happened when the fixture's wassell_mos_can was gentler than
-- production's.
--
-- Never referenced by a migration. Test-only.

DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  -- identity invariant DELIBERATELY ABSENT
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
