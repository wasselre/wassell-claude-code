-- ============================================================================
-- Role-path workflows must be readable by the people working under them.
--
-- The workflows table's SELECT policy predates role-paths and gates on
-- profiles.can_view_workflows — a Sales-admin capability. Marketing members
-- (writer, montage, ...) don't hold it, yet StageRail / the board / checklists
-- all render the role-path definition. This adds a SCOPED read policy:
-- role_path rows are visible to anyone with marketing read capability.
-- Automation workflows keep their original gate untouched.
-- ============================================================================
BEGIN;

DROP POLICY IF EXISTS workflows_role_path_read ON public.workflows;
CREATE POLICY workflows_role_path_read ON public.workflows
  FOR SELECT TO authenticated
  USING (kind = 'role_path' AND public.wassell_mos_can('read'));

COMMIT;
