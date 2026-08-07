-- ============================================================================
-- Public project pages redesign — W7 support: extend the public-marketing-file
-- authorization to cover the gallery array + unit floor plans.
--
-- The durable image route (Website/api/img.js) resolves a file id to bytes ONLY
-- if wassell_public_marketing_files() returns it — i.e. only if
-- wassell_file_is_public_marketing() is true. Before this migration that
-- predicate covered project main_image + sidecar images, but NOT:
--   (C) all_projects.project_images[] — the full gallery (e.g. Binghatti's 39)
--   (D) units.unit_plan — floor-plan images for units of a PUBLIC project
-- so the redesigned page's gallery + unit plans would 404 through the route.
--
-- This extends the predicate with (C) and (D). It stays fail-closed: a file id
-- not referenced by a public project/unit is still refused. Idempotent replace.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.wassell_file_is_public_marketing(p_file_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    -- (A) Project hero image (main_image / legacy image_url) on a PUBLIC project.
    EXISTS (
      SELECT 1
      FROM public.records pr
      JOIN public.models mpr ON mpr.id = pr.model_id AND mpr.name = 'all_projects'
      WHERE COALESCE((pr.data->>'is_public')::boolean, false) = true
        AND p_file_id::text IN (pr.data->>'main_image', pr.data->>'image_url')
    )
    -- (B) project_details sidecar images, gated on the linked project being public.
    OR EXISTS (
      SELECT 1
      FROM public.records pd
      JOIN public.models mpd ON mpd.id = pd.model_id AND mpd.name = 'project_details'
      JOIN public.records pr ON pr.id::text = pd.data->>'project_id'
      JOIN public.models mpr ON mpr.id = pr.model_id AND mpr.name = 'all_projects'
      WHERE COALESCE((pr.data->>'is_public')::boolean, false) = true
        AND p_file_id::text IN (
          pd.data->>'hero_image_url', pd.data->>'agent_image_url',
          pd.data->>'gallery_image_1', pd.data->>'gallery_image_2',
          pd.data->>'gallery_image_3', pd.data->>'gallery_image_4',
          pd.data->>'gallery_image_5', pd.data->>'gallery_image_6',
          pd.data->>'gallery_image_7', pd.data->>'gallery_image_8'
        )
    )
    -- (C) NEW: gallery array element (project_images[]) on a PUBLIC project.
    OR EXISTS (
      SELECT 1
      FROM public.records pr
      JOIN public.models mpr ON mpr.id = pr.model_id AND mpr.name = 'all_projects'
      WHERE COALESCE((pr.data->>'is_public')::boolean, false) = true
        AND jsonb_typeof(pr.data->'project_images') = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(pr.data->'project_images') g(v)
          WHERE g.v = p_file_id::text
        )
    )
    -- (D) NEW: unit floor plan (unit_plan) for a unit whose project is PUBLIC.
    OR EXISTS (
      SELECT 1
      FROM public.records u
      JOIN public.models mu ON mu.id = u.model_id AND mu.name = 'units'
      JOIN public.records pr ON pr.id::text = (
        CASE WHEN jsonb_typeof(u.data->'project_id')='array'
             THEN u.data->'project_id'->>0 ELSE u.data->>'project_id' END)
      JOIN public.models mpr ON mpr.id = pr.model_id AND mpr.name = 'all_projects'
      WHERE COALESCE((pr.data->>'is_public')::boolean, false) = true
        AND u.data->>'unit_plan' = p_file_id::text
    );
$function$;
