-- ============================================================================
-- mos_content_versions: writers may overwrite their OWN round snapshot.
--
-- task_complete snapshots the round via upsert (content_id, round). The
-- ON CONFLICT DO UPDATE arm is policy-checked against the UPDATE policy,
-- which was 'assign'-only — so a Writer resubmitting the same round 403'd
-- (found live during the fixture build, 2026-08-01). Widen: the submitter
-- capability (write_content) may update the snapshot too; reviewers keep
-- using it to attach the rejection note.
-- ============================================================================
BEGIN;

DROP POLICY IF EXISTS mos_content_versions_upd ON public.mos_content_versions;
CREATE POLICY mos_content_versions_upd ON public.mos_content_versions
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('assign') OR public.wassell_mos_can('write_content'))
  WITH CHECK (public.wassell_mos_can('assign') OR public.wassell_mos_can('write_content'));

COMMIT;
