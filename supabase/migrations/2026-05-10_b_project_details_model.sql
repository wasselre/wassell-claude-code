-- ============================================================================
-- Project Details model — content backing for the public website's
-- per-project detail page (project.html).
--
-- Each row is a 1:1 sidecar record for an all_projects row, holding the
-- editorial content the marketing page renders: hero copy, gallery images,
-- icon-tagged feature list, nearby landmarks, brochure PDF, lead agent, and
-- per-project block-visibility / variant knobs that let admins customize
-- each detail page without templates.
--
-- WHY a sidecar (not new fields on all_projects):
--   • Keeps the all_projects model focused on internal pipeline data
--   • Lets admins edit detail pages from a dedicated Settings entry without
--     opening the heavy all_projects record form
--   • Public-read RLS stays narrow — the sidecar table only contains
--     public-facing content, no internal fields
--
-- PUBLIC-READ RLS:
--   • anon can read project_details rows whose linked all_projects record
--     has is_public = true (parent gates child)
--   • anon can read the project_details model row itself (so the website
--     resolves the schema)
--
-- The Settings → "تفاصيل المشاريع" card and the bridge route
-- (/settings/project-details/:projectId) handle the admin UX of picking a
-- project and opening / creating its sidecar record.
-- ============================================================================

BEGIN;

-- ─── 1. Create project_details model + per-field IDs ─────────────────────────

DO $$
DECLARE
  v_model_id          uuid;
  v_group_id          uuid;
  v_section_id        text := gen_random_uuid()::text;
  v_proj_model_id     uuid;

  -- Field IDs (stable for re-runs only after first commit; idempotency
  -- check below short-circuits before regenerating).
  v_project_id           text := gen_random_uuid()::text;
  v_accent_color_id      text := gen_random_uuid()::text;
  v_hero_image_id        text := gen_random_uuid()::text;
  v_hero_short_id        text := gen_random_uuid()::text;
  v_description_id       text := gen_random_uuid()::text;
  v_gallery_1_id         text := gen_random_uuid()::text;
  v_gallery_2_id         text := gen_random_uuid()::text;
  v_gallery_3_id         text := gen_random_uuid()::text;
  v_gallery_4_id         text := gen_random_uuid()::text;
  v_gallery_5_id         text := gen_random_uuid()::text;
  v_gallery_6_id         text := gen_random_uuid()::text;
  v_gallery_7_id         text := gen_random_uuid()::text;
  v_gallery_8_id         text := gen_random_uuid()::text;
  v_features_id          text := gen_random_uuid()::text;
  v_landmarks_id         text := gen_random_uuid()::text;
  v_brochure_id          text := gen_random_uuid()::text;
  v_agent_name_id        text := gen_random_uuid()::text;
  v_agent_title_id       text := gen_random_uuid()::text;
  v_agent_phone_id       text := gen_random_uuid()::text;
  v_agent_whatsapp_id    text := gen_random_uuid()::text;
  v_agent_image_id       text := gen_random_uuid()::text;
  v_show_gallery_id      text := gen_random_uuid()::text;
  v_show_features_id     text := gen_random_uuid()::text;
  v_show_map_id          text := gen_random_uuid()::text;
  v_show_brochure_id     text := gen_random_uuid()::text;
  v_show_units_id        text := gen_random_uuid()::text;
  v_show_form_id         text := gen_random_uuid()::text;
  v_show_agent_id        text := gen_random_uuid()::text;

  -- Curated icon option list (stays in sync with the icon map in
  -- Wassel Website/js/project-icons.js — if you add an option here, add
  -- the matching SVG there too, or the website will render an empty pill).
  v_feature_icon_options jsonb;
  v_landmark_icon_options jsonb;
  v_accent_options       jsonb;

  -- Table column IDs (stable per cell — generated once below).
  v_feat_col_icon  text := gen_random_uuid()::text;
  v_feat_col_title text := gen_random_uuid()::text;
  v_feat_col_desc  text := gen_random_uuid()::text;
  v_lm_col_icon    text := gen_random_uuid()::text;
  v_lm_col_name    text := gen_random_uuid()::text;
  v_lm_col_dist    text := gen_random_uuid()::text;
BEGIN
  IF EXISTS (SELECT 1 FROM models WHERE name = 'project_details') THEN
    RAISE NOTICE 'project_details model already exists — skipping';
    RETURN;
  END IF;

  SELECT id INTO v_proj_model_id FROM models WHERE name = 'all_projects';
  IF v_proj_model_id IS NULL THEN
    RAISE EXCEPTION 'all_projects model missing — seed must run before project_details';
  END IF;

  -- Best-effort group lookup; NULL is fine if no Settings group exists.
  SELECT id INTO v_group_id FROM model_groups
  WHERE label_en = 'Settings' OR label_ar = 'الإعدادات' LIMIT 1;

  -- Build option lists
  v_feature_icon_options := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'building',     'label_ar', 'مبنى',           'label_en', 'Building'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'home',         'label_ar', 'منزل',           'label_en', 'Home'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'car',          'label_ar', 'سيارة / موقف',   'label_en', 'Car / Parking'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'smart_home',   'label_ar', 'منزل ذكي',       'label_en', 'Smart Home'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'ac',           'label_ar', 'تكييف',          'label_en', 'AC'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'camera',       'label_ar', 'كاميرا',         'label_en', 'Camera'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'key',          'label_ar', 'مفتاح / دخول',   'label_en', 'Key / Entry'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'facade',       'label_ar', 'واجهة',          'label_en', 'Facade'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'bed',          'label_ar', 'سرير / غرفة',    'label_en', 'Bed / Room'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'box',          'label_ar', 'مخزن',           'label_en', 'Storage'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'sparkle',      'label_ar', 'تشطيب فاخر',     'label_en', 'Premium Finish'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'elevator',     'label_ar', 'مصعد',           'label_en', 'Elevator'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'shield',       'label_ar', 'أمن',            'label_en', 'Security'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'wifi',         'label_ar', 'إنترنت',         'label_en', 'WiFi'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'pool',         'label_ar', 'مسبح',           'label_en', 'Pool'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'gym',          'label_ar', 'صالة رياضية',    'label_en', 'Gym')
  );

  v_landmark_icon_options := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'metro',     'label_ar', 'مترو',          'label_en', 'Metro'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'road',      'label_ar', 'طريق',          'label_en', 'Road / Highway'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'shop',      'label_ar', 'مول / تسوق',    'label_en', 'Mall / Shopping'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'school',    'label_ar', 'مدرسة',         'label_en', 'School'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'hospital',  'label_ar', 'مستشفى',        'label_en', 'Hospital'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'park',      'label_ar', 'حديقة',         'label_en', 'Park'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'mosque',    'label_ar', 'مسجد',          'label_en', 'Mosque'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'airport',   'label_ar', 'مطار',          'label_en', 'Airport'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'restaurant','label_ar', 'مطعم / كافيه',  'label_en', 'Restaurant'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'gas',       'label_ar', 'محطة وقود',     'label_en', 'Gas Station'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'pin',       'label_ar', 'موقع آخر',      'label_en', 'Other Location')
  );

  -- Accent palette — admin picks one; project.html applies to hero gradient,
  -- chip color, brochure card background, and CTA accents. Values are HSL
  -- tuples ready to drop into --primary; labels show the friendly name.
  v_accent_options := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'copper',     'label_ar', 'نحاسي (افتراضي)',    'label_en', 'Copper (Default)', 'color', '#B8734F'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'terracotta', 'label_ar', 'أرضي طيني',          'label_en', 'Terracotta',       'color', '#C4754A'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'sand',       'label_ar', 'رملي ذهبي',          'label_en', 'Golden Sand',      'color', '#C09B5F'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'olive',      'label_ar', 'زيتي',               'label_en', 'Olive',            'color', '#7A8C5C'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'deep_brown', 'label_ar', 'بني عميق',           'label_en', 'Deep Brown',       'color', '#6B4226'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value', 'sage',       'label_ar', 'مريمي',              'label_en', 'Sage',             'color', '#92A37A')
  );

  v_model_id := gen_random_uuid();

  INSERT INTO models (
    id, name, label_ar, label_en, icon, color, group_id,
    is_system, schema, maps_config, card_config, created_at, updated_at
  )
  VALUES (
    v_model_id,
    'project_details',
    'تفاصيل المشاريع',
    'Project Details',
    'layout-template',
    '#B8734F',
    v_group_id,
    true,
    jsonb_build_object(
      'sections', jsonb_build_array(jsonb_build_object(
        'id', v_section_id,
        'label_ar', 'تفاصيل المشروع',
        'label_en', 'Project Detail Page',
        'order', 0,
        'is_base', true,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          -- Identity (1:1 link to the all_projects record)
          jsonb_build_object(
            'id', v_project_id, 'name', 'project_id',
            'label_ar', 'المشروع', 'label_en', 'Project',
            'type', 'lookup', 'required', true, 'order', 0,
            'section_id', v_section_id, 'width', 'half', 'show_in_table', true,
            'lookup_model_id', v_proj_model_id::text,
            'lookup_display_field', 'project_name',
            'is_multi', false
          ),
          jsonb_build_object(
            'id', v_accent_color_id, 'name', 'accent_color',
            'label_ar', 'لون مميّز للصفحة', 'label_en', 'Page Accent Color',
            'type', 'dropdown', 'required', false, 'order', 1,
            'section_id', v_section_id, 'width', 'half', 'show_in_table', true,
            'options', v_accent_options
          ),

          -- Hero block
          jsonb_build_object(
            'id', v_hero_image_id, 'name', 'hero_image_url',
            'label_ar', 'صورة البطل', 'label_en', 'Hero Image',
            'type', 'image', 'required', false, 'order', 2,
            'section_id', v_section_id, 'width', 'half', 'show_in_table', false,
            'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp',
            'image_max_size_mb', 10
          ),
          jsonb_build_object(
            'id', v_hero_short_id, 'name', 'hero_short_description',
            'label_ar', 'وصف قصير تحت العنوان', 'label_en', 'Hero Short Description',
            'type', 'textarea', 'required', false, 'order', 3,
            'section_id', v_section_id, 'width', 'half', 'show_in_table', false
          ),

          -- About block
          jsonb_build_object(
            'id', v_description_id, 'name', 'description',
            'label_ar', 'الوصف الكامل (قسم "عن المشروع")', 'label_en', 'Full Description (About section)',
            'type', 'textarea', 'required', false, 'order', 4,
            'section_id', v_section_id, 'width', 'full', 'show_in_table', false
          ),

          -- Gallery — 8 image slots (empty slots are skipped on render).
          jsonb_build_object('id', v_gallery_1_id, 'name', 'gallery_image_1', 'label_ar', 'صورة المعرض 1', 'label_en', 'Gallery Image 1', 'type', 'image', 'required', false, 'order', 10, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_2_id, 'name', 'gallery_image_2', 'label_ar', 'صورة المعرض 2', 'label_en', 'Gallery Image 2', 'type', 'image', 'required', false, 'order', 11, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_3_id, 'name', 'gallery_image_3', 'label_ar', 'صورة المعرض 3', 'label_en', 'Gallery Image 3', 'type', 'image', 'required', false, 'order', 12, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_4_id, 'name', 'gallery_image_4', 'label_ar', 'صورة المعرض 4', 'label_en', 'Gallery Image 4', 'type', 'image', 'required', false, 'order', 13, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_5_id, 'name', 'gallery_image_5', 'label_ar', 'صورة المعرض 5', 'label_en', 'Gallery Image 5', 'type', 'image', 'required', false, 'order', 14, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_6_id, 'name', 'gallery_image_6', 'label_ar', 'صورة المعرض 6', 'label_en', 'Gallery Image 6', 'type', 'image', 'required', false, 'order', 15, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_7_id, 'name', 'gallery_image_7', 'label_ar', 'صورة المعرض 7', 'label_en', 'Gallery Image 7', 'type', 'image', 'required', false, 'order', 16, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),
          jsonb_build_object('id', v_gallery_8_id, 'name', 'gallery_image_8', 'label_ar', 'صورة المعرض 8', 'label_en', 'Gallery Image 8', 'type', 'image', 'required', false, 'order', 17, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 10),

          -- Features (table — repeating rows of icon + title + description)
          jsonb_build_object(
            'id', v_features_id, 'name', 'features',
            'label_ar', 'المميزات (الأيقونات)', 'label_en', 'Features (Icon Grid)',
            'type', 'table', 'required', false, 'order', 20,
            'section_id', v_section_id, 'width', 'full', 'show_in_table', false,
            'table_max_rows', 12,
            'table_columns', jsonb_build_array(
              jsonb_build_object('id', v_feat_col_icon,  'name', 'icon',        'label_ar', 'الأيقونة',  'label_en', 'Icon',        'type', 'dropdown', 'required', true,  'options', v_feature_icon_options),
              jsonb_build_object('id', v_feat_col_title, 'name', 'title',       'label_ar', 'العنوان',   'label_en', 'Title',       'type', 'text',     'required', true),
              jsonb_build_object('id', v_feat_col_desc,  'name', 'description', 'label_ar', 'وصف قصير',  'label_en', 'Short Description', 'type', 'text', 'required', false)
            )
          ),

          -- Nearby landmarks (table)
          jsonb_build_object(
            'id', v_landmarks_id, 'name', 'landmarks',
            'label_ar', 'المعالم القريبة', 'label_en', 'Nearby Landmarks',
            'type', 'table', 'required', false, 'order', 21,
            'section_id', v_section_id, 'width', 'full', 'show_in_table', false,
            'table_max_rows', 10,
            'table_columns', jsonb_build_array(
              jsonb_build_object('id', v_lm_col_icon, 'name', 'icon',     'label_ar', 'الأيقونة',  'label_en', 'Icon',     'type', 'dropdown', 'required', true, 'options', v_landmark_icon_options),
              jsonb_build_object('id', v_lm_col_name, 'name', 'name',     'label_ar', 'الاسم',     'label_en', 'Name',     'type', 'text',     'required', true),
              jsonb_build_object('id', v_lm_col_dist, 'name', 'distance', 'label_ar', 'المسافة',   'label_en', 'Distance', 'type', 'text',     'required', false)
            )
          ),

          -- Brochure
          jsonb_build_object(
            'id', v_brochure_id, 'name', 'brochure_pdf_url',
            'label_ar', 'رابط ملف الكتيب (PDF)', 'label_en', 'Brochure PDF URL',
            'type', 'url', 'required', false, 'order', 30,
            'section_id', v_section_id, 'width', 'full', 'show_in_table', false
          ),

          -- Agent
          jsonb_build_object('id', v_agent_name_id,     'name', 'agent_name',      'label_ar', 'اسم مستشار المبيعات', 'label_en', 'Agent Name',     'type', 'text',  'required', false, 'order', 40, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_agent_title_id,    'name', 'agent_title',     'label_ar', 'المسمى الوظيفي',      'label_en', 'Agent Title',    'type', 'text',  'required', false, 'order', 41, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_agent_phone_id,    'name', 'agent_phone',     'label_ar', 'رقم الجوال',          'label_en', 'Agent Phone',    'type', 'phone', 'required', false, 'order', 42, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_agent_whatsapp_id, 'name', 'agent_whatsapp',  'label_ar', 'رقم الواتساب',         'label_en', 'Agent WhatsApp', 'type', 'phone', 'required', false, 'order', 43, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_agent_image_id,    'name', 'agent_image_url', 'label_ar', 'صورة المستشار',        'label_en', 'Agent Photo',    'type', 'image', 'required', false, 'order', 44, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false, 'image_folder', 'reference', 'image_accept', 'image/png,image/jpeg,image/webp', 'image_max_size_mb', 5),

          -- Block visibility toggles (default true on the website if missing)
          jsonb_build_object('id', v_show_gallery_id,  'name', 'show_gallery',   'label_ar', 'عرض المعرض',                 'label_en', 'Show Gallery',         'type', 'checkbox', 'required', false, 'order', 50, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_show_features_id, 'name', 'show_features',  'label_ar', 'عرض المميزات',               'label_en', 'Show Features',        'type', 'checkbox', 'required', false, 'order', 51, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_show_map_id,      'name', 'show_map',       'label_ar', 'عرض الخريطة والمعالم',       'label_en', 'Show Map + Landmarks', 'type', 'checkbox', 'required', false, 'order', 52, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_show_brochure_id, 'name', 'show_brochure',  'label_ar', 'عرض بطاقة الكتيب',           'label_en', 'Show Brochure Card',   'type', 'checkbox', 'required', false, 'order', 53, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_show_units_id,    'name', 'show_units',     'label_ar', 'عرض قسم الوحدات (قريباً)',    'label_en', 'Show Units Block',     'type', 'checkbox', 'required', false, 'order', 54, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_show_form_id,     'name', 'show_form',      'label_ar', 'عرض نموذج تسجيل الاهتمام',   'label_en', 'Show Interest Form',   'type', 'checkbox', 'required', false, 'order', 55, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_show_agent_id,    'name', 'show_agent',     'label_ar', 'عرض بطاقة مستشار المبيعات',  'label_en', 'Show Agent Card',      'type', 'checkbox', 'required', false, 'order', 56, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false)
        )
      )),
      'section_selector_field_id', null
    ),
    -- Maps config not used for this model (it's website content, not a pin source)
    jsonb_build_object(
      'location_url_field_id', null,
      'click_action', 'popup',
      'popup_title_field_id', null,
      'popup_subtitle_field_id', null,
      'popup_badge_field_id', null,
      'popup_shown_field_ids', '[]'::jsonb
    ),
    -- Card config — for the rare case admin opens the model list view
    jsonb_build_object(
      'title_field_id', v_project_id,
      'subtitle_field_id', v_hero_short_id,
      'badge_field_id', v_accent_color_id,
      'shown_field_ids', '[]'::jsonb
    ),
    NOW(),
    NOW()
  );
END $$;

-- ─── 2. Public-read RLS — open project_details to anon, gated by parent ─────
--
-- Replace the records_public_website_read policy to also expose project_details
-- rows whose linked all_projects record is public. The model row itself goes
-- in the models_public_website_read whitelist below.

DROP POLICY IF EXISTS "records_public_website_read" ON public.records;
CREATE POLICY "records_public_website_read"
  ON public.records FOR SELECT TO anon
  USING (
    -- site_settings: always readable (singleton config)
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
    OR
    -- all_projects: opt-in via is_public checkbox
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND COALESCE((data->>'is_public')::boolean, false) = true
    )
    OR
    -- project_details: visible only when parent project is public
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'project_details')
      AND EXISTS (
        SELECT 1 FROM public.records p
        WHERE p.model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
          AND p.id::text = (records.data->>'project_id')
          AND COALESCE((p.data->>'is_public')::boolean, false) = true
      )
    )
  );

DROP POLICY IF EXISTS "models_public_website_read" ON public.models;
CREATE POLICY "models_public_website_read"
  ON public.models FOR SELECT TO anon
  USING (name IN ('all_projects', 'site_settings', 'project_details'));

COMMIT;
