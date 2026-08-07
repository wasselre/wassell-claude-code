-- ============================================================================
-- Public project pages redesign — W9: close the raw-anon record-data leak.
--
-- The May-2026 anon policy `records_public_website_read` handed anon the FULL
-- `data` JSONB of every public all_projects record, its project_details
-- sidecar, AND every referenced developer (leaking internal_sales_notes,
-- source_notes, project_analysis, developer notes/email, …). Row-level RLS is
-- NOT field-level security when public and internal values share one JSONB.
--
-- Every anon consumer has now been migrated to the allowlisted SECURITY DEFINER
-- public read layer (get_public_project / list_public_projects /
-- list_public_project_points / get_public_project_unit_summary /
-- get_public_project_units / get_public_site_settings) and verified live on
-- wassel.re (project page, listing, map).
--
-- AUDIT (anon consumers of records/models, both repos + DB):
--   • project page / listing / map  → migrated to the RPCs (definer, bypass RLS).
--   • index.html                     → still reads site_settings records + model
--                                       (public config; NOT sensitive — audited:
--                                       no secret/token/key/password/api keys).
--   • get_public_dashboard / shared-file / phone / visit-rating RPCs → SECURITY
--     DEFINER; do not depend on the anon records/models SELECT grant.
--   • v_website_public               → security_invoker=false; unaffected by the
--                                       base-table grant (verified).
--
-- SCOPED revoke (not a blanket REVOKE): keep ONLY the site_settings branch of
-- records_public_website_read; drop the all_projects / project_details /
-- lookup-target (developers) branches. models_public_website_read is LEFT AS-IS
-- (model schema = field definitions, not record values — not the leak — and
-- index.html reads the site_settings model schema).
--
-- ROLLBACK: recreate the 4-branch policy (definition preserved below).
-- ============================================================================

DROP POLICY IF EXISTS records_public_website_read ON public.records;

CREATE POLICY records_public_website_read
  ON public.records FOR SELECT TO anon
  USING (
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
  );

-- ── ROLLBACK (run to restore the previous, leaky behavior) ──────────────────
-- DROP POLICY IF EXISTS records_public_website_read ON public.records;
-- CREATE POLICY records_public_website_read ON public.records FOR SELECT TO anon
--   USING (
--     model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
--     OR (model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
--         AND COALESCE((data->>'is_public')::boolean, false) = true)
--     OR (model_id IN (SELECT id FROM public.models WHERE name = 'project_details')
--         AND public.wassell_project_is_public((data->>'project_id')))
--     OR (model_id IN (SELECT * FROM public.wassell_public_lookup_model_ids())
--         AND public.wassell_is_public_lookup_target(id, model_id))
--   );
