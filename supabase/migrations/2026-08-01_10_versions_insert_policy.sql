-- ============================================================================
-- mos_content_versions INSERT: any step-submitter role, not only writers.
--
-- task_complete snapshots EVERY 'submitted' close — and role-path steps are
-- owned by montage and ops_supervisor too (collect/montage/schedule steps).
-- Ops holds no write_content, so its submit 403'd on the snapshot INSERT
-- (found live driving fixture items through their paths, 2026-08-01).
-- ============================================================================
BEGIN;

DROP POLICY IF EXISTS mos_content_versions_ins ON public.mos_content_versions;
CREATE POLICY mos_content_versions_ins ON public.mos_content_versions
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('write_content') OR public.wassell_mos_can('assign'));

COMMIT;
