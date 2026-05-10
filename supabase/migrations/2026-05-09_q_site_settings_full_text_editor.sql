-- ============================================================================
-- Site settings — full text editor for the public homepage.
--
-- The website's index.html is wired with ~155 `data-w-text` / `data-w-html` /
-- `data-w-href` attributes (see Wassel Website/EDITABLE_KEYS.md). On page
-- load it walks every tagged element and substitutes the value from
-- site_settings.data[<key>], falling back to the hardcoded HTML default
-- when a key is missing.
--
-- This migration adds those ~155 keys as proper fields on the site_settings
-- model, organized into 11 sections that match the homepage layout (Brand,
-- Hero, About, Why, Stats, Tech, Journey, Capabilities, Services, CTA,
-- Footer). Existing field IDs are preserved by name so card_config and any
-- other ID references stay valid; new fields get fresh UUIDs. The Map Card
-- section (with its admin-tuned dropdowns) is plucked out and re-appended
-- last so admins still find the same picker.
--
-- The migration is idempotent: re-running it produces the same schema
-- (since IDs for existing names are read from the current schema).
-- ============================================================================

BEGIN;

-- Temp helper — `pg_temp.field_obj` mints (or reuses) a field object.
-- COALESCE(id_map->>name, gen_random_uuid()) keeps existing IDs stable so
-- card_config / other field-id references don't break across re-runs.
CREATE OR REPLACE FUNCTION pg_temp.field_obj(
  p_id_map jsonb, p_section_id text, p_name text,
  p_label_ar text, p_label_en text, p_type text, p_order int,
  p_width text DEFAULT 'full', p_show_in_table boolean DEFAULT false
) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id',            COALESCE(p_id_map->>p_name, gen_random_uuid()::text),
    'name',          p_name,
    'label_ar',      p_label_ar,
    'label_en',      p_label_en,
    'type',          p_type,
    'required',      false,
    'order',         p_order,
    'section_id',    p_section_id,
    'width',         p_width,
    'show_in_table', p_show_in_table
  );
$$ LANGUAGE sql IMMUTABLE;

DO $$
DECLARE
  v_model_id          uuid;
  v_old_schema        jsonb;
  v_id_map            jsonb;
  v_map_card_section  jsonb;
  -- Stable section IDs (preserved across re-runs by reading from old schema
  -- when present, else minted fresh).
  v_brand_id    text;
  v_hero_id     text;
  v_about_id    text;
  v_why_id      text;
  v_stats_id    text;
  v_tech_id     text;
  v_journey_id  text;
  v_caps_id     text;
  v_services_id text;
  v_cta_id      text;
  v_footer_id   text;
  v_old_section_id_map jsonb;
BEGIN
  SELECT id, schema INTO v_model_id, v_old_schema
  FROM models WHERE name = 'site_settings';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'site_settings model not found — skipping';
    RETURN;
  END IF;

  -- name → existing field id, used by pg_temp.field_obj to preserve IDs.
  SELECT jsonb_object_agg(f->>'name', f->>'id')
  INTO v_id_map
  FROM jsonb_array_elements(v_old_schema->'sections') sec,
       jsonb_array_elements(sec->'fields') f;
  IF v_id_map IS NULL THEN v_id_map := '{}'::jsonb; END IF;

  -- label → existing section id, so re-running this migration doesn't
  -- regenerate every section's UUID (which would orphan field.section_id
  -- references on the next iteration).
  SELECT jsonb_object_agg(s->>'label_en', s->>'id')
  INTO v_old_section_id_map
  FROM jsonb_array_elements(v_old_schema->'sections') s;
  IF v_old_section_id_map IS NULL THEN v_old_section_id_map := '{}'::jsonb; END IF;

  v_brand_id    := COALESCE(v_old_section_id_map->>'Brand & Navigation',  gen_random_uuid()::text);
  v_hero_id     := COALESCE(v_old_section_id_map->>'Hero',                gen_random_uuid()::text);
  v_about_id    := COALESCE(v_old_section_id_map->>'About',               gen_random_uuid()::text);
  v_why_id      := COALESCE(v_old_section_id_map->>'Why Us',              gen_random_uuid()::text);
  v_stats_id    := COALESCE(v_old_section_id_map->>'Stats',               gen_random_uuid()::text);
  v_tech_id     := COALESCE(v_old_section_id_map->>'Tech',                gen_random_uuid()::text);
  v_journey_id  := COALESCE(v_old_section_id_map->>'Customer Journey',    gen_random_uuid()::text);
  v_caps_id     := COALESCE(v_old_section_id_map->>'Capabilities',        gen_random_uuid()::text);
  v_services_id := COALESCE(v_old_section_id_map->>'Services',            gen_random_uuid()::text);
  v_cta_id      := COALESCE(v_old_section_id_map->>'CTA',                 gen_random_uuid()::text);
  v_footer_id   := COALESCE(v_old_section_id_map->>'Footer',              gen_random_uuid()::text);

  -- Pluck the Map Card section to preserve its admin-tuned dropdown options
  -- exactly as-is (we'd lose the field-name → field-id mapping anchored in
  -- this section if we rebuilt it from scratch).
  SELECT s INTO v_map_card_section
  FROM jsonb_array_elements(v_old_schema->'sections') s
  WHERE s->>'label_en' = 'Map Card' OR s->>'label_ar' = 'بطاقة الخريطة';

  UPDATE models
  SET schema = jsonb_build_object(
    'sections', jsonb_build_array(

      -- ─── 0. Brand & Navigation ───────────────────────────────────────
      jsonb_build_object(
        'id', v_brand_id,
        'label_ar', 'العلامة التجارية والتنقل',
        'label_en', 'Brand & Navigation',
        'order', 0,
        'is_base', true,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_brand_id, 'brand_name_ar',  'اسم العلامة (عربي)',     'Brand Name (AR)',     'text', 0, 'half'),
          pg_temp.field_obj(v_id_map, v_brand_id, 'brand_name_en',  'اسم العلامة (إنجليزي)',  'Brand Name (EN)',     'text', 1, 'half'),
          pg_temp.field_obj(v_id_map, v_brand_id, 'nav_home',       'قائمة: الرئيسية',         'Nav: Home',           'text', 2, 'half'),
          pg_temp.field_obj(v_id_map, v_brand_id, 'nav_projects',   'قائمة: المشاريع',         'Nav: Projects',       'text', 3, 'half'),
          pg_temp.field_obj(v_id_map, v_brand_id, 'nav_map',        'قائمة: الخريطة',          'Nav: Map',            'text', 4, 'half'),
          pg_temp.field_obj(v_id_map, v_brand_id, 'nav_cta',        'زر القائمة (CTA)',         'Nav CTA',             'text', 5, 'half')
        )
      ),

      -- ─── 1. Hero ─────────────────────────────────────────────────────
      jsonb_build_object(
        'id', v_hero_id,
        'label_ar', 'البطل (Hero)',
        'label_en', 'Hero',
        'order', 1,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_eyebrow_left',        'تمهيد البطل (يسار)',     'Hero Eyebrow (Left)',     'text',     0,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_eyebrow_right',       'تمهيد البطل (يمين)',     'Hero Eyebrow (Right)',    'text',     1,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_eyebrow_right_short', 'تمهيد البطل (مختصر)',    'Hero Eyebrow (Short)',    'text',     2,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_eyebrow',             'تمهيد البطل',            'Hero Eyebrow',            'text',     3,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_title',               'عنوان البطل',            'Hero Title',              'text',     4,  'full'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_subtitle',            'العنوان الفرعي',         'Hero Subtitle',           'text',     5,  'full'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_description',         'وصف البطل',              'Hero Description',        'textarea', 6,  'full'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_cta_primary',         'زر البطل الأساسي',       'Hero CTA Primary',        'text',     7,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_cta_primary_url',     'رابط الزر الأساسي',      'Hero CTA Primary URL',    'url',      8,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_cta_secondary',       'زر البطل الثانوي',       'Hero CTA Secondary',      'text',     9,  'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_cta_secondary_url',   'رابط الزر الثانوي',      'Hero CTA Secondary URL',  'url',      10, 'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_kpi_eyebrow',         'تمهيد لوحة الأرقام',     'KPI Rail Eyebrow',        'text',     11, 'full'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_pillar_1',            'الركيزة 1',              'Pillar 1',                'text',     12, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_pillar_2',            'الركيزة 2',              'Pillar 2',                'text',     13, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_pillar_3',            'الركيزة 3',              'Pillar 3',                'text',     14, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_scroll_label',        'تسمية التمرير',          'Scroll Label',            'text',     15, 'half'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'stat_1_value',             'KPI 1 — قيمة',            'KPI 1 — Value',          'text',     16, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'stat_1_label',             'KPI 1 — تسمية',           'KPI 1 — Label',          'text',     17, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'stat_2_value',             'KPI 2 — قيمة',            'KPI 2 — Value',          'text',     18, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'stat_2_label',             'KPI 2 — تسمية',           'KPI 2 — Label',          'text',     19, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'stat_3_value',             'KPI 3 — قيمة',            'KPI 3 — Value',          'text',     20, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'stat_3_label',             'KPI 3 — تسمية',           'KPI 3 — Label',          'text',     21, 'third'),
          pg_temp.field_obj(v_id_map, v_hero_id, 'hero_bg_image_url',        'صورة خلفية البطل',        'Hero Background Image',  'url',      22, 'full')
        )
      ),

      -- ─── 2. About ────────────────────────────────────────────────────
      jsonb_build_object(
        'id', v_about_id,
        'label_ar', 'عن الشركة',
        'label_en', 'About',
        'order', 2,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_about_id, 'about_index_label',       'مُؤشّر القسم',          'Section Index Label',    'text',     0,  'half'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_eyebrow',           'تمهيد القسم',           'Section Eyebrow',        'text',     1,  'half'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_headline',          'العنوان (يدعم HTML)',  'Headline (HTML)',         'textarea', 2,  'full'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_paragraph_1',       'الفقرة الأولى',         'Paragraph 1',            'textarea', 3,  'full'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_paragraph_2',       'الفقرة الثانية',        'Paragraph 2',            'textarea', 4,  'full'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_card_year',         'بطاقة: السنة',          'Card: Year',             'text',     5,  'half'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_card_city',         'بطاقة: المدينة',        'Card: City',             'text',     6,  'half'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_card_title',        'بطاقة: العنوان (HTML)','Card: Title (HTML)',     'textarea', 7,  'full'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_card_desc',         'بطاقة: الوصف',          'Card: Description',      'textarea', 8,  'full'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_audience_1_index',  'الجمهور 1 — رقم',       'Audience 1 — Index',     'text',     9,  'third'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_audience_1_title',  'الجمهور 1 — عنوان',     'Audience 1 — Title',     'text',     10, 'third'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_audience_1_desc',   'الجمهور 1 — وصف',       'Audience 1 — Desc',      'textarea', 11, 'third'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_audience_2_index',  'الجمهور 2 — رقم',       'Audience 2 — Index',     'text',     12, 'third'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_audience_2_title',  'الجمهور 2 — عنوان',     'Audience 2 — Title',     'text',     13, 'third'),
          pg_temp.field_obj(v_id_map, v_about_id, 'about_audience_2_desc',   'الجمهور 2 — وصف',       'Audience 2 — Desc',      'textarea', 14, 'third')
        )
      ),

      -- ─── 3. Why Us ───────────────────────────────────────────────────
      jsonb_build_object(
        'id', v_why_id,
        'label_ar', 'ما يميزنا',
        'label_en', 'Why Us',
        'order', 3,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_why_id, 'why_index_label',  'مُؤشّر القسم',          'Section Index Label', 'text',     0,  'half'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_eyebrow',      'تمهيد القسم',           'Section Eyebrow',     'text',     1,  'half'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_headline',     'العنوان (يدعم HTML)',   'Headline (HTML)',     'textarea', 2,  'full'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_intro',        'مقدمة القسم',           'Intro',               'textarea', 3,  'full'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_1_index',      'سبب 1 — رقم',           'Reason 1 — Index',    'text',     4,  'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_1_title',      'سبب 1 — عنوان',         'Reason 1 — Title',    'text',     5,  'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_1_desc',       'سبب 1 — وصف',           'Reason 1 — Desc',     'textarea', 6,  'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_2_index',      'سبب 2 — رقم',           'Reason 2 — Index',    'text',     7,  'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_2_title',      'سبب 2 — عنوان',         'Reason 2 — Title',    'text',     8,  'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_2_desc',       'سبب 2 — وصف',           'Reason 2 — Desc',     'textarea', 9,  'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_3_index',      'سبب 3 — رقم',           'Reason 3 — Index',    'text',     10, 'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_3_title',      'سبب 3 — عنوان',         'Reason 3 — Title',    'text',     11, 'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_3_desc',       'سبب 3 — وصف',           'Reason 3 — Desc',     'textarea', 12, 'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_4_index',      'سبب 4 — رقم',           'Reason 4 — Index',    'text',     13, 'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_4_title',      'سبب 4 — عنوان',         'Reason 4 — Title',    'text',     14, 'third'),
          pg_temp.field_obj(v_id_map, v_why_id, 'why_4_desc',       'سبب 4 — وصف',           'Reason 4 — Desc',     'textarea', 15, 'third')
        )
      ),

      -- ─── 4. Stats (large editorial) ──────────────────────────────────
      jsonb_build_object(
        'id', v_stats_id,
        'label_ar', 'الأرقام البارزة',
        'label_en', 'Stats',
        'order', 4,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_stats_id, 'stats_eyebrow',     'تمهيد القسم',           'Section Eyebrow',    'text',     0,  'full'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stats_headline',    'العنوان (يدعم HTML)',   'Headline (HTML)',    'textarea', 1,  'full'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stats_intro',       'مقدمة القسم',           'Intro',              'textarea', 2,  'full'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_1_value_lg',   'إحصاء 1 — قيمة',         'Stat 1 — Value',     'text',     3,  'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_1_label_lg',   'إحصاء 1 — تسمية',        'Stat 1 — Label',     'text',     4,  'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_1_caption',    'إحصاء 1 — تعليق',        'Stat 1 — Caption',   'textarea', 5,  'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_1_index',      'إحصاء 1 — رقم القسم',     'Stat 1 — Index',     'text',     6,  'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_2_value_lg',   'إحصاء 2 — قيمة (HTML)',  'Stat 2 — Value (HTML)','textarea',7, 'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_2_label_lg',   'إحصاء 2 — تسمية',        'Stat 2 — Label',     'text',     8,  'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_2_caption',    'إحصاء 2 — تعليق',        'Stat 2 — Caption',   'textarea', 9,  'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_2_index',      'إحصاء 2 — رقم القسم',     'Stat 2 — Index',     'text',     10, 'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_3_value_lg',   'إحصاء 3 — قيمة (HTML)',  'Stat 3 — Value (HTML)','textarea',11,'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_3_label_lg',   'إحصاء 3 — تسمية',        'Stat 3 — Label',     'text',     12, 'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_3_caption',    'إحصاء 3 — تعليق',        'Stat 3 — Caption',   'textarea', 13, 'half'),
          pg_temp.field_obj(v_id_map, v_stats_id, 'stat_3_index',      'إحصاء 3 — رقم القسم',     'Stat 3 — Index',     'text',     14, 'half')
        )
      ),

      -- ─── 5. Tech ─────────────────────────────────────────────────────
      jsonb_build_object(
        'id', v_tech_id,
        'label_ar', 'التقنية',
        'label_en', 'Tech',
        'order', 5,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_headline',  'العنوان',          'Headline',     'text',     0, 'full'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_intro_1',   'الفقرة الأولى',    'Paragraph 1',  'textarea', 1, 'full'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_intro_2',   'الفقرة الثانية',   'Paragraph 2',  'textarea', 2, 'full'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_bullet_1',  'نقطة 1',           'Bullet 1',     'text',     3, 'half'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_bullet_2',  'نقطة 2',           'Bullet 2',     'text',     4, 'half'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_bullet_3',  'نقطة 3',           'Bullet 3',     'text',     5, 'half'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_bullet_4',  'نقطة 4',           'Bullet 4',     'text',     6, 'half'),
          pg_temp.field_obj(v_id_map, v_tech_id, 'tech_quote',     'الاقتباس السفلي',  'Bottom Quote', 'textarea', 7, 'full')
        )
      ),

      -- ─── 6. Customer Journey ─────────────────────────────────────────
      jsonb_build_object(
        'id', v_journey_id,
        'label_ar', 'رحلة العميل',
        'label_en', 'Customer Journey',
        'order', 6,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_headline', 'العنوان',     'Headline',      'text',     0,  'full'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_intro',    'مقدمة',        'Intro',         'textarea', 1,  'full'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_1_title',  'مرحلة 1 — عنوان', 'Step 1 — Title', 'text',  2,  'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_1_desc',   'مرحلة 1 — وصف',  'Step 1 — Desc',  'textarea',3,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_2_title',  'مرحلة 2 — عنوان', 'Step 2 — Title', 'text',  4,  'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_2_desc',   'مرحلة 2 — وصف',  'Step 2 — Desc',  'textarea',5,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_3_title',  'مرحلة 3 — عنوان', 'Step 3 — Title', 'text',  6,  'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_3_desc',   'مرحلة 3 — وصف',  'Step 3 — Desc',  'textarea',7,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_4_title',  'مرحلة 4 — عنوان', 'Step 4 — Title', 'text',  8,  'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_4_desc',   'مرحلة 4 — وصف',  'Step 4 — Desc',  'textarea',9,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_5_title',  'مرحلة 5 — عنوان', 'Step 5 — Title', 'text',  10, 'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_5_desc',   'مرحلة 5 — وصف',  'Step 5 — Desc',  'textarea',11,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_6_title',  'مرحلة 6 — عنوان', 'Step 6 — Title', 'text',  12, 'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_6_desc',   'مرحلة 6 — وصف',  'Step 6 — Desc',  'textarea',13,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_7_title',  'مرحلة 7 — عنوان', 'Step 7 — Title', 'text',  14, 'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_7_desc',   'مرحلة 7 — وصف',  'Step 7 — Desc',  'textarea',15,'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_8_title',  'مرحلة 8 — عنوان', 'Step 8 — Title', 'text',  16, 'half'),
          pg_temp.field_obj(v_id_map, v_journey_id, 'journey_8_desc',   'مرحلة 8 — وصف',  'Step 8 — Desc',  'textarea',17,'half')
        )
      ),

      -- ─── 7. Capabilities ─────────────────────────────────────────────
      jsonb_build_object(
        'id', v_caps_id,
        'label_ar', 'القدرات',
        'label_en', 'Capabilities',
        'order', 7,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_index_label',     'مُؤشّر القسم',         'Section Index Label',  'text',     0,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_eyebrow',         'تمهيد القسم',          'Section Eyebrow',      'text',     1,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_headline',        'العنوان (يدعم HTML)',  'Headline (HTML)',      'textarea', 2,  'full'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_intro',           'مقدمة القسم',          'Intro',                'textarea', 3,  'full'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_1_title',         'قدرة 1 — عنوان',       'Cap 1 — Title',        'text',     4,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_1_desc',          'قدرة 1 — وصف',         'Cap 1 — Desc',         'textarea', 5,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_2_title',         'قدرة 2 — عنوان',       'Cap 2 — Title',        'text',     6,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_2_desc',          'قدرة 2 — وصف',         'Cap 2 — Desc',         'textarea', 7,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_3_title',         'قدرة 3 — عنوان',       'Cap 3 — Title',        'text',     8,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_3_desc',          'قدرة 3 — وصف',         'Cap 3 — Desc',         'textarea', 9,  'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_4_title',         'قدرة 4 — عنوان',       'Cap 4 — Title',        'text',     10, 'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_4_desc',          'قدرة 4 — وصف',         'Cap 4 — Desc',         'textarea', 11, 'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_5_title',         'قدرة 5 — عنوان',       'Cap 5 — Title',        'text',     12, 'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_5_desc',          'قدرة 5 — وصف',         'Cap 5 — Desc',         'textarea', 13, 'half'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_outro_headline',  'الخلاصة — عنوان',       'Outro — Headline',     'text',     14, 'full'),
          pg_temp.field_obj(v_id_map, v_caps_id, 'cap_outro_desc',      'الخلاصة — وصف',         'Outro — Desc',         'textarea', 15, 'full')
        )
      ),

      -- ─── 8. Services ─────────────────────────────────────────────────
      jsonb_build_object(
        'id', v_services_id,
        'label_ar', 'الخدمات',
        'label_en', 'Services',
        'order', 8,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_services_id, 'services_index_label', 'مُؤشّر القسم',         'Section Index Label', 'text',     0,  'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'services_eyebrow',     'تمهيد القسم',          'Section Eyebrow',     'text',     1,  'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'services_headline',    'العنوان (يدعم HTML)',  'Headline (HTML)',     'textarea', 2,  'full'),
          pg_temp.field_obj(v_id_map, v_services_id, 'services_intro',       'مقدمة القسم',          'Intro',               'textarea', 3,  'full'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_1_title',      'خدمة 1 — عنوان',       'Service 1 — Title',   'text',     4,  'full'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_1_bullet_1',   'خدمة 1 — نقطة 1',      'Service 1 — Bullet 1','text',     5,  'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_1_bullet_2',   'خدمة 1 — نقطة 2',      'Service 1 — Bullet 2','text',     6,  'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_1_bullet_3',   'خدمة 1 — نقطة 3',      'Service 1 — Bullet 3','text',     7,  'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_1_bullet_4',   'خدمة 1 — نقطة 4',      'Service 1 — Bullet 4','text',     8,  'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_2_title',      'خدمة 2 — عنوان',       'Service 2 — Title',   'text',     9,  'full'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_2_bullet_1',   'خدمة 2 — نقطة 1',      'Service 2 — Bullet 1','text',     10, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_2_bullet_2',   'خدمة 2 — نقطة 2',      'Service 2 — Bullet 2','text',     11, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_2_bullet_3',   'خدمة 2 — نقطة 3',      'Service 2 — Bullet 3','text',     12, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_2_bullet_4',   'خدمة 2 — نقطة 4',      'Service 2 — Bullet 4','text',     13, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_3_title',      'خدمة 3 — عنوان',       'Service 3 — Title',   'text',     14, 'full'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_3_bullet_1',   'خدمة 3 — نقطة 1',      'Service 3 — Bullet 1','text',     15, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_3_bullet_2',   'خدمة 3 — نقطة 2',      'Service 3 — Bullet 2','text',     16, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_3_bullet_3',   'خدمة 3 — نقطة 3',      'Service 3 — Bullet 3','text',     17, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_3_bullet_4',   'خدمة 3 — نقطة 4',      'Service 3 — Bullet 4','text',     18, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_4_title',      'خدمة 4 — عنوان',       'Service 4 — Title',   'text',     19, 'full'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_4_bullet_1',   'خدمة 4 — نقطة 1',      'Service 4 — Bullet 1','text',     20, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_4_bullet_2',   'خدمة 4 — نقطة 2',      'Service 4 — Bullet 2','text',     21, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_4_bullet_3',   'خدمة 4 — نقطة 3',      'Service 4 — Bullet 3','text',     22, 'half'),
          pg_temp.field_obj(v_id_map, v_services_id, 'service_4_bullet_4',   'خدمة 4 — نقطة 4',      'Service 4 — Bullet 4','text',     23, 'half')
        )
      ),

      -- ─── 9. CTA (above footer) ───────────────────────────────────────
      jsonb_build_object(
        'id', v_cta_id,
        'label_ar', 'الدعوة للعمل',
        'label_en', 'CTA',
        'order', 9,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_eyebrow',        'تمهيد القسم',          'Eyebrow',              'text',     0, 'full'),
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_headline',       'العنوان (يدعم HTML)',  'Headline (HTML)',      'textarea', 1, 'full'),
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_description',    'الوصف',                 'Description',          'textarea', 2, 'full'),
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_primary',        'الزر الأساسي',          'Primary Button',       'text',     3, 'half'),
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_primary_url',    'رابط الزر الأساسي',     'Primary Button URL',   'url',      4, 'half'),
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_secondary',      'الزر الثانوي',           'Secondary Button',     'text',     5, 'half'),
          pg_temp.field_obj(v_id_map, v_cta_id, 'cta_secondary_url',  'رابط الزر الثانوي',      'Secondary Button URL', 'url',      6, 'half')
        )
      ),

      -- ─── 10. Footer ──────────────────────────────────────────────────
      jsonb_build_object(
        'id', v_footer_id,
        'label_ar', 'التذييل',
        'label_en', 'Footer',
        'order', 10,
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_brand_ar',          'العلامة (عربي)',         'Brand (AR)',          'text',  0,  'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_brand_en',          'العلامة (إنجليزي)',      'Brand (EN)',          'text',  1,  'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_tagline_ar',        'العبارة التسويقية (عربي)','Tagline (AR)',        'text',  2,  'full'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_tagline_2',         'العبارة الثانية',         'Secondary Tagline',   'text',  3,  'full'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_contact_heading',   'عنوان قسم التواصل',       'Contact Heading',     'text',  4,  'full'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'address_ar',               'العنوان (عربي)',          'Address (AR)',        'text',  5,  'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'address_en',               'العنوان (إنجليزي)',       'Address (EN)',        'text',  6,  'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'contact_phone',            'رقم التواصل',             'Contact Phone',       'phone',7,  'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'contact_email',            'البريد الإلكتروني',       'Contact Email',       'email',8,  'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_hours_heading',     'عنوان قسم الساعات',       'Hours Heading',       'text', 9,  'full'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'hours_ar',                 'ساعات العمل',             'Working Hours',       'text', 10, 'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'hours_weekend',            'ساعات نهاية الأسبوع',     'Weekend Hours',       'text', 11, 'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_social_heading',    'عنوان قسم التواصل الاجتماعي','Social Heading',   'text', 12, 'full'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'linkedin_url',             'لينكدإن',                  'LinkedIn URL',        'url',  13, 'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'tiktok_url',               'تيك توك',                  'TikTok URL',          'url',  14, 'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'instagram_url',            'إنستغرام',                 'Instagram URL',       'url',  15, 'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'whatsapp_phone',           'رقم الواتساب',             'WhatsApp Phone',      'phone',16, 'half'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_copyright',         'حقوق النشر',               'Copyright',           'text', 17, 'full'),
          pg_temp.field_obj(v_id_map, v_footer_id, 'footer_back_to_top',       'زر العودة للأعلى',         'Back to Top',         'text', 18, 'half')
        )
      ),

      -- ─── 11. Map Card (preserved) ────────────────────────────────────
      -- The Map Card section keeps its existing dropdown options + field IDs
      -- intact. Just bump its `order` to land last so the form layout is
      -- predictable.
      COALESCE(
        v_map_card_section || jsonb_build_object('order', 11),
        jsonb_build_object(
          'id', gen_random_uuid()::text,
          'label_ar', 'بطاقة الخريطة',
          'label_en', 'Map Card',
          'order', 11,
          'is_base', false,
          'color', '#B8734F',
          'fields', '[]'::jsonb
        )
      )
    ),
    'section_selector_field_id', null
  ),
  updated_at = NOW()
  WHERE id = v_model_id;
END $$;

COMMIT;
