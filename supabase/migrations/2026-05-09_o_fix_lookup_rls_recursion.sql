-- ============================================================================
-- Fix infinite-recursion in the public-website RLS policies introduced in
-- 2026-05-09_n_public_lookup_targets.sql.
--
-- Postgres applies RLS to every reference of a table — including subqueries
-- INSIDE a policy's USING clause. The 2026-05-09_n policies referenced
-- `public.models` and `public.records` from inside their own USING clauses,
-- which made the policy invoke itself recursively (42P17 infinite recursion).
--
-- Fix: pull the cross-table predicate into SECURITY DEFINER STABLE helpers.
-- DEFINER functions run as the function owner (postgres) with row_security
-- effectively off, so the subquery doesn't re-trigger the policy. Then the
-- policies just call the helpers, no recursion.
-- ============================================================================

BEGIN;

-- ─── Helper 1: which model IDs are lookup targets of all_projects? ──────────

CREATE OR REPLACE FUNCTION public.wassell_public_lookup_model_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT (f->>'lookup_model_id')::uuid
  FROM public.models m
  , jsonb_array_elements(m.schema->'sections') sec
  , jsonb_array_elements(sec->'fields') f
  WHERE m.name = 'all_projects'
    AND f->>'type' = 'lookup'
    AND f->>'lookup_model_id' IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_public_lookup_model_ids() TO anon, authenticated;

-- ─── Helper 2: is (target_record_id, target_model_id) referenced by any
--     public project's lookup field? ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.wassell_is_public_lookup_target(target_record_id uuid, target_model_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
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
      AND (f->>'lookup_model_id')::uuid = target_model_id
      AND (
        project_rec.data->>(f->>'name') = target_record_id::text
        OR
        (
          jsonb_typeof(project_rec.data->(f->>'name')) = 'array'
          AND project_rec.data->(f->>'name') ? target_record_id::text
        )
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.wassell_is_public_lookup_target(uuid, uuid) TO anon, authenticated;

-- ─── Replace the recursive policies with helper-backed ones ─────────────────

DROP POLICY IF EXISTS "records_public_website_read" ON public.records;
CREATE POLICY "records_public_website_read"
  ON public.records FOR SELECT TO anon
  USING (
    -- site_settings always readable.
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
    OR
    -- Public projects.
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND COALESCE((data->>'is_public')::boolean, false) = true
    )
    OR
    -- Lookup-target records referenced by some public project.
    public.wassell_is_public_lookup_target(records.id, records.model_id)
  );

DROP POLICY IF EXISTS "models_public_website_read" ON public.models;
CREATE POLICY "models_public_website_read"
  ON public.models FOR SELECT TO anon
  USING (
    name IN ('all_projects', 'site_settings')
    OR
    id IN (SELECT * FROM public.wassell_public_lookup_model_ids())
  );

COMMIT;
