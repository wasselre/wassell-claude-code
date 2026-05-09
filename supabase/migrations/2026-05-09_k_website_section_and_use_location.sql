-- ============================================================================
-- Website integration — corrective migration following 2026-05-09_j.
--
-- Three structural changes to all_projects, per user feedback:
--
-- 1. The `location_url` field that 2026-05-09_j added is dropped. The
--    website map now resolves locations from the EXISTING "موقع المشروع"
--    URL field already in the "المعلومات الجغرافية" section (admin-created
--    long before this work — field name is auto-generated, so we match by
--    Arabic label).
--
-- 2. `maps_config.location_url_field_id` is repointed to that existing
--    field. The CRM Maps view + the public website map both pick up the
--    change automatically since both read maps_config to find the URL field
--    at runtime.
--
-- 3. `image_url` and `is_public` move out of the base "معلومات المشروع"
--    section into a NEW non-base section called "إعدادات الموقع" / "Website
--    Settings". Keeps the website-only knobs visually grouped in the form.
--
-- The migration is idempotent and only mutates the all_projects schema +
-- its maps_config. Project records are NOT touched — the only field being
-- removed (`location_url`) was added two minutes earlier in 2026-05-09_j
-- and no project has ever had a value in it.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_model_id              uuid;
  v_schema                jsonb;
  v_website_section_id    text;
  v_location_field_id     text;
  v_image_field           jsonb;
  v_public_field          jsonb;
  v_existing_website_section jsonb;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema FROM models WHERE name = 'all_projects';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'all_projects model not found — skipping';
    RETURN;
  END IF;

  -- Find the existing "موقع المشروع" URL field. The user's prod model has
  -- been customized in the Builder so field names are auto-generated like
  -- `item_mo4jwh68`. We match by Arabic label since that's stable.
  SELECT field->>'id' INTO v_location_field_id
  FROM jsonb_array_elements(v_schema->'sections') sec,
       jsonb_array_elements(sec->'fields') field
  WHERE field->>'label_ar' = 'موقع المشروع'
    AND field->>'type' = 'url'
  LIMIT 1;

  -- Fall back: any URL field whose Arabic label contains "موقع" — covers
  -- minor label edits like "موقع المشروع على الخريطة".
  IF v_location_field_id IS NULL THEN
    SELECT field->>'id' INTO v_location_field_id
    FROM jsonb_array_elements(v_schema->'sections') sec,
         jsonb_array_elements(sec->'fields') field
    WHERE field->>'label_ar' LIKE '%موقع%'
      AND field->>'type' = 'url'
      AND field->>'name' <> 'location_url'  -- exclude the one 2026-05-09_j added
    LIMIT 1;
  END IF;

  IF v_location_field_id IS NULL THEN
    RAISE EXCEPTION 'Could not find existing location URL field (looked for label_ar = "موقع المشروع")';
  END IF;

  -- Reuse a Website Settings section if one already exists (idempotent rerun).
  SELECT s INTO v_existing_website_section
  FROM jsonb_array_elements(v_schema->'sections') s
  WHERE s->>'label_en' = 'Website Settings' OR s->>'label_ar' = 'إعدادات الموقع';

  IF v_existing_website_section IS NOT NULL THEN
    v_website_section_id := v_existing_website_section->>'id';
  ELSE
    v_website_section_id := gen_random_uuid()::text;
  END IF;

  -- Pluck image_url + is_public from wherever they currently live so we can
  -- rehome them in the new section. Re-stamp section_id + order.
  SELECT field || jsonb_build_object('section_id', v_website_section_id, 'order', 0, 'width', 'full', 'show_in_table', false)
  INTO v_image_field
  FROM jsonb_array_elements(v_schema->'sections') sec,
       jsonb_array_elements(sec->'fields') field
  WHERE field->>'name' = 'image_url'
  LIMIT 1;

  SELECT field || jsonb_build_object('section_id', v_website_section_id, 'order', 1, 'width', 'half', 'show_in_table', true)
  INTO v_public_field
  FROM jsonb_array_elements(v_schema->'sections') sec,
       jsonb_array_elements(sec->'fields') field
  WHERE field->>'name' = 'is_public'
  LIMIT 1;

  -- Mint replacements if either is missing entirely.
  IF v_image_field IS NULL THEN
    v_image_field := jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', 'image_url',
      'label_ar', 'صورة المشروع',
      'label_en', 'Project Image',
      'type', 'url',
      'required', false,
      'order', 0,
      'section_id', v_website_section_id,
      'width', 'full',
      'show_in_table', false
    );
  END IF;

  IF v_public_field IS NULL THEN
    v_public_field := jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', 'is_public',
      'label_ar', 'عرض على الموقع',
      'label_en', 'Show on Website',
      'type', 'checkbox',
      'required', false,
      'order', 1,
      'section_id', v_website_section_id,
      'width', 'half',
      'show_in_table', true
    );
  END IF;

  -- Strip image_url + is_public + location_url from EVERY existing section.
  -- The new Website Settings section will be added/replaced fresh below.
  WITH cleaned_sections AS (
    SELECT jsonb_agg(
      CASE
        WHEN s->>'id' = v_website_section_id THEN s  -- handled separately below
        ELSE s || jsonb_build_object(
          'fields',
          COALESCE((
            SELECT jsonb_agg(f ORDER BY (f->>'order')::int)
            FROM jsonb_array_elements(s->'fields') f
            WHERE f->>'name' NOT IN ('image_url', 'is_public', 'location_url')
          ), '[]'::jsonb)
        )
      END
      ORDER BY (s->>'order')::int
    ) AS sections
    FROM jsonb_array_elements(v_schema->'sections') s
  )
  SELECT jsonb_set(v_schema, '{sections}', sections) INTO v_schema FROM cleaned_sections;

  -- Append (or replace) the Website Settings section.
  IF v_existing_website_section IS NULL THEN
    v_schema := jsonb_set(
      v_schema,
      '{sections}',
      (v_schema->'sections') || jsonb_build_array(jsonb_build_object(
        'id', v_website_section_id,
        'label_ar', 'إعدادات الموقع',
        'label_en', 'Website Settings',
        'order', jsonb_array_length(v_schema->'sections'),
        'is_base', false,
        'color', '#B8734F',
        'fields', jsonb_build_array(v_image_field, v_public_field)
      ))
    );
  ELSE
    v_schema := jsonb_set(
      v_schema,
      '{sections}',
      (
        SELECT jsonb_agg(
          CASE WHEN s->>'id' = v_website_section_id
            THEN s || jsonb_build_object(
              'is_base', false,
              'fields', jsonb_build_array(v_image_field, v_public_field)
            )
            ELSE s
          END
          ORDER BY (s->>'order')::int
        )
        FROM jsonb_array_elements(v_schema->'sections') s
      )
    );
  END IF;

  -- Commit schema + repoint maps_config to the existing location URL field.
  -- Other maps_config keys (popup_title, pin_color, etc.) stay as set by
  -- 2026-05-09_j or whatever the admin has tuned in MapsBuilder.
  UPDATE models
  SET schema = v_schema,
      maps_config = COALESCE(maps_config, '{}'::jsonb)
        || jsonb_build_object('location_url_field_id', v_location_field_id),
      updated_at = NOW()
  WHERE id = v_model_id;
END $$;

COMMIT;
