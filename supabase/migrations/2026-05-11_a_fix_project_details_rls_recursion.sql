-- ============================================================================
-- Fix infinite recursion in records_public_website_read.
--
-- The previous policy (introduced in 2026-05-10_b_project_details_model.sql)
-- added a branch for project_details that did
--
--   EXISTS (
--     SELECT 1 FROM public.records p
--     WHERE p.id::text = (records.data->>'project_id') AND ...
--   )
--
-- The inner SELECT against `public.records` is itself subject to the very
-- same policy → Postgres detects the self-reference at planning time and
-- raises `42P17 infinite recursion detected in policy for relation
-- "records"`. The error surfaced as the website silently falling back to
-- its static demo content (anon reads on the records table returned 500).
--
-- Fix: wrap the parent-project check in a SECURITY DEFINER function. Same
-- pattern as wassell_is_public_lookup_target from
-- 2026-05-09_o_fix_lookup_rls_recursion.sql — the function runs with the
-- definer's privileges, bypassing RLS on its inner query, so the calling
-- policy doesn't re-enter itself.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_project_is_public(project_id_str text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.records p
    WHERE p.model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND p.id::text = project_id_str
      AND COALESCE((p.data->>'is_public')::boolean, false) = true
  );
$$;

-- Only anon needs this for the public-website policy below. Authenticated
-- callers already get records via wassell_can_view_record.
REVOKE ALL ON FUNCTION public.wassell_project_is_public(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wassell_project_is_public(text) TO anon;

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
    -- project_details: visible only when parent project is public. Check is
    -- delegated to a SECURITY DEFINER function so PG doesn't see a recursive
    -- self-reference on records.
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'project_details')
      AND public.wassell_project_is_public(records.data->>'project_id')
    )
  );

COMMIT;
