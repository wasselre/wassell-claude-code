-- ============================================================================
-- Sales profile can VIEW the project catalog (operator report, 2026-10-05).
--
-- The Project Finder (api/project-finder.ts) runs with the caller's own JWT,
-- so RLS decides what it can match. The Sales profile had our_projects but no
-- all_projects / units / developers permission — and every our_projects entry
-- points at its all_projects master for location, prices and units. So for the
-- new sales agent every search returned nothing.
--
-- View only, all rows (the catalog is not per-rep). Idempotent: adds an entry
-- only for a model the profile has no entry for. Backup in
-- _backup_profiles_sales_20261005b.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_profiles_sales_20261005b AS
  SELECT * FROM public.profiles WHERE label_en = 'Sales';

UPDATE public.profiles p
   SET model_permissions = p.model_permissions || (
     SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'model_id', m.id::text, 'permissions', jsonb_build_array('view'), 'view_scope', NULL)), '[]'::jsonb)
       FROM public.models m
      WHERE m.name IN ('all_projects', 'units', 'developers')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.model_permissions) e WHERE e->>'model_id' = m.id::text))
 WHERE p.label_en = 'Sales';

COMMIT;
