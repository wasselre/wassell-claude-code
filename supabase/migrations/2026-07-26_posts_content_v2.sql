-- Posts Content writer — v2 schema (supersedes 2026-07-26_posts_content_model.sql).
--
-- Changes vs v1:
--   * `title`/`title_en` → `headline_ar`/`headline_en` (explicit per the spec).
--   * Split content: prose_* (model-written) and spec_* (rendered from the DB)
--     are stored alongside body_* (the pasteable headline+prose+spec).
--   * Added `language`, `used_fact_ids`, full approve/reject provenance
--     (approved_by / rejected_at / rejected_by / rejection_reason /
--     rejection_feedback), `edited_at`, and a `batch` lookup.
--   * NEW `posts_batches` model holding one row per generation run.
--
-- Safe to run: verified 0 records existed on posts_content at the time of
-- writing, so the slug renames cannot orphan data. Idempotent — fixed uuids +
-- ON CONFLICT DO UPDATE.
--
-- Derived-vs-stored on posts_batches: `requested_count` and `failed_count` are
-- STORED because they cannot be recovered from the post rows (a post that
-- failed to generate has no row). Completed / approved / rejected counts are
-- DERIVED from posts_content at read time — storing them would be a second
-- source of truth that drifts the moment someone approves a post from the
-- record list instead of the writer page.

BEGIN;

-- ── posts_batches ──────────────────────────────────────────────────────────
INSERT INTO public.models (id, name, label_ar, label_en, icon, color, "order", is_system, group_id, card_config, schema)
VALUES (
  '9051c0d7-1a2b-4c3d-8e4f-000000000100',
  'posts_batches',
  'دفعات المنشورات',
  'Post Batches',
  'layers',
  '#8E4E3A',
  61,
  true,
  NULL,
  '{"title_field_id":"9051c0d7-1a2b-4c3d-8e4f-000000000110","subtitle_field_id":null,"badge_field_id":"9051c0d7-1a2b-4c3d-8e4f-000000000111","shown_field_ids":[]}'::jsonb,
  '{
    "section_selector_field_id": null,
    "sections": [{
      "id": "9051c0d7-1a2b-4c3d-8e4f-000000000101",
      "label_ar": "الدفعة", "label_en": "Batch",
      "order": 0, "is_base": true, "color": "#8E4E3A",
      "fields": [
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000110","name":"label","label_ar":"الدفعة","label_en":"Batch","type":"text","required":true,"order":0,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"full","show_in_table":true},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000111","name":"status","label_ar":"الحالة","label_en":"Status","type":"dropdown","required":false,"order":1,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true,"options":[
          {"id":"b1","value":"running","label_ar":"قيد التوليد","label_en":"Running","color":"#3B82F6"},
          {"id":"b2","value":"completed","label_ar":"مكتملة","label_en":"Completed","color":"#22C55E"},
          {"id":"b3","value":"partial","label_ar":"مكتملة جزئياً","label_en":"Partial","color":"#F59E0B"},
          {"id":"b4","value":"failed","label_ar":"فاشلة","label_en":"Failed","color":"#EF4444"}]},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000112","name":"language","label_ar":"اللغة","label_en":"Language","type":"dropdown","required":false,"order":2,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true,"options":[
          {"id":"l1","value":"ar","label_ar":"العربية","label_en":"Arabic","color":"#B8734F"},
          {"id":"l2","value":"en","label_ar":"الإنجليزية","label_en":"English","color":"#C09B5F"},
          {"id":"l3","value":"both","label_ar":"العربية والإنجليزية","label_en":"Arabic & English","color":"#8E4E3A"}]},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000113","name":"tone","label_ar":"الأسلوب","label_en":"Tone","type":"dropdown","required":false,"order":3,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true,"options":[
          {"id":"t1","value":"short","label_ar":"مختصر (سوشال)","label_en":"Short (social)","color":"#C09B5F"},
          {"id":"t2","value":"long","label_ar":"موسّع (رسمي)","label_en":"Long (formal)","color":"#4A2C2A"}]},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000114","name":"quantity_mode","label_ar":"نمط العدد","label_en":"Quantity Mode","type":"dropdown","required":false,"order":4,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":false,"options":[
          {"id":"q1","value":"total","label_ar":"إجمالي موزّع","label_en":"Total distributed","color":"#B8734F"},
          {"id":"q2","value":"per_project","label_ar":"لكل مشروع","label_en":"Per project","color":"#C09B5F"}]},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000115","name":"requested_count","label_ar":"العدد المطلوب","label_en":"Requested","type":"number","required":false,"order":5,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000116","name":"failed_count","label_ar":"عدد الإخفاقات","label_en":"Failed","type":"number","required":false,"order":6,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000117","name":"projects","label_ar":"المشاريع","label_en":"Projects","type":"lookup","required":false,"order":7,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"full","show_in_table":true,"lookup_model_id":"220c49b9-de57-492d-9eca-c0d9f54fd40f","lookup_display_field":"project_name","is_multi":true},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000118","name":"source_project_ids","label_ar":"معرفات مشاريعنا","label_en":"Our-Project IDs","type":"textarea","required":false,"order":8,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"full","show_in_table":false},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000119","name":"per_project_counts","label_ar":"العدد لكل مشروع","label_en":"Per-project counts","type":"textarea","required":false,"order":9,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"full","show_in_table":false},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000011a","name":"generated_by","label_ar":"أنشأها","label_en":"Generated By","type":"text","required":false,"order":10,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000011b","name":"generated_at","label_ar":"تاريخ الإنشاء","label_en":"Generated At","type":"datetime","required":false,"order":11,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"half","show_in_table":true},
        {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000011c","name":"notes","label_ar":"ملاحظات","label_en":"Notes","type":"textarea","required":false,"order":12,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000101","width":"full","show_in_table":false}
      ]
    }]
  }'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, icon = EXCLUDED.icon,
    color = EXCLUDED.color, card_config = EXCLUDED.card_config, schema = EXCLUDED.schema,
    updated_at = now();

-- ── posts_content (reshaped) ───────────────────────────────────────────────
UPDATE public.models
SET card_config = '{"title_field_id":"9051c0d7-1a2b-4c3d-8e4f-000000000010","subtitle_field_id":"9051c0d7-1a2b-4c3d-8e4f-000000000011","badge_field_id":"9051c0d7-1a2b-4c3d-8e4f-000000000014","shown_field_ids":["9051c0d7-1a2b-4c3d-8e4f-000000000012"]}'::jsonb,
    schema = '{
      "section_selector_field_id": null,
      "sections": [
        {
          "id": "9051c0d7-1a2b-4c3d-8e4f-000000000001",
          "label_ar": "معلومات المنشور", "label_en": "Post Info",
          "order": 0, "is_base": true, "color": "#B8734F",
          "fields": [
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000010","name":"headline_ar","label_ar":"العنوان","label_en":"Headline","type":"text","required":true,"order":0,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"full","show_in_table":true},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000011","name":"project","label_ar":"المشروع","label_en":"Project","type":"lookup","required":false,"order":1,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":true,"lookup_model_id":"220c49b9-de57-492d-9eca-c0d9f54fd40f","lookup_display_field":"project_name","is_multi":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000012","name":"angle","label_ar":"الزاوية التسويقية","label_en":"Marketing Angle","type":"dropdown","required":false,"order":2,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":true,"options":[
              {"id":"a01","value":"luxury","label_ar":"الفخامة والرقي","label_en":"Luxury","color":"#B8734F"},
              {"id":"a02","value":"view_height","label_ar":"الإطلالة والارتفاع","label_en":"View & Height","color":"#C09B5F"},
              {"id":"a03","value":"independence","label_ar":"الاستقلالية العائلية","label_en":"Independence","color":"#8E4E3A"},
              {"id":"a04","value":"family_stability","label_ar":"الاستقرار العائلي","label_en":"Family Stability","color":"#4A2C2A"},
              {"id":"a05","value":"compound_security","label_ar":"الأمان والمجتمع المغلق","label_en":"Security & Compound","color":"#B8734F"},
              {"id":"a06","value":"nature_privacy","label_ar":"الطبيعة والخصوصية","label_en":"Nature & Privacy","color":"#C09B5F"},
              {"id":"a07","value":"smart_home","label_ar":"المنزل الذكي","label_en":"Smart Home","color":"#8E4E3A"},
              {"id":"a08","value":"corner_space","label_ar":"الموقع المميز والمساحة","label_en":"Corner & Space","color":"#4A2C2A"},
              {"id":"a09","value":"smart_start","label_ar":"الانطلاقة الذكية","label_en":"Smart Start","color":"#B8734F"},
              {"id":"a10","value":"prestige","label_ar":"الهيبة والثبات","label_en":"Prestige","color":"#C09B5F"},
              {"id":"a11","value":"value_balance","label_ar":"التوازن والقيمة","label_en":"Value & Balance","color":"#8E4E3A"},
              {"id":"a12","value":"off_plan","label_ar":"البيع على الخارطة","label_en":"Off-Plan","color":"#4A2C2A"},
              {"id":"a13","value":"quality_warranty","label_ar":"الجودة والضمانات","label_en":"Quality & Warranty","color":"#B8734F"},
              {"id":"a14","value":"location_access","label_ar":"الموقع وسهولة الوصول","label_en":"Location & Access","color":"#C09B5F"},
              {"id":"a15","value":"facade_light","label_ar":"الواجهات والإضاءة","label_en":"Facade & Light","color":"#8E4E3A"}]},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000013","name":"tone","label_ar":"الأسلوب","label_en":"Tone","type":"dropdown","required":false,"order":3,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":true,"options":[
              {"id":"t1","value":"short","label_ar":"مختصر (سوشال)","label_en":"Short (social)","color":"#C09B5F"},
              {"id":"t2","value":"long","label_ar":"موسّع (رسمي)","label_en":"Long (formal)","color":"#4A2C2A"}]},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000016","name":"language","label_ar":"اللغة","label_en":"Language","type":"dropdown","required":false,"order":4,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":true,"options":[
              {"id":"l1","value":"ar","label_ar":"العربية","label_en":"Arabic","color":"#B8734F"},
              {"id":"l2","value":"en","label_ar":"الإنجليزية","label_en":"English","color":"#C09B5F"},
              {"id":"l3","value":"both","label_ar":"العربية والإنجليزية","label_en":"Arabic & English","color":"#8E4E3A"}]},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000014","name":"status","label_ar":"الحالة","label_en":"Status","type":"dropdown","required":false,"order":5,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":true,"options":[
              {"id":"s1","value":"draft","label_ar":"مسودة","label_en":"Draft","color":"#9CA3AF"},
              {"id":"s2","value":"approved","label_ar":"معتمد","label_en":"Approved","color":"#22C55E"},
              {"id":"s3","value":"rejected","label_ar":"مرفوض","label_en":"Rejected","color":"#EF4444"}]},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000015","name":"post_number","label_ar":"رقم المنشور","label_en":"Post No.","type":"number","required":false,"order":6,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":true},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000017","name":"batch","label_ar":"الدفعة","label_en":"Batch","type":"lookup","required":false,"order":7,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000001","width":"half","show_in_table":false,"lookup_model_id":"9051c0d7-1a2b-4c3d-8e4f-000000000100","lookup_display_field":"label","is_multi":false}
          ]
        },
        {
          "id": "9051c0d7-1a2b-4c3d-8e4f-000000000002",
          "label_ar": "المحتوى العربي", "label_en": "Arabic Content",
          "order": 1, "is_base": true, "color": "#8E4E3A",
          "fields": [
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000020","name":"body_ar","label_ar":"نص المنشور الكامل","label_en":"Full Post Body","type":"textarea","required":false,"order":0,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000002","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000022","name":"prose_ar","label_ar":"النص التسويقي","label_en":"Marketing Prose","type":"textarea","required":false,"order":1,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000002","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000021","name":"spec_ar","label_ar":"بيانات العقار","label_en":"Specification Block","type":"textarea","required":false,"order":2,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000002","width":"full","show_in_table":false}
          ]
        },
        {
          "id": "9051c0d7-1a2b-4c3d-8e4f-000000000003",
          "label_ar": "المحتوى الإنجليزي", "label_en": "English Content",
          "order": 2, "is_base": true, "color": "#C09B5F",
          "fields": [
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000030","name":"headline_en","label_ar":"العنوان (إنجليزي)","label_en":"Headline (EN)","type":"text","required":false,"order":0,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000003","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000031","name":"body_en","label_ar":"نص المنشور الكامل (إنجليزي)","label_en":"Full Post Body (EN)","type":"textarea","required":false,"order":1,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000003","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000033","name":"prose_en","label_ar":"النص التسويقي (إنجليزي)","label_en":"Marketing Prose (EN)","type":"textarea","required":false,"order":2,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000003","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000032","name":"spec_en","label_ar":"بيانات العقار (إنجليزي)","label_en":"Specification Block (EN)","type":"textarea","required":false,"order":3,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000003","width":"full","show_in_table":false}
          ]
        },
        {
          "id": "9051c0d7-1a2b-4c3d-8e4f-000000000004",
          "label_ar": "التتبع والمراجعة", "label_en": "Tracking & Review",
          "order": 3, "is_base": true, "color": "#4A2C2A",
          "fields": [
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000040","name":"grounded","label_ar":"مدعوم ببيانات المشروع","label_en":"Backed by project data","type":"checkbox","required":false,"order":0,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":true},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000041","name":"evidence","label_ar":"الأدلة من بيانات المشروع","label_en":"Supporting evidence","type":"text","required":false,"order":1,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000048","name":"used_fact_ids","label_ar":"معرفات الحقائق المستخدمة","label_en":"Used fact IDs","type":"textarea","required":false,"order":2,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000042","name":"batch_id","label_ar":"معرف الدفعة","label_en":"Batch ID","type":"text","required":false,"order":3,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000043","name":"source_project_id","label_ar":"معرف مشروعنا المصدر","label_en":"Source Our-Project ID","type":"text","required":false,"order":4,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000044","name":"generated_at","label_ar":"تاريخ التوليد","label_en":"Generated At","type":"datetime","required":false,"order":5,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":true},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000046","name":"generated_by","label_ar":"النموذج المولِّد","label_en":"Generated By","type":"text","required":false,"order":6,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000045","name":"approved_at","label_ar":"تاريخ الاعتماد","label_en":"Approved At","type":"datetime","required":false,"order":7,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000049","name":"approved_by","label_ar":"اعتمدها","label_en":"Approved By","type":"text","required":false,"order":8,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000004a","name":"rejected_at","label_ar":"تاريخ الرفض","label_en":"Rejected At","type":"datetime","required":false,"order":9,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000004b","name":"rejected_by","label_ar":"رفضها","label_en":"Rejected By","type":"text","required":false,"order":10,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000004c","name":"rejection_reason","label_ar":"سبب الرفض","label_en":"Rejection Reason","type":"dropdown","required":false,"order":11,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":true,"options":[
              {"id":"r1","value":"incorrect_facts","label_ar":"معلومات غير صحيحة","label_en":"Incorrect facts","color":"#EF4444"},
              {"id":"r2","value":"weak_headline","label_ar":"عنوان ضعيف","label_en":"Weak headline","color":"#F59E0B"},
              {"id":"r3","value":"repetitive","label_ar":"تكرار في الصياغة","label_en":"Repetitive wording","color":"#F59E0B"},
              {"id":"r4","value":"wrong_angle","label_ar":"زاوية تسويقية خاطئة","label_en":"Wrong marketing angle","color":"#F59E0B"},
              {"id":"r5","value":"too_formal","label_ar":"رسمي أكثر من اللازم","label_en":"Too formal","color":"#C09B5F"},
              {"id":"r6","value":"too_casual","label_ar":"غير رسمي بما يكفي","label_en":"Too casual","color":"#C09B5F"},
              {"id":"r7","value":"too_long","label_ar":"طويل","label_en":"Too long","color":"#C09B5F"},
              {"id":"r8","value":"too_short","label_ar":"قصير","label_en":"Too short","color":"#C09B5F"},
              {"id":"r9","value":"other","label_ar":"أخرى","label_en":"Other","color":"#9CA3AF"}]},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000004d","name":"rejection_feedback","label_ar":"ملاحظات الرفض","label_en":"Rejection Feedback","type":"textarea","required":false,"order":12,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"full","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-00000000004e","name":"edited_at","label_ar":"آخر تعديل","label_en":"Last Edited","type":"datetime","required":false,"order":13,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"half","show_in_table":false},
            {"id":"9051c0d7-1a2b-4c3d-8e4f-000000000047","name":"notes","label_ar":"ملاحظات","label_en":"Notes","type":"textarea","required":false,"order":14,"section_id":"9051c0d7-1a2b-4c3d-8e4f-000000000004","width":"full","show_in_table":false}
          ]
        }
      ]
    }'::jsonb,
    label_ar = 'منشورات المحتوى',
    label_en = 'Posts Content',
    updated_at = now()
WHERE id = '9051c0d7-1a2b-4c3d-8e4f-000000000000';

COMMIT;
