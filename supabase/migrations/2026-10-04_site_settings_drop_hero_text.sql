-- Remove the three dead homepage hero settings (2026-10-04).
--
-- `hero_title`, `hero_subtitle`, `hero_description` on site_settings were read
-- only by `setText('hero-title' / 'hero-subtitle' / 'hero-description', …)` in
-- the website's index.html and developers.html — and neither page has elements
-- with those ids any more. The live hero copy comes from the site's own keys
-- (`hp_hero_title`, `hp_hero_title2`, `hp_hero_sub`, `dp_hero_*`). Connecting
-- the old settings would have REPLACED the current headline with older text, so
-- they are removed instead (the website's dead setters were removed with them).
--
-- Values at removal, for the record (restore by re-adding the fields to the
-- Hero section and these keys to the record):
--   hero_title       = 'وصل العقارية'
--   hero_subtitle    = 'نقود المشهد العقاري بثقة واحتراف'
--   hero_description = 'شركة تجمع بين قوة السوق العقاري وعمق الخبرة في إدارة وتسويق العقارات الفاخرة بمعايير عالية الجودة'

BEGIN;

UPDATE public.models m
   SET schema = jsonb_set(m.schema, '{sections}', (
         SELECT COALESCE(jsonb_agg(sec ORDER BY so), '[]'::jsonb)
           FROM (
             SELECT s || jsonb_build_object('fields', (
                      SELECT COALESCE(jsonb_agg(f ORDER BY fo), '[]'::jsonb)
                        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS x(f, fo)
                       WHERE f->>'name' NOT IN ('hero_title', 'hero_subtitle', 'hero_description'))) AS sec,
                    so
               FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, so)
           ) t
          WHERE jsonb_array_length(sec->'fields') > 0)),
       updated_at = now()
 WHERE m.name = 'site_settings';

UPDATE public.records r
   SET data = r.data - 'hero_title' - 'hero_subtitle' - 'hero_description'
  FROM public.models m
 WHERE m.id = r.model_id AND m.name = 'site_settings';

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
     WHERE m.name = 'site_settings' AND f->>'name' IN ('hero_title', 'hero_subtitle', 'hero_description')) THEN
    RAISE EXCEPTION 'SITE_SETTINGS_HERO fields still present';
  END IF;
END $assert$;

COMMIT;
