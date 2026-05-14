-- ============================================================================
-- Site settings — Project Card field selectors.
--
-- Adds a new "بطاقة المشروع / Project Card" section to the site_settings model
-- with 8 dropdown fields the admin uses to choose which all_projects field
-- populates each slot in the public website's project listing card
-- (projects.html grid):
--
--   proj_card_image_field    — hero image (overrides hardcoded image_url)
--   proj_card_title_field    — card title
--   proj_card_subtitle_field — card subtitle
--   proj_card_status_field   — status pill (with dropdown option color)
--   proj_card_chip1_field    — first spec chip
--   proj_card_chip2_field    — second spec chip
--   proj_card_price_field    — price block
--   proj_card_cta_url_field  — destination of the "عرض المشروع" CTA
--
-- Mirrors the pattern of the "بطاقة الخريطة / Map Card" section
-- (2026-05-09_l_site_settings_map_card_config.sql). Each dropdown's options
-- are SNAPSHOTTED from all_projects' current schema at migration time
-- (skipping mirror / section_mirror / notes / assignee / section_selector —
-- none make sense in a public card).
--
-- Empty selections fall back to the website's existing heuristics:
--   image     → record.data.image_url (hardcoded today)
--   title     → all_projects.card_config.title_field_id
--   subtitle  → all_projects.card_config.subtitle_field_id
--   status    → all_projects.card_config.badge_field_id
--   chip1/2   → first two of all_projects.card_config.shown_field_ids
--   price     → no fallback (slot stays hidden)
--   CTA URL   → project.html?id=<record id> (existing default)
--
-- So the migration is non-breaking — the website continues to render the
-- current card if no slots are picked.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_site_id            uuid;
  v_proj_model_id      uuid;
  v_section_id         text := gen_random_uuid()::text;
  v_field_options      jsonb;
  v_image_id           text := gen_random_uuid()::text;
  v_title_id           text := gen_random_uuid()::text;
  v_subtitle_id        text := gen_random_uuid()::text;
  v_status_id          text := gen_random_uuid()::text;
  v_chip1_id           text := gen_random_uuid()::text;
  v_chip2_id           text := gen_random_uuid()::text;
  v_price_id           text := gen_random_uuid()::text;
  v_cta_id             text := gen_random_uuid()::text;
BEGIN
  SELECT id INTO v_site_id FROM models WHERE name = 'site_settings';
  SELECT id INTO v_proj_model_id FROM models WHERE name = 'all_projects';
  IF v_site_id IS NULL OR v_proj_model_id IS NULL THEN
    RAISE NOTICE 'site_settings or all_projects not found — skipping';
    RETURN;
  END IF;

  -- Idempotent: skip if the section already exists.
  IF EXISTS (
    SELECT 1
    FROM models m, jsonb_array_elements(m.schema->'sections') s
    WHERE m.id = v_site_id
      AND (s->>'label_en' = 'Project Card' OR s->>'label_ar' = 'بطاقة المشروع')
  ) THEN
    RAISE NOTICE 'Project Card section already exists in site_settings — skipping';
    RETURN;
  END IF;

  -- Snapshot all_projects fields → dropdown options.
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',       gen_random_uuid()::text,
      'value',    f->>'name',
      'label_ar', COALESCE(f->>'label_ar', f->>'name'),
      'label_en', COALESCE(f->>'label_en', f->>'label_ar', f->>'name')
    )
    ORDER BY (f->>'order')::int
  )
  INTO v_field_options
  FROM models m,
       jsonb_array_elements(m.schema->'sections') sec,
       jsonb_array_elements(sec->'fields') f
  WHERE m.id = v_proj_model_id
    AND f->>'type' NOT IN ('section_mirror', 'mirror', 'notes', 'assignee', 'section_selector');

  IF v_field_options IS NULL THEN v_field_options := '[]'::jsonb; END IF;

  UPDATE models
  SET schema = jsonb_set(
    schema,
    '{sections}',
    (schema->'sections') || jsonb_build_array(jsonb_build_object(
      'id',        v_section_id,
      'label_ar',  'بطاقة المشروع',
      'label_en',  'Project Card',
      'order',     jsonb_array_length(schema->'sections'),
      'is_base',   false,
      'color',     '#B8734F',
      'fields',    jsonb_build_array(
        jsonb_build_object(
          'id',             v_image_id,
          'name',           'proj_card_image_field',
          'label_ar',       'حقل صورة المشروع',
          'label_en',       'Image Field',
          'type',           'dropdown',
          'required',       false,
          'order',          0,
          'section_id',     v_section_id,
          'width',          'full',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_title_id,
          'name',           'proj_card_title_field',
          'label_ar',       'حقل العنوان',
          'label_en',       'Title Field',
          'type',           'dropdown',
          'required',       false,
          'order',          1,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_subtitle_id,
          'name',           'proj_card_subtitle_field',
          'label_ar',       'حقل العنوان الفرعي',
          'label_en',       'Subtitle Field',
          'type',           'dropdown',
          'required',       false,
          'order',          2,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_status_id,
          'name',           'proj_card_status_field',
          'label_ar',       'حقل حالة المشروع',
          'label_en',       'Status Field',
          'type',           'dropdown',
          'required',       false,
          'order',          3,
          'section_id',     v_section_id,
          'width',          'full',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_chip1_id,
          'name',           'proj_card_chip1_field',
          'label_ar',       'الشريحة الأولى',
          'label_en',       'Chip 1',
          'type',           'dropdown',
          'required',       false,
          'order',          4,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_chip2_id,
          'name',           'proj_card_chip2_field',
          'label_ar',       'الشريحة الثانية',
          'label_en',       'Chip 2',
          'type',           'dropdown',
          'required',       false,
          'order',          5,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_price_id,
          'name',           'proj_card_price_field',
          'label_ar',       'حقل السعر',
          'label_en',       'Price Field',
          'type',           'dropdown',
          'required',       false,
          'order',          6,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_cta_id,
          'name',           'proj_card_cta_url_field',
          'label_ar',       'رابط زر "عرض المشروع"',
          'label_en',       'CTA URL Field',
          'type',           'dropdown',
          'required',       false,
          'order',          7,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        )
      )
    ))
  ),
  updated_at = NOW()
  WHERE id = v_site_id;
END $$;

COMMIT;
