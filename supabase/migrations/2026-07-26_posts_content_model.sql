-- Posts Content writer — the `posts_content` model.
--
-- One record = ONE generated marketing post for ONE project, from ONE of the
-- 15 angles in src/lib/postsContent/templates.ts. A generation run writes 15
-- records sharing a `batch_id`; approving/unapproving flips `status` between
-- 'draft' and 'approved' (a post the user rejects gets 'rejected').
--
-- Created via SQL rather than seedModels.ts on purpose: the lookup here must
-- point at the LIVE all_projects model id. Seeding regenerates lookup target
-- ids per load, which has silently broken lookups in this repo before
-- (see the "Seed-backfill writes broken lookups" note).
--
-- Idempotent: fixed uuids + ON CONFLICT DO UPDATE, so re-running refreshes the
-- schema without orphaning existing post records.

BEGIN;

INSERT INTO public.models (id, name, label_ar, label_en, icon, color, "order", is_system, group_id, card_config, schema)
VALUES (
  '9051c0d7-1a2b-4c3d-8e4f-000000000000',
  'posts_content',
  'منشورات المشاريع',
  'Posts Content',
  'megaphone',
  '#B8734F',
  60,
  true,
  NULL,
  jsonb_build_object(
    'title_field_id', '9051c0d7-1a2b-4c3d-8e4f-000000000010',
    'subtitle_field_id', '9051c0d7-1a2b-4c3d-8e4f-000000000011',
    'badge_field_id', '9051c0d7-1a2b-4c3d-8e4f-000000000014',
    'shown_field_ids', jsonb_build_array('9051c0d7-1a2b-4c3d-8e4f-000000000012')
  ),
  jsonb_build_object(
    'section_selector_field_id', NULL,
    'sections', jsonb_build_array(
      -- ── 1. Post info ────────────────────────────────────────────────
      jsonb_build_object(
        'id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
        'label_ar', 'معلومات المنشور', 'label_en', 'Post Info',
        'order', 0, 'is_base', true, 'color', '#B8734F',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000010', 'name', 'title',
            'label_ar', 'العنوان', 'label_en', 'Headline',
            'type', 'text', 'required', true, 'order', 0,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
            'width', 'full', 'show_in_table', true
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000011', 'name', 'project',
            'label_ar', 'المشروع', 'label_en', 'Project',
            'type', 'lookup', 'required', false, 'order', 1,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
            'width', 'half', 'show_in_table', true,
            'lookup_model_id', '220c49b9-de57-492d-9eca-c0d9f54fd40f',
            'lookup_display_field', 'project_name',
            'is_multi', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000012', 'name', 'angle',
            'label_ar', 'الزاوية التسويقية', 'label_en', 'Marketing Angle',
            'type', 'dropdown', 'required', false, 'order', 2,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
            'width', 'half', 'show_in_table', true,
            'options', jsonb_build_array(
              jsonb_build_object('id','a01','value','luxury','label_ar','الفخامة والرقي','label_en','Luxury','color','#B8734F'),
              jsonb_build_object('id','a02','value','view_height','label_ar','الإطلالة والارتفاع','label_en','View & Height','color','#C09B5F'),
              jsonb_build_object('id','a03','value','independence','label_ar','الاستقلالية العائلية','label_en','Independence','color','#8E4E3A'),
              jsonb_build_object('id','a04','value','family_stability','label_ar','الاستقرار العائلي','label_en','Family Stability','color','#4A2C2A'),
              jsonb_build_object('id','a05','value','compound_security','label_ar','الأمان والمجتمع المغلق','label_en','Security & Compound','color','#B8734F'),
              jsonb_build_object('id','a06','value','nature_privacy','label_ar','الطبيعة والخصوصية','label_en','Nature & Privacy','color','#C09B5F'),
              jsonb_build_object('id','a07','value','smart_home','label_ar','المنزل الذكي','label_en','Smart Home','color','#8E4E3A'),
              jsonb_build_object('id','a08','value','corner_space','label_ar','الموقع المميز والمساحة','label_en','Corner & Space','color','#4A2C2A'),
              jsonb_build_object('id','a09','value','smart_start','label_ar','الانطلاقة الذكية','label_en','Smart Start','color','#B8734F'),
              jsonb_build_object('id','a10','value','prestige','label_ar','الهيبة والثبات','label_en','Prestige','color','#C09B5F'),
              jsonb_build_object('id','a11','value','value_balance','label_ar','التوازن والقيمة','label_en','Value & Balance','color','#8E4E3A'),
              jsonb_build_object('id','a12','value','off_plan','label_ar','البيع على الخارطة','label_en','Off-Plan','color','#4A2C2A'),
              jsonb_build_object('id','a13','value','quality_warranty','label_ar','الجودة والضمانات','label_en','Quality & Warranty','color','#B8734F'),
              jsonb_build_object('id','a14','value','location_access','label_ar','الموقع وسهولة الوصول','label_en','Location & Access','color','#C09B5F'),
              jsonb_build_object('id','a15','value','facade_light','label_ar','الواجهات والإضاءة','label_en','Facade & Light','color','#8E4E3A')
            )
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000013', 'name', 'tone',
            'label_ar', 'الأسلوب', 'label_en', 'Tone',
            'type', 'dropdown', 'required', false, 'order', 3,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
            'width', 'half', 'show_in_table', true,
            'options', jsonb_build_array(
              jsonb_build_object('id','t1','value','short','label_ar','مختصر (سوشال)','label_en','Short (social)','color','#C09B5F'),
              jsonb_build_object('id','t2','value','long','label_ar','موسّع (رسمي)','label_en','Long (formal)','color','#4A2C2A')
            )
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000014', 'name', 'status',
            'label_ar', 'الحالة', 'label_en', 'Status',
            'type', 'dropdown', 'required', false, 'order', 4,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
            'width', 'half', 'show_in_table', true,
            'options', jsonb_build_array(
              jsonb_build_object('id','s1','value','draft','label_ar','مسودة','label_en','Draft','color','#9CA3AF'),
              jsonb_build_object('id','s2','value','approved','label_ar','معتمد','label_en','Approved','color','#22C55E'),
              jsonb_build_object('id','s3','value','rejected','label_ar','مرفوض','label_en','Rejected','color','#EF4444')
            )
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000015', 'name', 'post_number',
            'label_ar', 'رقم المنشور', 'label_en', 'Post No.',
            'type', 'number', 'required', false, 'order', 5,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000001',
            'width', 'half', 'show_in_table', true
          )
        )
      ),
      -- ── 2. Arabic content ───────────────────────────────────────────
      jsonb_build_object(
        'id', '9051c0d7-1a2b-4c3d-8e4f-000000000002',
        'label_ar', 'المحتوى العربي', 'label_en', 'Arabic Content',
        'order', 1, 'is_base', true, 'color', '#8E4E3A',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000020', 'name', 'body_ar',
            'label_ar', 'نص المنشور', 'label_en', 'Post Body',
            'type', 'textarea', 'required', false, 'order', 0,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000002',
            'width', 'full', 'show_in_table', false
          )
        )
      ),
      -- ── 3. English content ──────────────────────────────────────────
      jsonb_build_object(
        'id', '9051c0d7-1a2b-4c3d-8e4f-000000000003',
        'label_ar', 'المحتوى الإنجليزي', 'label_en', 'English Content',
        'order', 2, 'is_base', true, 'color', '#C09B5F',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000030', 'name', 'title_en',
            'label_ar', 'العنوان (إنجليزي)', 'label_en', 'Headline (EN)',
            'type', 'text', 'required', false, 'order', 0,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000003',
            'width', 'full', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000031', 'name', 'body_en',
            'label_ar', 'نص المنشور (إنجليزي)', 'label_en', 'Post Body (EN)',
            'type', 'textarea', 'required', false, 'order', 1,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000003',
            'width', 'full', 'show_in_table', false
          )
        )
      ),
      -- ── 4. Tracking ─────────────────────────────────────────────────
      jsonb_build_object(
        'id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
        'label_ar', 'التتبع', 'label_en', 'Tracking',
        'order', 3, 'is_base', true, 'color', '#4A2C2A',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000040', 'name', 'grounded',
            'label_ar', 'مدعوم ببيانات المشروع', 'label_en', 'Backed by project data',
            'type', 'checkbox', 'required', false, 'order', 0,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', true
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000041', 'name', 'evidence',
            'label_ar', 'الأدلة من بيانات المشروع', 'label_en', 'Supporting evidence',
            'type', 'text', 'required', false, 'order', 1,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000042', 'name', 'batch_id',
            'label_ar', 'معرف الدفعة', 'label_en', 'Batch ID',
            'type', 'text', 'required', false, 'order', 2,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000043', 'name', 'source_project_id',
            'label_ar', 'معرف مشروعنا المصدر', 'label_en', 'Source Our-Project ID',
            'type', 'text', 'required', false, 'order', 3,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000044', 'name', 'generated_at',
            'label_ar', 'تاريخ التوليد', 'label_en', 'Generated At',
            'type', 'datetime', 'required', false, 'order', 4,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', true
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000045', 'name', 'approved_at',
            'label_ar', 'تاريخ الاعتماد', 'label_en', 'Approved At',
            'type', 'datetime', 'required', false, 'order', 5,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000046', 'name', 'generated_by',
            'label_ar', 'النموذج المولِّد', 'label_en', 'Generated By',
            'type', 'text', 'required', false, 'order', 6,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'half', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', '9051c0d7-1a2b-4c3d-8e4f-000000000047', 'name', 'notes',
            'label_ar', 'ملاحظات', 'label_en', 'Notes',
            'type', 'textarea', 'required', false, 'order', 7,
            'section_id', '9051c0d7-1a2b-4c3d-8e4f-000000000004',
            'width', 'full', 'show_in_table', false
          )
        )
      )
    )
  )
)
ON CONFLICT (id) DO UPDATE
SET label_ar = EXCLUDED.label_ar,
    label_en = EXCLUDED.label_en,
    icon = EXCLUDED.icon,
    color = EXCLUDED.color,
    card_config = EXCLUDED.card_config,
    schema = EXCLUDED.schema,
    updated_at = now();

COMMIT;
