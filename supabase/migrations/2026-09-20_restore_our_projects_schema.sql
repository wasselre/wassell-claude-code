-- Restore our_projects' schema, wiped by the 2026-08-20 re-seed incident.
--
-- WHAT BROKE
--   our_projects is a POINTER model: each of its 96 rows stores exactly one key,
--   `project` -> an all_projects id. It never stored a name of its own. The human
--   name, the geography and the inventory summary were all SECTION MIRRORS reaching
--   through that lookup into all_projects.
--
--   On 2026-08-20T10:04:49Z the client-side seed backfill (root cause documented in
--   2026-08-20_models_guard_block_schema_shrink.sql) overwrote models.schema for this
--   model with the SEED_MODELS baseline: 18 flat fields (project_name, location,
--   phase, rollups, notes) that no record has ever carried. The three section_mirror
--   containers, the `brochure` mirror and the whole 10-field المحفظة (portfolio)
--   section were dropped, and the `project` lookup was re-created under a NEW field id.
--
--   The shrink guard shipped that same day did not catch it: 15 fields -> 18 is
--   GROWTH, and the guard only refuses a falling field count. That is why every other
--   wiped model was restored in August and this one silently stayed broken.
--
--   Everything keyed on the old field ids has been dangling ever since:
--     * five lookups display '27ae1692-...::project_name' (the project_data container)
--       -> visits.project_id, offer_prices.project_id, reservations.project_id,
--          financing.project_id, ownership_transfer.project_id. Every one of those
--       pickers has been listing 96 raw uuids instead of project names.
--     * maps_config pin label / popup title  -> 'c7771238-...' (the project lookup)
--     * maps_config location url             -> '0cf73ff9-...::project_location'
--     * maps_config popup badge/subtitle/shown -> '27ae1692-...::*'
--     * v_our_projects_scope reads op.data->>'portfolio_status' / 'sales_priority' /
--       'show_on_website' — fields with nowhere to be entered since the wipe.
--
-- WHAT THIS DOES
--   Restores the schema + card_config verbatim from the last pre-wipe snapshot
--   (supabase/branch-bootstrap-13.sql, captured 2026-08-01), field ids included, so
--   every reference above resolves again without touching the five referencing models.
--   maps_config already points at these ids and is left exactly as it is.
--
-- DATA SAFETY
--   No record data is touched. Verified before writing this: all 96 our_projects rows
--   carry the single key `project` and nothing else, so not one of the 18 seed fields
--   being dropped holds a value anywhere. The mirror SOURCE sections on all_projects
--   (fad0a581 / 9e8fc144 / 2b138126) were verified to still exist.
--
--   Applied live via the service role, which the models_guard_schema_shrink trigger
--   passes through by design (intentional removals belong in migrations).

BEGIN;

-- Snapshot the row being replaced so this is reversible without hunting through
-- git for another bootstrap dump. Drop once the restore is confirmed settled.
CREATE TABLE IF NOT EXISTS public._backup_our_projects_model_20260920 AS
SELECT * FROM public.models WHERE name = 'our_projects';

UPDATE public.models
SET schema = $wassel${"sections":[{"id":"d011c965-5235-47d5-b305-51ada03866d0","color":"#C09B5F","order":0,"fields":[{"id":"c7771238-7b89-45e8-8fd6-2cc3f6fd1d51","name":"project","type":"lookup","order":0,"width":"full","is_multi":false,"label_ar":"المشروع","label_en":"Project","required":false,"section_id":"d011c965-5235-47d5-b305-51ada03866d0","show_in_table":true,"field_group_id":null,"lookup_model_id":"220c49b9-de57-492d-9eca-c0d9f54fd40f","lookup_max_records":20,"lookup_display_field":"project_name","auto_id_scope_field_id":null,"fallback_source_field_id":null,"mirror_target_field_name":null,"mirror_via_lookup_field_id":null,"section_mirror_source_section_id":null,"section_mirror_via_lookup_field_id":null},{"id":"b08c4c7b-e766-41ab-924c-8c1ee63fcbc2","name":"brochure","type":"mirror","order":1,"width":"half","label_ar":"البروشور","label_en":"Brochure","required":false,"section_id":"d011c965-5235-47d5-b305-51ada03866d0","visible_when":null,"show_in_table":true,"field_group_id":null,"lookup_model_id":null,"lookup_display_field":null,"auto_id_scope_field_id":null,"fallback_source_field_id":null,"mirror_target_field_name":"brochure_link","mirror_via_lookup_field_id":"c7771238-7b89-45e8-8fd6-2cc3f6fd1d51","section_mirror_source_section_id":null,"section_mirror_via_lookup_field_id":null}],"is_base":true,"label_ar":"معلومات المشروع","label_en":"Project Information"},{"id":"eb176aba-a82e-41c8-a43a-21a450147cf7","color":"#B8734F","order":1,"fields":[{"id":"27ae1692-c5dd-4ee7-85e2-8b9272b05afc","name":"project_data","type":"section_mirror","order":1,"width":"half","label_ar":"بيانات المشروع","label_en":"Project Data","required":false,"section_id":"eb176aba-a82e-41c8-a43a-21a450147cf7","show_in_table":false,"field_group_id":null,"lookup_model_id":null,"lookup_display_field":null,"auto_id_scope_field_id":null,"fallback_source_field_id":null,"mirror_target_field_name":null,"section_mirror_edit_mode":"none","section_mirror_sync_mode":"all","section_mirror_field_mode":"all","mirror_via_lookup_field_id":null,"section_mirror_source_section_id":"fad0a581-049d-4a1a-b975-b3d87df8c901","section_mirror_via_lookup_field_id":"c7771238-7b89-45e8-8fd6-2cc3f6fd1d51"}],"is_base":false,"label_ar":"بيانات المشروع","label_en":"Project Data"},{"id":"d006c203-84f4-4102-89cb-2a29945ccea2","color":"#B8734F","order":2,"fields":[{"id":"0cf73ff9-fb05-452f-9d5b-30d2d9c3c4b2","name":"geographic_info","type":"section_mirror","order":2,"width":"half","label_ar":"المعلومات الجغرافية","label_en":"Geographic Information","required":false,"section_id":"d006c203-84f4-4102-89cb-2a29945ccea2","show_in_table":false,"field_group_id":null,"lookup_model_id":null,"lookup_display_field":null,"auto_id_scope_field_id":null,"fallback_source_field_id":null,"mirror_target_field_name":null,"section_mirror_edit_mode":"none","section_mirror_sync_mode":"all","section_mirror_field_mode":"all","mirror_via_lookup_field_id":null,"section_mirror_source_section_id":"9e8fc144-d3ae-4b62-bf1c-831b152c58ac","section_mirror_via_lookup_field_id":"c7771238-7b89-45e8-8fd6-2cc3f6fd1d51"}],"is_base":false,"label_ar":"الموقع","label_en":"Location"},{"id":"5c61ca00-2e5b-442c-b211-b9aea7700cba","color":"#B8734F","order":3,"fields":[{"id":"6f9ca224-b577-44e5-a43a-e078d5a210c1","name":"unit_details","type":"section_mirror","order":2,"width":"half","label_ar":"تفاصيل الوحدات","label_en":"Unit Details","required":false,"section_id":"5c61ca00-2e5b-442c-b211-b9aea7700cba","show_in_table":false,"field_group_id":null,"lookup_model_id":null,"lookup_display_field":null,"auto_id_scope_field_id":null,"fallback_source_field_id":null,"mirror_target_field_name":null,"section_mirror_edit_mode":"none","section_mirror_sync_mode":"all","section_mirror_field_mode":"all","mirror_via_lookup_field_id":null,"section_mirror_source_section_id":"2b138126-5054-4662-88f0-f7dd4a173623","section_mirror_via_lookup_field_id":"c7771238-7b89-45e8-8fd6-2cc3f6fd1d51"}],"is_base":false,"label_ar":"تفاصيل الوحدات","label_en":"Unit Details"},{"id":"44444444-0000-4000-8000-000000000001","color":"#B8734F","order":4,"fields":[{"id":"065b1ab6-854e-46eb-bb47-ad83120f0f38","name":"portfolio_status","type":"dropdown","order":0,"width":"half","options":[{"id":"07c7ccdc-b0d3-48fc-b574-daf865352c26","color":"#10B981","value":"active","label_ar":"نشط","label_en":"Active"},{"id":"b9953cd8-1580-4957-a089-b1bab2d5ac15","color":"#F59E0B","value":"paused","label_ar":"متوقف","label_en":"Paused"},{"id":"ec2d0ed0-bd02-4e49-b51d-a9d2a4d9232c","color":"#9CA3AF","value":"hidden","label_ar":"مخفي","label_en":"Hidden"},{"id":"35d0c106-2ff5-4be6-b1f0-4c07fd76785c","color":"#8B5CF6","value":"sold_out","label_ar":"مكتمل البيع","label_en":"Sold Out"}],"label_ar":"حالة المحفظة","label_en":"Portfolio Status","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":true},{"id":"d97e22ce-9dbf-44e7-9e91-19434773c188","name":"sales_priority","type":"dropdown","order":1,"width":"half","options":[{"id":"2fff1670-73af-4697-8a33-a1236bf30eba","color":"#8E4E3A","value":"high","label_ar":"عالية","label_en":"High"},{"id":"3de98c1f-aa50-4d46-a50e-9576744a905b","color":"#C09B5F","value":"normal","label_ar":"عادية","label_en":"Normal"},{"id":"c11318c2-1fad-4f24-a5c2-d79ff97ead11","color":"#9CA3AF","value":"low","label_ar":"منخفضة","label_en":"Low"}],"label_ar":"أولوية المبيعات","label_en":"Sales Priority","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":true},{"id":"46fa27a4-1a91-4838-ba40-a905317f9daa","name":"website_display_order","type":"number","order":2,"width":"half","label_ar":"ترتيب العرض على الموقع","label_en":"Website Display Order","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":false},{"id":"e4faff02-4769-4bbc-bc4a-451a1c00da87","name":"hero_image_override","type":"image","order":3,"width":"half","label_ar":"صورة الغلاف البديلة","label_en":"Hero Image Override","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":false},{"id":"356acf87-a82c-45c5-920e-12d7a336fc16","name":"sales_pitch","type":"textarea","order":4,"width":"full","label_ar":"عرض البيع","label_en":"Sales Pitch","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":false},{"id":"f01f544b-8851-4b6b-ba28-69ef04b4e8fa","name":"objection_handling_notes","type":"textarea","order":5,"width":"full","label_ar":"التعامل مع الاعتراضات","label_en":"Objection Handling Notes","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":false},{"id":"1a9d435f-225a-4da4-aaec-ebe0059332b2","name":"exclusive_status","type":"dropdown","order":6,"width":"half","options":[{"id":"8a4ee40b-2294-4ab5-99a1-2f695b9b8453","color":"#8E4E3A","value":"exclusive","label_ar":"حصري","label_en":"Exclusive"},{"id":"d6eae1ea-8b10-412b-b722-f5fbe0b4b404","color":"#C09B5F","value":"shared","label_ar":"مشترك","label_en":"Shared"},{"id":"14fb03ba-7c17-4a1a-8d88-ec54b62ed1ba","color":"#9CA3AF","value":"open_market","label_ar":"سوق مفتوح","label_en":"Open Market"}],"label_ar":"حالة الحصرية","label_en":"Exclusive Status","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":true},{"id":"a6e4c2cb-ed5c-49f8-a2f3-9390ee50491b","name":"commission_notes","type":"textarea","order":7,"width":"full","label_ar":"ملاحظات العمولة","label_en":"Commission Notes","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":false},{"id":"33969a2f-cce1-41aa-a5be-8dcb0259e03e","name":"show_on_website","type":"checkbox","order":8,"width":"half","label_ar":"عرض على الموقع","label_en":"Show on Website","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":true},{"id":"7d55a3bd-eae4-4a28-89c6-2507ab231906","name":"portfolio_notes","type":"textarea","order":9,"width":"full","label_ar":"ملاحظات المحفظة","label_en":"Portfolio Notes","required":false,"section_id":"44444444-0000-4000-8000-000000000001","show_in_table":false}],"is_base":true,"label_ar":"المحفظة","label_en":"Portfolio"}],"custom_buttons":[],"section_selector_field_id":null}$wassel$::jsonb,
    card_config = $wassel${"badge_field_id":"065b1ab6-854e-46eb-bb47-ad83120f0f38","title_field_id":"c7771238-7b89-45e8-8fd6-2cc3f6fd1d51","shown_field_ids":["d97e22ce-9dbf-44e7-9e91-19434773c188","1a9d435f-225a-4da4-aaec-ebe0059332b2"],"subtitle_field_id":null}$wassel$::jsonb,
    updated_at = now()
WHERE id = '6609286a-f95a-45db-94e6-48cfa915ccbd'::uuid
  AND name = 'our_projects';

-- Fail loudly rather than leave a half-restored model: the container id that the
-- five downstream pickers display through must exist, and it must hop through the
-- project lookup that maps_config labels pins with.
DO $guard$
DECLARE
  f jsonb;
BEGIN
  SELECT fld INTO f
  FROM public.models m,
       jsonb_array_elements(m.schema->'sections') s,
       jsonb_array_elements(s->'fields') fld
  WHERE m.id = '6609286a-f95a-45db-94e6-48cfa915ccbd'::uuid
    AND fld->>'id' = '27ae1692-c5dd-4ee7-85e2-8b9272b05afc';

  IF f IS NULL THEN
    RAISE EXCEPTION 'restore failed: project_data container 27ae1692-... is missing from our_projects.schema';
  END IF;
  IF f->>'section_mirror_via_lookup_field_id' <> 'c7771238-7b89-45e8-8fd6-2cc3f6fd1d51' THEN
    RAISE EXCEPTION 'restore failed: project_data container does not hop through the restored project lookup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.models m,
         jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') fld
    WHERE m.id = '6609286a-f95a-45db-94e6-48cfa915ccbd'::uuid
      AND fld->>'id' = 'c7771238-7b89-45e8-8fd6-2cc3f6fd1d51'
      AND fld->>'name' = 'project'
  ) THEN
    RAISE EXCEPTION 'restore failed: project lookup c7771238-... is missing from our_projects.schema';
  END IF;
END $guard$;

COMMIT;
