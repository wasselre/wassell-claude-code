-- Clean the website settings record (2026-10-04).
--
-- `site_settings` had 190 fields in 14 sections; 30 had ever been filled in.
-- Every field was checked against the website repo (Wassel Website: every
-- .html / .js / .mjs except the i18n dictionary): only the 55 below are read —
-- 47 by name, plus the eight unit-card slots api/project-units.js reads through
-- `unit_card_${slot}_field`. The other 135 render nowhere (most were copy for
-- homepage sections whose text is hard-coded in index.html). The CRM reads none
-- of these fields.
--
-- This migration:
--   1. snapshots the model row and the record row,
--   2. keeps only those 55 fields in the schema and drops sections left empty,
--   3. removes every stored value whose key is not one of them — the 33 pd_*
--      texts of the old long project page and an unread `hours_en`. No filled-in
--      value of a kept field is touched.
-- Restore = UPDATE models / records from the two backup tables.

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_site_settings_model_20261004 AS
  SELECT * FROM public.models WHERE name = 'site_settings';
CREATE TABLE IF NOT EXISTS public._backup_site_settings_record_20261004 AS
  SELECT r.* FROM public.records r JOIN public.models m ON m.id = r.model_id
   WHERE m.name = 'site_settings';
REVOKE ALL ON public._backup_site_settings_model_20261004 FROM anon, authenticated;
REVOKE ALL ON public._backup_site_settings_record_20261004 FROM anon, authenticated;

CREATE TEMP TABLE _keep(name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _keep(name) VALUES
  -- brand + navigation
  ('brand_name_ar'), ('brand_name_en'), ('nav_home'), ('nav_projects'), ('nav_map'), ('nav_cta'),
  -- hero
  ('hero_title'), ('hero_subtitle'), ('hero_description'), ('hero_bg_image_url'),
  -- section headlines still wired on the homepage
  ('journey_headline'), ('cap_headline'), ('services_headline'),
  -- footer, contact, social
  ('footer_brand_ar'), ('footer_brand_en'), ('footer_tagline_ar'), ('footer_tagline_2'),
  ('footer_contact_heading'), ('address_ar'), ('address_en'), ('contact_phone'), ('contact_email'),
  ('footer_hours_heading'), ('hours_ar'), ('hours_weekend'), ('footer_social_heading'),
  ('linkedin_url'), ('tiktok_url'), ('instagram_url'), ('whatsapp_phone'),
  ('footer_copyright'), ('footer_back_to_top'),
  -- map card slots (map.html → resolveMapCardConfig)
  ('card_status_field'), ('card_chip1_field'), ('card_chip2_field'), ('card_chip3_field'),
  ('card_price_field'), ('card_cta_url_field'),
  -- project card slots (resolveProjectCardConfig)
  ('proj_card_image_field'), ('proj_card_title_field'), ('proj_card_subtitle_field'),
  ('proj_card_status_field'), ('proj_card_chip1_field'), ('proj_card_chip2_field'),
  ('proj_card_price_field'), ('proj_card_cta_url_field'),
  -- unit card slots (api/project-units.js, read as unit_card_${slot}_field)
  ('unit_card_image_field'), ('unit_card_title_field'), ('unit_card_subtitle_field'),
  ('unit_card_status_field'), ('unit_card_badge_field'), ('unit_card_price_field'),
  ('unit_card_spec1_field'), ('unit_card_spec2_field'), ('unit_card_spec3_field');

-- Filled-in kept values before, so the assertion can prove none were lost.
CREATE TEMP TABLE _before ON COMMIT DROP AS
  SELECT e.key, e.value
    FROM public.records r JOIN public.models m ON m.id = r.model_id,
         jsonb_each(r.data) e
   WHERE m.name = 'site_settings' AND e.key IN (SELECT name FROM _keep);

-- 2. Schema: keep only the listed fields; drop sections left with none.
UPDATE public.models m
   SET schema = jsonb_set(m.schema, '{sections}', (
         SELECT COALESCE(jsonb_agg(sec ORDER BY so), '[]'::jsonb)
           FROM (
             SELECT s || jsonb_build_object('fields', (
                      SELECT COALESCE(jsonb_agg(f ORDER BY fo), '[]'::jsonb)
                        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS x(f, fo)
                       WHERE f->>'name' IN (SELECT name FROM _keep))) AS sec,
                    so
               FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, so)
           ) t
          WHERE jsonb_array_length(sec->'fields') > 0)),
       updated_at = now()
 WHERE m.name = 'site_settings';

-- 3. Data: drop every stored key that is not a kept field.
UPDATE public.records r
   SET data = (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                 FROM jsonb_each(r.data) e
                WHERE e.key IN (SELECT name FROM _keep))
  FROM public.models m
 WHERE m.id = r.model_id AND m.name = 'site_settings';

DO $assert$
DECLARE n_fields int; n_lost int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.models WHERE name = 'site_settings') THEN
    SELECT count(*) INTO n_fields
      FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
     WHERE m.name = 'site_settings';
    IF n_fields <> (SELECT count(*) FROM _keep) THEN
      RAISE EXCEPTION 'SITE_SETTINGS_CLEANUP expected % fields, found %', (SELECT count(*) FROM _keep), n_fields;
    END IF;
  END IF;
  SELECT count(*) INTO n_lost
    FROM _before b
   WHERE NOT EXISTS (
     SELECT 1 FROM public.records r JOIN public.models m ON m.id = r.model_id
      WHERE m.name = 'site_settings' AND r.data -> b.key = b.value);
  IF n_lost > 0 THEN
    RAISE EXCEPTION 'SITE_SETTINGS_CLEANUP would lose % kept values', n_lost;
  END IF;
END $assert$;

COMMIT;
