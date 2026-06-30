-- Make `main_image` THE project image everywhere (app + public website) and
-- retire the website-only `image_url` field. Applied live to wassell-prod on
-- 2026-06-30 (the UPDATEs here are idempotent; the function is CREATE OR REPLACE).
--
-- Three coordinated changes:
--   1. Backfill: copy image_url → main_image for the few projects that only had
--      image_url, so main_image is the single source.
--   2. Public RPC: the anon website hero-image resolver now whitelists main_image
--      (image_url kept as a harmless legacy fallback).
--   3. Schema: drop the image_url FIELD from the all_projects model schema. Record
--      DATA (records.data.image_url) is intentionally left intact (not deleted).
--
-- Backups: public._backup_all_projects_image_20260630 (image fields),
--          public._backup_projects_units_models_20260629 (full model schemas).

BEGIN;

-- 1. Backfill stragglers (image_url set, main_image empty) on all_projects.
UPDATE public.records r
SET data = jsonb_set(r.data, '{main_image}', r.data->'image_url'), updated_at = now()
FROM public.models m
WHERE r.model_id = m.id AND m.name = 'all_projects'
  AND NULLIF(r.data->>'image_url','') IS NOT NULL
  AND NULLIF(r.data->>'main_image','') IS NULL;

-- 2. Public-marketing file resolver: project hero image now driven by main_image.
CREATE OR REPLACE FUNCTION public.wassell_file_is_public_marketing(p_file_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    -- (A) Project hero image (main_image, with legacy image_url fallback) on a PUBLIC all_projects record.
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
    );
$function$;

-- 3. Drop the image_url FIELD from the all_projects schema (record data kept).
UPDATE public.models m SET
  schema = jsonb_set(m.schema, '{sections}', (
    SELECT jsonb_agg(
      jsonb_set(s.val, '{fields}', (
        SELECT COALESCE(jsonb_agg(f.val ORDER BY f.ord), '[]'::jsonb)
        FROM jsonb_array_elements(s.val->'fields') WITH ORDINALITY AS f(val, ord)
        WHERE f.val->>'name' <> 'image_url'
      )) ORDER BY s.ord
    )
    FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS s(val, ord)
  )),
  updated_at = now()
WHERE m.name = 'all_projects';

COMMIT;
