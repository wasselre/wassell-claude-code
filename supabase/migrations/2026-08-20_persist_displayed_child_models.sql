-- Persist displayed_child_models into the live all_projects schema.
-- APPLIED LIVE 2026-08-20 (via MCP apply_migration `persist_displayed_child_models`).
--
-- Context: part of retiring client-side seeding. healDisplayedChildModels used to
-- inject this declaration IN-MEMORY on every boot from seedModels.ts — the server
-- row never carried it (0 models had the key). With the boot heal chain now gated
-- to offline mode, the server row must hold the declaration itself, or the
-- reference-dependency resolver (src/lib/moduleDependencies.ts) stops surfacing
-- `units` for non-admin profiles granted the all_projects module.
UPDATE public.models
SET schema = jsonb_set(schema, '{displayed_child_models}', '["units"]'::jsonb)
WHERE name = 'all_projects'
  AND NOT (schema ? 'displayed_child_models');
