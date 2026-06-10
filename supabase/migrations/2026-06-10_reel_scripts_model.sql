-- 2026-06-10: Create the "Reels" model (slug `reel_scripts`).
--
-- Backs the new reel-production module. The copywriter agent emits a structured
-- reel script (emit_reel_script tool) that the chat renders as a table with a
-- "Create Reel" button → a PREFILLED record of this model (project + script
-- table auto-filled) the user reviews and Saves.
--
-- Why this is created by explicit SQL and not left to the frontend seed-backfill:
--  • Seed model ids are uuid() generated per page-load, so the seed-backfill
--    writes a STALE all_projects id into prod (proven: live copywriter_chats
--    .linked_project_id points at 5229e15f-… which is NOT the live all_projects
--    220c49b9-…). The `project` lookup MUST target the real live all_projects id.
--  • Slug is `reel_scripts`, NOT `reels` — `reels` is in RETIRED_SYSTEM_MODEL_NAMES
--    and would be hard-deleted on load. The user-facing label is "Reels".
--
-- Unfrozen model: rows live as JSONB in `records`; reads go through the
-- `unified_records` view automatically. The `models_view_sync` trigger creates
-- the `v_reel_scripts` typed view on insert. No freeze artifacts needed.
--
-- Idempotent: the WHERE NOT EXISTS guard makes re-runs a no-op. The model id is
-- the same stable constant as REEL_SCRIPTS_MODEL_ID in src/data/seedModels.ts.

WITH ids AS (
  SELECT
    '7c0ffee1-5cab-4b0a-9d3e-12ab34cd56ef'::uuid AS model_id,
    gen_random_uuid() AS sec_basic,
    gen_random_uuid() AS sec_brief,
    gen_random_uuid() AS sec_script,
    gen_random_uuid() AS sec_prod,
    gen_random_uuid() AS f_title,
    gen_random_uuid() AS f_project,
    gen_random_uuid() AS f_status,
    gen_random_uuid() AS f_reel_idea,
    gen_random_uuid() AS f_objective,
    gen_random_uuid() AS f_audience,
    gen_random_uuid() AS f_key_message,
    gen_random_uuid() AS f_hook,
    gen_random_uuid() AS f_angle,
    gen_random_uuid() AS f_script_table,
    gen_random_uuid() AS f_cta,
    gen_random_uuid() AS f_alt_hooks,
    gen_random_uuid() AS f_approval,
    gen_random_uuid() AS f_review,
    gen_random_uuid() AS f_prod_notes
)
INSERT INTO public.models (id, name, label_ar, label_en, icon, color, schema, card_config, maps_config, group_id, "order", is_system, is_hardcoded)
SELECT
  model_id, 'reel_scripts', 'الريلز', 'Reels', 'clapperboard', '#B8734F',
  jsonb_build_object(
    'sections', jsonb_build_array(
      jsonb_build_object('id', sec_basic, 'label_ar','معلومات أساسية','label_en','Basic Information','order',0,'is_base',true,'color','#B8734F','fields', jsonb_build_array(
        jsonb_build_object('id',f_title,'name','title','label_ar','العنوان','label_en','Title','type','text','required',true,'order',0,'section_id',sec_basic,'width','half','show_in_table',true),
        jsonb_build_object('id',f_project,'name','project','label_ar','المشروع','label_en','Project','type','lookup','required',false,'order',1,'section_id',sec_basic,'width','half','show_in_table',true,'lookup_model_id','220c49b9-de57-492d-9eca-c0d9f54fd40f','lookup_display_field','project_name','is_multi',false),
        jsonb_build_object('id',f_status,'name','status','label_ar','الحالة','label_en','Status','type','dropdown','required',false,'order',2,'section_id',sec_basic,'width','half','show_in_table',true,'options', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid(),'label_ar','مسودة','label_en','Draft','value','draft','color','#9ca3af'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','كتابة السيناريو','label_en','Scripting','value','scripting','color','#3b82f6'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','قيد الإنتاج','label_en','In Production','value','in_production','color','#f59e0b'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','قيد المراجعة','label_en','In Review','value','in_review','color','#eab308'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','معتمد','label_en','Approved','value','approved','color','#22c55e'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','منشور','label_en','Published','value','published','color','#8b5cf6')
        ))
      )),
      jsonb_build_object('id', sec_brief, 'label_ar','الفكرة','label_en','Brief','order',1,'is_base',true,'color','#C09B5F','fields', jsonb_build_array(
        jsonb_build_object('id',f_reel_idea,'name','reel_idea','label_ar','فكرة الريل','label_en','Reel Idea','type','textarea','required',false,'order',0,'section_id',sec_brief,'width','full','show_in_table',false),
        jsonb_build_object('id',f_objective,'name','objective','label_ar','الهدف','label_en','Objective','type','text','required',false,'order',1,'section_id',sec_brief,'width','half','show_in_table',false),
        jsonb_build_object('id',f_audience,'name','target_audience','label_ar','الجمهور المستهدف','label_en','Target Audience','type','text','required',false,'order',2,'section_id',sec_brief,'width','half','show_in_table',false),
        jsonb_build_object('id',f_key_message,'name','key_message','label_ar','الرسالة الأساسية','label_en','Key Message','type','textarea','required',false,'order',3,'section_id',sec_brief,'width','full','show_in_table',false)
      )),
      jsonb_build_object('id', sec_script, 'label_ar','السيناريو','label_en','Script','order',2,'is_base',true,'color','#8E4E3A','fields', jsonb_build_array(
        jsonb_build_object('id',f_hook,'name','hook','label_ar','الخطّاف','label_en','Hook','type','textarea','required',false,'order',0,'section_id',sec_script,'width','full','show_in_table',false),
        jsonb_build_object('id',f_angle,'name','angle','label_ar','الزاوية / المحفّز','label_en','Angle / Trigger','type','text','required',false,'order',1,'section_id',sec_script,'width','full','show_in_table',false),
        jsonb_build_object('id',f_script_table,'name','script_table','label_ar','جدول السيناريو','label_en','Script Table','type','table','required',false,'order',2,'section_id',sec_script,'width','full','show_in_table',false,'table_columns', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid(),'name','scene','label_ar','المشهد','label_en','Scene','type','text','required',false),
          jsonb_build_object('id',gen_random_uuid(),'name','voiceover','label_ar','التعليق الصوتي','label_en','Voiceover','type','textarea','required',false),
          jsonb_build_object('id',gen_random_uuid(),'name','visual','label_ar','التوجيه البصري','label_en','Visual Direction','type','textarea','required',false),
          jsonb_build_object('id',gen_random_uuid(),'name','on_screen_text','label_ar','نص على الشاشة','label_en','On-Screen Text','type','textarea','required',false),
          jsonb_build_object('id',gen_random_uuid(),'name','notes','label_ar','ملاحظات','label_en','Notes','type','text','required',false)
        )),
        jsonb_build_object('id',f_cta,'name','cta','label_ar','الدعوة','label_en','CTA','type','textarea','required',false,'order',3,'section_id',sec_script,'width','full','show_in_table',false),
        jsonb_build_object('id',f_alt_hooks,'name','alt_hooks','label_ar','خطّافات بديلة','label_en','Alternative Hooks','type','textarea','required',false,'order',4,'section_id',sec_script,'width','full','show_in_table',false)
      )),
      jsonb_build_object('id', sec_prod, 'label_ar','الإنتاج','label_en','Production','order',3,'is_base',true,'color','#4A2C2A','fields', jsonb_build_array(
        jsonb_build_object('id',f_approval,'name','approval_status','label_ar','حالة الاعتماد','label_en','Approval Status','type','dropdown','required',false,'order',0,'section_id',sec_prod,'width','half','show_in_table',true,'options', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid(),'label_ar','معلّق','label_en','Pending','value','pending','color','#9ca3af'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','معتمد','label_en','Approved','value','approved','color','#22c55e'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','تعديلات مطلوبة','label_en','Changes Requested','value','changes_requested','color','#ef4444')
        )),
        jsonb_build_object('id',f_review,'name','review_comments','label_ar','ملاحظات المراجعة','label_en','Review Comments','type','notes','required',false,'order',1,'section_id',sec_prod,'width','full','show_in_table',false),
        jsonb_build_object('id',f_prod_notes,'name','production_notes','label_ar','ملاحظات الإنتاج','label_en','Production Notes','type','notes','required',false,'order',2,'section_id',sec_prod,'width','full','show_in_table',false)
      ))
    ),
    'section_selector_field_id', null
  ),
  jsonb_build_object('title_field_id', f_title, 'subtitle_field_id', null, 'badge_field_id', f_status, 'shown_field_ids', '[]'::jsonb),
  jsonb_build_object('click_action','popup','default_zoom',null,'map_style_json',null,'default_center_lat',null,'default_center_lng',null,'pin_color_field_id',null,'pin_label_field_id',null,'manual_lat_field_id',null,'manual_lng_field_id',null,'popup_badge_field_id',null,'popup_title_field_id',null,'location_url_field_id',null,'popup_shown_field_ids','[]'::jsonb,'popup_subtitle_field_id',null),
  NULL, 0, true, false
FROM ids
WHERE NOT EXISTS (SELECT 1 FROM public.models WHERE name = 'reel_scripts');
