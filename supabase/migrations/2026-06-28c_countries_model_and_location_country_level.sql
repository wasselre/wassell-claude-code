-- ============================================================================
-- Countries reference model + country as the top level of the location cascade
-- (2026-06-28c)
--
-- 1. New `countries` model (unfrozen) seeded with Saudi Arabia only.
-- 2. Remove the standalone country fields (all_projects.preferred_country,
--    units.country — both "الدولة").
-- 3. Prepend a `country` level to every location field's cascade
--    (country → region → city → district) + default country = السعودية.
--    Region has no country link (single country) so it shows all regions.
--
-- countries model id: d15a0001-0000-4000-8000-000000000003
-- Saudi record id:    d15a0003-0000-4000-8000-000000000001
-- ============================================================================
BEGIN;

-- 1. Countries model — in the الجغرافيا (geography) group, ordered first (it's the
--    top of the country → region → city → district hierarchy).
INSERT INTO public.models (id, name, label_ar, label_en, icon, color, schema, card_config, is_system, "order", is_hardcoded, group_id)
VALUES (
  'd15a0001-0000-4000-8000-000000000003', 'countries', 'الدول', 'Countries', 'globe', '#0D9488',
  jsonb_build_object('section_selector_field_id', NULL, 'sections', jsonb_build_array(
    jsonb_build_object('id','d15a0003-5ec0-4000-8000-000000000001','label_ar','معلومات الدولة','label_en','Country Info','order',0,'is_base',true,'color','#0D9488','fields', jsonb_build_array(
      jsonb_build_object('id','d15a0003-f1d0-4000-8001-000000000001','name','name_ar','label_ar','الاسم (عربي)','label_en','Name (AR)','type','text','required',true,'order',0,'section_id','d15a0003-5ec0-4000-8000-000000000001','width','half','show_in_table',true),
      jsonb_build_object('id','d15a0003-f1d0-4000-8001-000000000002','name','name_en','label_ar','الاسم (إنجليزي)','label_en','Name (EN)','type','text','required',false,'order',1,'section_id','d15a0003-5ec0-4000-8000-000000000001','width','half','show_in_table',true),
      jsonb_build_object('id','d15a0003-f1d0-4000-8001-000000000003','name','display_name','label_ar','الاسم المعروض','label_en','Display name','type','text','required',false,'order',2,'section_id','d15a0003-5ec0-4000-8000-000000000001','width','full','show_in_table',true),
      jsonb_build_object('id','d15a0003-f1d0-4000-8001-000000000004','name','iso_code','label_ar','رمز الدولة','label_en','ISO code','type','text','required',false,'order',3,'section_id','d15a0003-5ec0-4000-8000-000000000001','width','half','show_in_table',true),
      jsonb_build_object('id','d15a0003-f1d0-4000-8001-000000000005','name','is_active','label_ar','نشط','label_en','Active','type','checkbox','required',false,'order',4,'section_id','d15a0003-5ec0-4000-8000-000000000001','width','half','show_in_table',false)
    )))),
  jsonb_build_object('title_field_id','d15a0003-f1d0-4000-8001-000000000001','shown_field_ids', jsonb_build_array('d15a0003-f1d0-4000-8001-000000000004')),
  true, 0, false, 'd15a0001-9700-4000-8000-000000000000'
)
ON CONFLICT (id) DO NOTHING;

-- Seed Saudi Arabia.
INSERT INTO public.records (id, model_id, data)
VALUES (
  'd15a0003-0000-4000-8000-000000000001', 'd15a0001-0000-4000-8000-000000000003',
  jsonb_build_object('name_ar','السعودية','name_en','Saudi Arabia','display_name','السعودية','iso_code','SA','is_active',true)
)
ON CONFLICT (id) DO NOTHING;

-- 2. Remove the standalone country fields.
UPDATE public.models m SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(jsonb_set(sec, '{fields}', COALESCE((
    SELECT jsonb_agg(f) FROM jsonb_array_elements(sec->'fields') f WHERE (f->>'name') NOT IN ('preferred_country','country'))
  , '[]'::jsonb)))
  FROM jsonb_array_elements(m.schema->'sections') sec))
WHERE m.name IN ('all_projects','units','clients');

-- 3. Prepend a `country` level + default to every location field (idempotent: any
--    existing country level is dropped first).
UPDATE public.models m SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(jsonb_set(sec, '{fields}', (
    SELECT jsonb_agg(CASE WHEN f->>'name'='location'
      THEN jsonb_set(
             jsonb_set(f, '{location_levels}',
               jsonb_build_array(jsonb_build_object('key','country','model_id','d15a0001-0000-4000-8000-000000000003','display_field','name_ar'))
               || COALESCE((SELECT jsonb_agg(lv) FROM jsonb_array_elements(f->'location_levels') lv WHERE lv->>'key' <> 'country'), '[]'::jsonb)),
             '{location_default}', COALESCE(f->'location_default','{}'::jsonb) || jsonb_build_object('country','d15a0003-0000-4000-8000-000000000001'))
      ELSE f END)
    FROM jsonb_array_elements(sec->'fields') f)))
  FROM jsonb_array_elements(m.schema->'sections') sec))
WHERE m.name IN ('all_projects','clients','market_listings','real_estate_offices');

COMMIT;
