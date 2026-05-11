-- ============================================================================
-- Restore the lookup-target branch in records_public_website_read.
--
-- 2026-05-09_n_public_lookup_targets.sql added a fourth OR branch that lets
-- the anon role read records from lookup-target models (developers, agents,
-- anything an all_projects field points at via a `lookup` field). The
-- 2026-05-10_a short-circuit migration kept that branch, gated by
-- wassell_public_lookup_model_ids() so non-target models bail out cheaply.
--
-- 2026-05-10_b_project_details_model.sql then rewrote the policy to add the
-- project_details branch, but silently dropped the lookup-target branch.
-- Net effect on production: js/wassel-data.js loadLookupTargets() returns
-- zero rows for anon, so every `lookup` field on a published project (e.g.
-- المطور / developer name) renders as an empty string on the public site.
--
-- This migration re-adds the branch on top of the 2026-05-10_b policy body,
-- restoring the four-branch policy that 2026-05-10_a had intended to be the
-- final state.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "records_public_website_read" ON public.records;
CREATE POLICY "records_public_website_read"
  ON public.records FOR SELECT TO anon
  USING (
    -- site_settings: always readable (singleton config)
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
    OR
    -- all_projects: opt-in via is_public checkbox
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND COALESCE((data->>'is_public')::boolean, false) = true
    )
    OR
    -- project_details: visible only when the parent all_projects record is public
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'project_details')
      AND public.wassell_project_is_public((data->>'project_id'))
    )
    OR
    -- Lookup-target records (developers, agents, etc.) referenced by a public
    -- project's lookup field. Gated by the short-circuit list so the expensive
    -- EXISTS-scan helper only fires for records of a lookup-target model.
    (
      model_id IN (SELECT * FROM public.wassell_public_lookup_model_ids())
      AND public.wassell_is_public_lookup_target(records.id, records.model_id)
    )
  );

COMMIT;
