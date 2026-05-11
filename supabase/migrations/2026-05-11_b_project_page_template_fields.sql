-- ============================================================================
-- Project Page Template — editable structural text for the public detail page.
--
-- The detail page (Wassel Website/project.html) had a layer of "structural"
-- copy hardcoded into the HTML: section eyebrows (عن المشروع — 01), headlines
-- (تصميم يحتفي بالحياة، وموقع يصنع الفارق), brochure/agent/CTA prose, and
-- the "قريباً" placeholders for units/form. Those were the only texts on the
-- page that the admin couldn't edit.
--
-- This migration makes them editable in two layers:
--
--   1. site_settings — defaults that apply to every project's detail page.
--      Edited once in "إعدادات الموقع". 32 fields, all under a new section
--      "قالب صفحة تفاصيل المشروع".
--
--   2. project_details — per-project overrides. Same 32 fields, all optional.
--      When the admin creates a new project_details record the bridge route
--      copies the current site_settings template values into these override
--      fields, so the editor opens with the template visible and tweakable.
--
-- The page resolves each text as:
--   project_details[pd_X]  →  site_settings[pd_X]  →  HTML hardcoded default
--
-- Naming: every template field is prefixed `pd_` (project-details template)
-- to keep it distinct from the existing field families.
-- ============================================================================

BEGIN;

-- pg_temp.pd_template_fields(): returns the array of 32 template-field
-- definitions. Used to inject the same field shape into both models, so
-- the two stay in lockstep — adding one here adds it to both.
CREATE OR REPLACE FUNCTION pg_temp.pd_template_fields(p_section_id text)
RETURNS jsonb AS $$
DECLARE
  rec record;
  acc jsonb := '[]'::jsonb;
  i int := 100;  -- field order base — leaves room for the existing fields above
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('pd_hero_eyebrow_label',     'علامة العنوان (نص قصير فوق العنوان)', 'Hero Eyebrow Label',        'text',     'half'),
      ('pd_scroll_label',           'نص "تصفّح المشروع"',                  'Scroll Prompt',             'text',     'half'),

      ('pd_about_eyebrow',          'علامة قسم "عن المشروع"',              'About Section Eyebrow',     'text',     'half'),
      ('pd_about_headline',         'عنوان قسم "عن المشروع"',              'About Section Headline',    'textarea', 'full'),

      ('pd_gallery_eyebrow',        'علامة قسم "المعرض"',                  'Gallery Section Eyebrow',   'text',     'half'),
      ('pd_gallery_headline',       'عنوان قسم "المعرض"',                  'Gallery Section Headline',  'text',     'half'),
      ('pd_gallery_view_all',       'نص "عرض جميع الصور"',                 'Gallery View-All Label',    'text',     'full'),

      ('pd_features_eyebrow',       'علامة قسم "المميزات"',                'Features Section Eyebrow',  'text',     'half'),
      ('pd_features_headline',      'عنوان قسم "المميزات"',                'Features Section Headline', 'text',     'half'),
      ('pd_features_intro',         'وصف قسم "المميزات"',                  'Features Section Intro',    'textarea', 'full'),

      ('pd_map_eyebrow',            'علامة قسم "الموقع"',                  'Map Section Eyebrow',       'text',     'half'),
      ('pd_map_headline',           'عنوان قسم "الموقع"',                  'Map Section Headline',      'text',     'half'),
      ('pd_map_landmarks_heading',  'عنوان قائمة المعالم القريبة',         'Landmarks Heading',         'text',     'full'),

      ('pd_brochure_eyebrow',       'علامة قسم "الكتيب"',                  'Brochure Section Eyebrow',  'text',     'half'),
      ('pd_brochure_headline',      'عنوان قسم "الكتيب"',                  'Brochure Section Headline', 'text',     'half'),
      ('pd_brochure_body',          'نص فقرة الكتيب',                      'Brochure Body Paragraph',   'textarea', 'full'),
      ('pd_brochure_cta',           'نص زر تنزيل الكتيب',                  'Brochure Download Button',  'text',     'full'),

      ('pd_units_badge',            'شارة "قريباً" لقسم الوحدات',          'Units Coming-Soon Badge',   'text',     'half'),
      ('pd_units_headline',         'عنوان قسم الوحدات',                   'Units Block Headline',      'text',     'half'),
      ('pd_units_body',             'وصف قسم الوحدات (Placeholder)',       'Units Block Description',   'textarea', 'full'),

      ('pd_form_badge',             'شارة "قريباً" لنموذج الاهتمام',       'Form Coming-Soon Badge',    'text',     'half'),
      ('pd_form_headline',          'عنوان نموذج الاهتمام',                'Form Block Headline',       'text',     'half'),
      ('pd_form_body',              'وصف نموذج الاهتمام (Placeholder)',    'Form Block Description',    'textarea', 'full'),

      ('pd_agent_eyebrow',          'علامة قسم المستشار',                  'Agent Section Eyebrow',     'text',     'half'),
      ('pd_agent_headline',         'عنوان قسم المستشار',                  'Agent Section Headline',    'textarea', 'full'),
      ('pd_agent_body',             'نص قسم المستشار',                     'Agent Section Body',        'textarea', 'full'),
      ('pd_agent_status',           'نص "متاح الآن للرد"',                 'Agent Status Text',         'text',     'half'),
      ('pd_agent_whatsapp_label',   'نص زر "تواصل عبر واتساب"',            'WhatsApp Button Label',     'text',     'half'),

      ('pd_bottom_cta_eyebrow',     'علامة قسم الدعوة السفلية',            'Bottom CTA Eyebrow',        'text',     'half'),
      ('pd_bottom_cta_suffix',      'الجملة بعد اسم المشروع',              'Bottom CTA Suffix Phrase',  'text',     'half'),
      ('pd_bottom_cta_body',        'وصف قسم الدعوة السفلية',              'Bottom CTA Body',           'textarea', 'full'),
      ('pd_bottom_cta_primary',     'زر الدعوة الأساسي',                   'Bottom CTA Primary Button', 'text',     'half'),
      ('pd_bottom_cta_secondary',   'زر الدعوة الثانوي',                   'Bottom CTA Secondary',      'text',     'half')
    ) AS t(name, label_ar, label_en, field_type, width)
  LOOP
    acc := acc || jsonb_build_array(jsonb_build_object(
      'id',            gen_random_uuid()::text,
      'name',          rec.name,
      'label_ar',      rec.label_ar,
      'label_en',      rec.label_en,
      'type',          rec.field_type,
      'required',      false,
      'order',         i,
      'section_id',    p_section_id,
      'width',         rec.width,
      'show_in_table', false
    ));
    i := i + 1;
  END LOOP;
  RETURN acc;
END;
$$ LANGUAGE plpgsql;

-- ─── 1. Add template section + fields to site_settings ──────────────────────
DO $$
DECLARE
  v_model_id   uuid;
  v_section_id text := gen_random_uuid()::text;
  v_already    boolean;
BEGIN
  SELECT id INTO v_model_id FROM models WHERE name = 'site_settings';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'site_settings model missing — skipping template injection';
    RETURN;
  END IF;

  -- Idempotency: if any pd_* template field already exists in this model,
  -- skip the whole injection. Re-runs of partial migrations stay safe.
  SELECT EXISTS (
    SELECT 1 FROM models m,
      jsonb_array_elements(m.schema->'sections') s,
      jsonb_array_elements(s->'fields') f
    WHERE m.id = v_model_id AND (f->>'name') LIKE 'pd\_%' ESCAPE '\'
  ) INTO v_already;
  IF v_already THEN
    RAISE NOTICE 'site_settings already has pd_* template fields — skipping';
    RETURN;
  END IF;

  UPDATE models
  SET schema = jsonb_set(
    schema,
    '{sections}',
    (schema->'sections') || jsonb_build_array(jsonb_build_object(
      'id',       v_section_id,
      'label_ar', 'قالب صفحة تفاصيل المشروع',
      'label_en', 'Project Details Page Template',
      'order',    99,
      'is_base',  false,
      'color',    '#B8734F',
      'fields',   pg_temp.pd_template_fields(v_section_id)
    ))
  ),
  updated_at = NOW()
  WHERE id = v_model_id;
END $$;

-- ─── 2. Add the same fields as a second section to project_details ──────────
DO $$
DECLARE
  v_model_id   uuid;
  v_section_id text := gen_random_uuid()::text;
  v_already    boolean;
BEGIN
  SELECT id INTO v_model_id FROM models WHERE name = 'project_details';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'project_details model missing — run 2026-05-10_b first';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM models m,
      jsonb_array_elements(m.schema->'sections') s,
      jsonb_array_elements(s->'fields') f
    WHERE m.id = v_model_id AND (f->>'name') LIKE 'pd\_%' ESCAPE '\'
  ) INTO v_already;
  IF v_already THEN
    RAISE NOTICE 'project_details already has pd_* template fields — skipping';
    RETURN;
  END IF;

  UPDATE models
  SET schema = jsonb_set(
    schema,
    '{sections}',
    (schema->'sections') || jsonb_build_array(jsonb_build_object(
      'id',       v_section_id,
      'label_ar', 'نصوص الصفحة (تعديل لهذا المشروع)',
      'label_en', 'Page Texts (Override for This Project)',
      'order',    1,
      'is_base',  false,
      'color',    '#C4754A',
      'fields',   pg_temp.pd_template_fields(v_section_id)
    ))
  ),
  updated_at = NOW()
  WHERE id = v_model_id;
END $$;

-- ─── 3. Seed the site_settings singleton with the current hardcoded defaults ─
DO $$
DECLARE
  v_model_id uuid;
  v_record_id uuid;
  v_data jsonb;
BEGIN
  SELECT id INTO v_model_id FROM models WHERE name = 'site_settings';
  IF v_model_id IS NULL THEN RETURN; END IF;

  SELECT id, data INTO v_record_id, v_data
  FROM records WHERE model_id = v_model_id ORDER BY created_at ASC LIMIT 1;
  IF v_record_id IS NULL THEN
    RAISE NOTICE 'site_settings singleton not found — defaults will inject on first save';
    RETURN;
  END IF;

  -- Only set keys that are missing; never overwrite admin's existing values.
  v_data := COALESCE(v_data, '{}'::jsonb);
  v_data := v_data
    || (CASE WHEN v_data ? 'pd_hero_eyebrow_label'    THEN '{}'::jsonb ELSE jsonb_build_object('pd_hero_eyebrow_label',    'مشروع #') END)
    || (CASE WHEN v_data ? 'pd_scroll_label'          THEN '{}'::jsonb ELSE jsonb_build_object('pd_scroll_label',          'تصفّح المشروع') END)

    || (CASE WHEN v_data ? 'pd_about_eyebrow'         THEN '{}'::jsonb ELSE jsonb_build_object('pd_about_eyebrow',         'عن المشروع') END)
    || (CASE WHEN v_data ? 'pd_about_headline'        THEN '{}'::jsonb ELSE jsonb_build_object('pd_about_headline',        'تصميم يحتفي بالحياة، وموقع يصنع الفارق.') END)

    || (CASE WHEN v_data ? 'pd_gallery_eyebrow'       THEN '{}'::jsonb ELSE jsonb_build_object('pd_gallery_eyebrow',       'معرض الصور') END)
    || (CASE WHEN v_data ? 'pd_gallery_headline'      THEN '{}'::jsonb ELSE jsonb_build_object('pd_gallery_headline',      'شاهد المشروع من الداخل') END)
    || (CASE WHEN v_data ? 'pd_gallery_view_all'      THEN '{}'::jsonb ELSE jsonb_build_object('pd_gallery_view_all',      'عرض جميع الصور') END)

    || (CASE WHEN v_data ? 'pd_features_eyebrow'      THEN '{}'::jsonb ELSE jsonb_build_object('pd_features_eyebrow',      'المميزات') END)
    || (CASE WHEN v_data ? 'pd_features_headline'     THEN '{}'::jsonb ELSE jsonb_build_object('pd_features_headline',     'مواصفات تستحق العيش.') END)
    || (CASE WHEN v_data ? 'pd_features_intro'        THEN '{}'::jsonb ELSE jsonb_build_object('pd_features_intro',        'عناصر اخترناها بعناية لتمنح ساكني المشروع تجربة سكنية من الطراز الأول.') END)

    || (CASE WHEN v_data ? 'pd_map_eyebrow'           THEN '{}'::jsonb ELSE jsonb_build_object('pd_map_eyebrow',           'الموقع') END)
    || (CASE WHEN v_data ? 'pd_map_headline'          THEN '{}'::jsonb ELSE jsonb_build_object('pd_map_headline',          'في قلب الرياض الجديدة.') END)
    || (CASE WHEN v_data ? 'pd_map_landmarks_heading' THEN '{}'::jsonb ELSE jsonb_build_object('pd_map_landmarks_heading', 'المعالم القريبة') END)

    || (CASE WHEN v_data ? 'pd_brochure_eyebrow'      THEN '{}'::jsonb ELSE jsonb_build_object('pd_brochure_eyebrow',      'الكتيب') END)
    || (CASE WHEN v_data ? 'pd_brochure_headline'     THEN '{}'::jsonb ELSE jsonb_build_object('pd_brochure_headline',     'احصل على كتيب المشروع الكامل') END)
    || (CASE WHEN v_data ? 'pd_brochure_body'         THEN '{}'::jsonb ELSE jsonb_build_object('pd_brochure_body',         'كل التفاصيل: المخططات، الأسعار، خيارات الدفع، وعروض الإطلاق المحدودة — في ملف PDF واحد.') END)
    || (CASE WHEN v_data ? 'pd_brochure_cta'          THEN '{}'::jsonb ELSE jsonb_build_object('pd_brochure_cta',          'تنزيل الكتيب (PDF)') END)

    || (CASE WHEN v_data ? 'pd_units_badge'           THEN '{}'::jsonb ELSE jsonb_build_object('pd_units_badge',           'قريباً') END)
    || (CASE WHEN v_data ? 'pd_units_headline'        THEN '{}'::jsonb ELSE jsonb_build_object('pd_units_headline',        'عرض الوحدات السكنية') END)
    || (CASE WHEN v_data ? 'pd_units_body'            THEN '{}'::jsonb ELSE jsonb_build_object('pd_units_body',            'هنا ستظهر جميع الوحدات بمخططاتها وأسعارها وحالتها (متاحة، محجوزة، مباعة) — مع إمكانية الحجز المباشر.') END)

    || (CASE WHEN v_data ? 'pd_form_badge'            THEN '{}'::jsonb ELSE jsonb_build_object('pd_form_badge',            'قريباً') END)
    || (CASE WHEN v_data ? 'pd_form_headline'         THEN '{}'::jsonb ELSE jsonb_build_object('pd_form_headline',         'نموذج تسجيل الاهتمام') END)
    || (CASE WHEN v_data ? 'pd_form_body'             THEN '{}'::jsonb ELSE jsonb_build_object('pd_form_body',             'نموذج ذكي يتيح للعميل اختيار الوحدة، طريقة الشراء (كاش/تمويل)، والغرض (سكن/استثمار) — مع ربط مباشر بنظام إدارة العملاء.') END)

    || (CASE WHEN v_data ? 'pd_agent_eyebrow'         THEN '{}'::jsonb ELSE jsonb_build_object('pd_agent_eyebrow',         'تحدث مع مستشار المشروع') END)
    || (CASE WHEN v_data ? 'pd_agent_headline'        THEN '{}'::jsonb ELSE jsonb_build_object('pd_agent_headline',        'هل تريد جولة افتراضية أو زيارة الموقع؟') END)
    || (CASE WHEN v_data ? 'pd_agent_body'            THEN '{}'::jsonb ELSE jsonb_build_object('pd_agent_body',            'احجز موعداً مع مستشار المشروع خلال دقيقة — جولة افتراضية بالواقع المعزز أو زيارة ميدانية للمشروع.') END)
    || (CASE WHEN v_data ? 'pd_agent_status'          THEN '{}'::jsonb ELSE jsonb_build_object('pd_agent_status',          'متاح الآن للرد على استفساراتك') END)
    || (CASE WHEN v_data ? 'pd_agent_whatsapp_label'  THEN '{}'::jsonb ELSE jsonb_build_object('pd_agent_whatsapp_label',  'تواصل عبر واتساب') END)

    || (CASE WHEN v_data ? 'pd_bottom_cta_eyebrow'    THEN '{}'::jsonb ELSE jsonb_build_object('pd_bottom_cta_eyebrow',    'جاهز للخطوة التالية؟') END)
    || (CASE WHEN v_data ? 'pd_bottom_cta_suffix'     THEN '{}'::jsonb ELSE jsonb_build_object('pd_bottom_cta_suffix',     'يستحق زيارة.') END)
    || (CASE WHEN v_data ? 'pd_bottom_cta_body'       THEN '{}'::jsonb ELSE jsonb_build_object('pd_bottom_cta_body',       'تواصل معنا اليوم لاستكشاف الوحدات المتاحة، خيارات الدفع، وعروض الإطلاق الحصرية.') END)
    || (CASE WHEN v_data ? 'pd_bottom_cta_primary'    THEN '{}'::jsonb ELSE jsonb_build_object('pd_bottom_cta_primary',    'سجّل اهتمامك') END)
    || (CASE WHEN v_data ? 'pd_bottom_cta_secondary'  THEN '{}'::jsonb ELSE jsonb_build_object('pd_bottom_cta_secondary',  'تصفّح بقية المشاريع') END);

  UPDATE records SET data = v_data, updated_at = NOW() WHERE id = v_record_id;
END $$;

COMMIT;
