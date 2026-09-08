-- =============================================================================
-- 2026-09-08 — `wassell_file_is_public_marketing` on the GIN index.
--
-- The website resolves private file ids (project heroes, unit floor plans) to
-- signed URLs through `wassell_public_marketing_files(uuid[])`, which calls
-- `wassell_file_is_public_marketing(id)` per file. Its unit-plan branch joined
-- ALL units to ALL projects on a CASE expression (no index possible) — ~65 ms
-- per file id. The new /projects listing asks for ~170 ids at once (every
-- hero + every best-unit plan), so the RPC hit the anon statement timeout and
-- every card fell back to a placeholder.
--
-- Same semantics, expressed as jsonb containment (`data @> {...}`) so the
-- `idx_records_data_gin` (jsonb_path_ops) index drives each probe: measured
-- 1.8 ms vs 64 ms for a real plan id. The project_details branch is left as
-- is (a few hundred rows, already cheap).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_file_is_public_marketing(p_file_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ap AS (SELECT id FROM public.models WHERE name = 'all_projects' LIMIT 1),
       un AS (SELECT id FROM public.models WHERE name = 'units' LIMIT 1),
       pd AS (SELECT id FROM public.models WHERE name = 'project_details' LIMIT 1)
  SELECT
    -- 1. The project's own hero / legacy image_url / gallery array.
    EXISTS (
      SELECT 1
      FROM public.records pr
      WHERE pr.model_id = (SELECT id FROM ap)
        AND COALESCE((pr.data->>'is_public')::boolean, false) = true
        AND (   pr.data @> jsonb_build_object('main_image', p_file_id::text)
             OR pr.data @> jsonb_build_object('image_url',  p_file_id::text)
             OR pr.data @> jsonb_build_object('project_images', jsonb_build_array(p_file_id::text)))
    )
    -- 2. The project_details sidecar (hero / agent / gallery slots) of a public project.
    OR EXISTS (
      SELECT 1
      FROM public.records pdr
      JOIN public.records pr ON pr.id = public._pub_try_uuid(pdr.data->>'project_id')
                            AND pr.model_id = (SELECT id FROM ap)
      WHERE pdr.model_id = (SELECT id FROM pd)
        AND COALESCE((pr.data->>'is_public')::boolean, false) = true
        AND p_file_id::text IN (
          pdr.data->>'hero_image_url', pdr.data->>'agent_image_url',
          pdr.data->>'gallery_image_1', pdr.data->>'gallery_image_2',
          pdr.data->>'gallery_image_3', pdr.data->>'gallery_image_4',
          pdr.data->>'gallery_image_5', pdr.data->>'gallery_image_6',
          pdr.data->>'gallery_image_7', pdr.data->>'gallery_image_8'
        )
    )
    -- 3. A unit floor plan whose unit belongs to a public project.
    OR EXISTS (
      SELECT 1
      FROM public.records u
      WHERE u.model_id = (SELECT id FROM un)
        AND u.data @> jsonb_build_object('unit_plan', p_file_id::text)
        AND EXISTS (
          SELECT 1 FROM public.records pr
          WHERE pr.model_id = (SELECT id FROM ap)
            AND pr.id = public._pub_try_uuid(
                  CASE WHEN jsonb_typeof(u.data->'project_id') = 'array'
                       THEN u.data->'project_id'->>0 ELSE u.data->>'project_id' END)
            AND COALESCE((pr.data->>'is_public')::boolean, false) = true
        )
    );
$function$;

COMMIT;
