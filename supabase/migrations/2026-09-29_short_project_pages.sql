-- Short project pages (2026-09-29).
--
-- The public project page (wassel.re/project?id=…) was rebuilt as a short page
-- (hero image → name → facts card → unit list). It now reads, from the
-- per-project `project_details` sidecar, ONLY: the hero image override, the
-- eight gallery images, an optional WhatsApp number and the show-units switch.
-- Everything else — description, features, landmarks, brochure, agent card,
-- accent colour, per-section show_* switches and the 33 pd_* page-text
-- overrides — is no longer rendered anywhere. The same is true of the
-- site_settings section «قالب صفحة تفاصيل المشروع» (the site-wide defaults for
-- those 33 pd_* texts).
--
-- This migration removes those fields from the two FORMS only. The stored
-- values stay in records.data untouched, and both model rows are snapshotted,
-- so restoring the old forms is a single UPDATE from the backup table.

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_models_project_pages_20260929 AS
  SELECT * FROM public.models WHERE name IN ('project_details', 'site_settings');
REVOKE ALL ON public._backup_models_project_pages_20260929 FROM anon, authenticated;

-- 1. project_details: keep the base section with the eleven fields the page
--    still uses; drop the pd_* override section.
UPDATE public.models m
   SET schema = jsonb_set(
         m.schema, '{sections}',
         (SELECT COALESCE(jsonb_agg(
                   CASE WHEN (s->>'is_base')::boolean THEN
                     s || jsonb_build_object(
                       'label_ar', 'صفحة المشروع على الموقع',
                       'label_en', 'Project page on the website',
                       'fields', (
                         SELECT COALESCE(jsonb_agg(
                                  CASE f->>'name'
                                    WHEN 'hero_image_url' THEN f || jsonb_build_object(
                                      'label_ar', 'صورة الواجهة (تستبدل الصورة الرئيسية للمشروع)',
                                      'label_en', 'Hero image (replaces the project''s main image)')
                                    WHEN 'agent_whatsapp' THEN f || jsonb_build_object(
                                      'label_ar', 'رقم واتساب لهذا المشروع (اختياري)',
                                      'label_en', 'WhatsApp number for this project (optional)')
                                    ELSE f END
                                  ORDER BY fo), '[]'::jsonb)
                           FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS x(f, fo)
                          WHERE f->>'name' IN (
                            'project_id', 'hero_image_url',
                            'gallery_image_1', 'gallery_image_2', 'gallery_image_3', 'gallery_image_4',
                            'gallery_image_5', 'gallery_image_6', 'gallery_image_7', 'gallery_image_8',
                            'agent_whatsapp', 'show_units'))
                     )
                   END ORDER BY so) FILTER (WHERE (s->>'is_base')::boolean), '[]'::jsonb)
            FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, so))),
       updated_at = now()
 WHERE m.name = 'project_details';

-- 2. site_settings: drop the «قالب صفحة تفاصيل المشروع» section (pd_* defaults).
UPDATE public.models m
   SET schema = jsonb_set(
         m.schema, '{sections}',
         (SELECT COALESCE(jsonb_agg(s ORDER BY so), '[]'::jsonb)
            FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, so)
           WHERE NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(s->'fields') f WHERE f->>'name' LIKE 'pd\_%'))),
       updated_at = now()
 WHERE m.name = 'site_settings';

-- 3. Guard: the project link must survive, and no stored value is lost.
DO $assert$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
   WHERE m.name = 'project_details' AND f->>'name' = 'project_id';
  IF EXISTS (SELECT 1 FROM public.models WHERE name = 'project_details') AND n <> 1 THEN
    RAISE EXCEPTION 'SHORT_PROJECT_PAGES project_id field lost (found %)', n;
  END IF;
END $assert$;

COMMIT;
