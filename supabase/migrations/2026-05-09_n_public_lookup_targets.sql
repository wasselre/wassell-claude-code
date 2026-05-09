-- ============================================================================
-- Public website — read access to records referenced by public projects'
-- lookup fields (e.g. developers, unit types, anything an admin pins to a
-- Map Card slot via site_settings).
--
-- Without this, picking a `lookup` field in the Map Card config (e.g. Card 1
-- = المطور / developers) renders blank on the website, because the public
-- can't see the lookup TARGET records — only the project record holding the
-- target's UUID. The website's formatFieldValue resolves a lookup by reading
-- the target record and pulling out its lookup_display_field, so we have to
-- expose the relevant target records to anon.
--
-- Scope is tight: anon can read a record from a lookup-target model ONLY if
-- that record is actually referenced by a published project's lookup field.
-- Same for the models row — the website fetches the target model's schema to
-- know which field is lookup_display_field. Single + multi lookups both
-- supported (UUID-string equality on `data->>'<name>'` and JSONB-array
-- containment on `data->'<name>'`).
-- ============================================================================

BEGIN;

-- Records: extend the existing public-read policy to cover lookup targets.
DROP POLICY IF EXISTS "records_public_website_read" ON public.records;
CREATE POLICY "records_public_website_read"
  ON public.records FOR SELECT TO anon
  USING (
    -- site_settings is always readable (no per-record gating).
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
    OR
    -- A published project record.
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND COALESCE((data->>'is_public')::boolean, false) = true
    )
    OR
    -- A record that's the lookup target of some all_projects lookup field
    -- on a published project. Single lookups store the UUID as a string at
    -- data->>'<name>'; multi lookups store an array at data->'<name>'.
    EXISTS (
      SELECT 1
      FROM public.records project_rec
      JOIN public.models all_projects_model
        ON all_projects_model.id = project_rec.model_id
        AND all_projects_model.name = 'all_projects'
      , jsonb_array_elements(all_projects_model.schema->'sections') sec
      , jsonb_array_elements(sec->'fields') f
      WHERE COALESCE((project_rec.data->>'is_public')::boolean, false) = true
        AND f->>'type' = 'lookup'
        AND f->>'lookup_model_id' IS NOT NULL
        AND (f->>'lookup_model_id')::uuid = records.model_id
        AND (
          -- Single-value lookup
          project_rec.data->>(f->>'name') = records.id::text
          OR
          -- Multi-value lookup (JSONB array of UUIDs)
          (
            jsonb_typeof(project_rec.data->(f->>'name')) = 'array'
            AND project_rec.data->(f->>'name') ? records.id::text
          )
        )
    )
  );

-- Models: anon needs to read the schema of every lookup-target model used by
-- all_projects so the website knows which field is lookup_display_field.
DROP POLICY IF EXISTS "models_public_website_read" ON public.models;
CREATE POLICY "models_public_website_read"
  ON public.models FOR SELECT TO anon
  USING (
    name IN ('all_projects', 'site_settings')
    OR
    id IN (
      SELECT DISTINCT (f->>'lookup_model_id')::uuid
      FROM public.models all_projects_model
      , jsonb_array_elements(all_projects_model.schema->'sections') sec
      , jsonb_array_elements(sec->'fields') f
      WHERE all_projects_model.name = 'all_projects'
        AND f->>'type' = 'lookup'
        AND f->>'lookup_model_id' IS NOT NULL
    )
  );

COMMIT;
