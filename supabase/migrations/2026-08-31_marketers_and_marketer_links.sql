-- Marketers: projects can come from a marketing company (e.g. Riva), not only a
-- developer. This migration (models JSONB — unfrozen models):
--   1. all_projects: rename the "مشاريع ريفا" classification option to
--      "مشروع من مسوّق" (value kept as `riva_projects` so existing records/filters
--      don't break) + add a `marketer` lookup (→ marketers).
--   2. project_officers: add a `marketer` lookup so an officer is tied to EITHER
--      a developer OR a marketer.
--
-- The marketers model itself (37f4905c-…) is created separately. The
-- models_view_sync trigger regenerates v_all_projects / v_project_officers.
-- Idempotent: guarded so a re-run neither double-adds the field nor errors.

-- 1. all_projects — relabel the option + append the marketer lookup.
UPDATE public.models
SET schema = jsonb_set(
  schema, '{sections}',
  (SELECT jsonb_agg(
     CASE WHEN sec->>'id' = 'fad0a581-049d-4a1a-b975-b3d87df8c901'
       THEN jsonb_set(
              sec, '{fields}',
              (SELECT jsonb_agg(
                 CASE WHEN fld->>'name' = 'project_classification'
                   THEN jsonb_set(fld, '{options}',
                          (SELECT jsonb_agg(
                             CASE WHEN opt->>'value' = 'riva_projects'
                               THEN opt || jsonb_build_object('label_ar','مشروع من مسوّق','label_en','Project from a Marketer')
                               ELSE opt END)
                           FROM jsonb_array_elements(fld->'options') opt))
                   ELSE fld END)
               FROM jsonb_array_elements(sec->'fields') fld)
              || jsonb_build_array(jsonb_build_object(
                   'id', gen_random_uuid()::text, 'name','marketer','type','lookup','order',6,'width','half',
                   'is_multi', false, 'label_ar','المسوّق','label_en','Marketer','required',false,
                   'section_id','fad0a581-049d-4a1a-b975-b3d87df8c901','show_in_table',true,
                   'lookup_model_id','37f4905c-bc64-4993-a0c4-07e4f54463e2','lookup_display_field','name','lookup_max_records',500)))
       ELSE sec END)
   FROM jsonb_array_elements(schema->'sections') sec))
WHERE name = 'all_projects'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema->'sections') s,
                  jsonb_array_elements(s->'fields') f
    WHERE f->>'name' = 'marketer');

-- 2. project_officers — add the marketer lookup to the base section.
UPDATE public.models
SET schema = jsonb_set(
  schema, '{sections,0,fields}',
  (schema->'sections'->0->'fields') || jsonb_build_array(jsonb_build_object(
     'id', gen_random_uuid()::text, 'name','marketer','type','lookup','order',6,'width','half',
     'is_multi', false, 'label_ar','المسوّق','label_en','Marketer','required',false,
     'section_id','fbd413f9-d11b-4390-9286-8eb10f0f48bc','show_in_table',true,
     'lookup_model_id','37f4905c-bc64-4993-a0c4-07e4f54463e2','lookup_display_field','name','lookup_max_records',500)))
WHERE name = 'project_officers'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema->'sections'->0->'fields') f
    WHERE f->>'name' = 'marketer');
