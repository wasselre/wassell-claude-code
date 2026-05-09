-- ============================================================================
-- Site settings — Map Card field selectors.
--
-- Adds a new "بطاقة الخريطة / Map Card" section to the site_settings model
-- with 6 dropdown fields the admin uses to choose which all_projects field
-- populates each slot in the public website's map info-window card:
--
--   card_status_field   — status pill (override, defaults to maps_config.popup_badge)
--   card_chip1_field    — first chip in the 3-stat grid
--   card_chip2_field    — second chip
--   card_chip3_field    — third chip
--   card_price_field    — footer price block
--   card_cta_url_field  — destination of the "فتح السجل" CTA pill
--
-- Each dropdown's options are SNAPSHOTTED from all_projects' current schema
-- at migration time (skipping mirror / section_mirror / notes / assignee /
-- section_selector — none of those make sense in a public card). If
-- all_projects gets new fields later the admin can refresh the option list
-- via the Builder, or re-run a refresh migration.
--
-- Empty selections fall back to the website's existing heuristics
-- (first three popup_shown_field_ids → chips, label-match → price, first
-- URL field → CTA), so the migration is non-breaking.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_site_id            uuid;
  v_proj_model_id      uuid;
  v_section_id         text := gen_random_uuid()::text;
  v_field_options      jsonb;
  v_status_id          text := gen_random_uuid()::text;
  v_chip1_id           text := gen_random_uuid()::text;
  v_chip2_id           text := gen_random_uuid()::text;
  v_chip3_id           text := gen_random_uuid()::text;
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
      AND (s->>'label_en' = 'Map Card' OR s->>'label_ar' = 'بطاقة الخريطة')
  ) THEN
    RAISE NOTICE 'Map Card section already exists in site_settings — skipping';
    RETURN;
  END IF;

  -- Snapshot all_projects fields → dropdown options. Skip field types that
  -- don't render meaningful values in a public card.
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
      'label_ar',  'بطاقة الخريطة',
      'label_en',  'Map Card',
      'order',     jsonb_array_length(schema->'sections'),
      'is_base',   false,
      'color',     '#B8734F',
      'fields',    jsonb_build_array(
        jsonb_build_object(
          'id',             v_status_id,
          'name',           'card_status_field',
          'label_ar',       'حقل حالة المشروع (اختياري)',
          'label_en',       'Status Field (optional)',
          'type',           'dropdown',
          'required',       false,
          'order',          0,
          'section_id',     v_section_id,
          'width',          'full',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_chip1_id,
          'name',           'card_chip1_field',
          'label_ar',       'الشريحة الأولى — حقل المساحة',
          'label_en',       'Chip 1 — Area',
          'type',           'dropdown',
          'required',       false,
          'order',          1,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_chip2_id,
          'name',           'card_chip2_field',
          'label_ar',       'الشريحة الثانية — حقل الوحدات',
          'label_en',       'Chip 2 — Units',
          'type',           'dropdown',
          'required',       false,
          'order',          2,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_chip3_id,
          'name',           'card_chip3_field',
          'label_ar',       'الشريحة الثالثة — حقل المرحلة',
          'label_en',       'Chip 3 — Phase',
          'type',           'dropdown',
          'required',       false,
          'order',          3,
          'section_id',     v_section_id,
          'width',          'full',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_price_id,
          'name',           'card_price_field',
          'label_ar',       'حقل السعر (في الذيل)',
          'label_en',       'Price Field (footer)',
          'type',           'dropdown',
          'required',       false,
          'order',          4,
          'section_id',     v_section_id,
          'width',          'half',
          'show_in_table',  false,
          'options',        v_field_options
        ),
        jsonb_build_object(
          'id',             v_cta_id,
          'name',           'card_cta_url_field',
          'label_ar',       'رابط زر "فتح السجل"',
          'label_en',       'CTA URL Field',
          'type',           'dropdown',
          'required',       false,
          'order',          5,
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
