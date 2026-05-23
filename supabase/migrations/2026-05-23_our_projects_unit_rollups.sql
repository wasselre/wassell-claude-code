-- ============================================================================
-- our_projects: cross-record rollups computed from the units model.
--
-- Eleven read-only fields on `our_projects` are computed live at READ time from
-- `units` rows linked via the all_projects pivot:
--
--     our_projects.data.project   →   all_projects.id   ←   units.data.project_id
--
-- The frontend compute lives in src/lib/ourProjectsRollup.ts. This migration
-- just makes the model's schema HOLD the field definitions, each stamped with
-- two new JSONB keys — `is_computed: true` and `computed_kind: <one of eleven>`
-- — so the permission resolver forces them readonly, the form renders them as
-- display-only, and saveRecord strips them before persist.
--
-- Targets the LIVE production schema as observed via the Supabase MCP on
-- 2026-05-23:
--   - our_projects has 4 sections; the "Project Details" section we want is
--     identified by label `تفاصيل المشروع` / `Project Details`
--   - units already has `bedrooms`, `bathrooms`, `unit_status`, `unit_area`,
--     `total_price`, and `project_id` — nothing to add
--   - our_projects already has the `project` lookup at section 0 — nothing
--     to add
--
-- Idempotent. Safe to re-run. Never mutates record DATA, only model SCHEMA.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_model_id       uuid;
  v_schema         jsonb;
  v_section_id     text;
  v_section_idx    int;
  v_fields         jsonb;
  v_field          jsonb;
  v_field_idx      int;
  v_max_order      numeric := 0;
  rec              record;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema FROM models WHERE name = 'our_projects';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'our_projects model not found — skipping rollup migration';
    RETURN;
  END IF;

  -- Find the "Project Details" section by label (ar or en). Falls back to the
  -- last section if not found, then to section 0 — admin can move fields later.
  SELECT (ord - 1) INTO v_section_idx
  FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY AS arr(s, ord)
  WHERE s->>'label_ar' = 'تفاصيل المشروع'
     OR s->>'label_en' = 'Project Details'
  LIMIT 1;

  IF v_section_idx IS NULL THEN
    -- Last section fallback (matches the user's "in the project details section"
    -- intent when the label is missing — usually the last section is the
    -- "details" tail in their layouts).
    v_section_idx := jsonb_array_length(v_schema->'sections') - 1;
  END IF;

  IF v_section_idx IS NULL OR v_section_idx < 0 THEN
    RAISE EXCEPTION 'our_projects has no sections — cannot place rollup fields';
  END IF;

  v_section_id := v_schema->'sections'->v_section_idx->>'id';
  v_fields := COALESCE(v_schema->'sections'->v_section_idx->'fields', '[]'::jsonb);

  -- Capture current max order across ALL sections so newly-appended fields
  -- slot at the end. Avoids order collisions with sibling fields.
  SELECT COALESCE(MAX((f->>'order')::numeric), 0) INTO v_max_order
  FROM jsonb_array_elements(v_schema->'sections') sec,
       jsonb_array_elements(sec->'fields') f;

  -- Walk the eleven rollup targets.
  --   slug          — field's `name` in the JSONB schema
  --   kind          — `computed_kind` value (matches OurProjectsComputedKind in src/types/index.ts)
  --   field_type    — type to use when creating a fresh field
  --   label_ar/en   — labels when creating
  --   width         — width when creating
  --   show_table    — show_in_table when creating
  --   range_unit_ar / range_unit_en — only for `range` type; null otherwise
  FOR rec IN
    SELECT * FROM (VALUES
      ('total_units',           'units_count',            'number',   'عدد الوحدات',            'Units Count',           'half',  true,  NULL::text,  NULL::text),
      ('units_available',       'units_available_count',  'number',   'الوحدات المتاحة',         'Units Available',        'half',  true,  NULL,        NULL),
      ('sold_units',            'units_sold_count',       'number',   'الوحدات المباعة',         'Units Sold',             'half',  true,  NULL,        NULL),
      ('units_reserved',        'units_reserved_count',   'number',   'الوحدات المحجوزة',        'Units Reserved',         'half',  true,  NULL,        NULL),
      ('price_range',           'price_range',            'range',    'نطاق السعر',             'Price Range',            'half',  true,  'ر.س',      'SAR'),
      ('area_range',            'area_range',             'range',    'نطاق المساحة',           'Area Range',             'half',  true,  'م²',       'm²'),
      ('bedroom_range',         'bedroom_range',          'range',    'نطاق غرف النوم',          'Bedrooms Range',         'half',  false, NULL,        NULL),
      ('bathroom_range',        'bathroom_range',         'range',    'نطاق دورات المياه',       'Bathrooms Range',        'half',  false, NULL,        NULL),
      ('min_price_per_meter',   'min_price_per_meter',    'currency', 'أدنى متوسط لسعر المتر',   'Min Avg Price per m²',   'third', false, NULL,        NULL),
      ('max_price_per_meter',   'max_price_per_meter',    'currency', 'أعلى متوسط لسعر المتر',   'Max Avg Price per m²',   'third', false, NULL,        NULL),
      ('avg_price_per_meter',   'avg_price_per_meter',    'currency', 'متوسط سعر المتر',         'Avg Price per m²',       'third', false, NULL,        NULL)
    ) AS t(slug, kind, field_type, label_ar, label_en, width, show_table, range_unit_ar, range_unit_en)
  LOOP
    -- Look for an existing field with this slug IN THIS SECTION.
    SELECT (idx - 1) INTO v_field_idx
    FROM jsonb_array_elements(v_fields) WITH ORDINALITY AS arr(f, idx)
    WHERE f->>'name' = rec.slug
    LIMIT 1;

    IF v_field_idx IS NOT NULL THEN
      -- Patch in place: stamp is_computed + computed_kind. Don't disturb
      -- the user's label edits, width, order, or section_id.
      v_field := v_fields->v_field_idx;
      v_field := v_field
        || jsonb_build_object(
             'is_computed',   true,
             'computed_kind', rec.kind
           );
      v_fields := jsonb_set(v_fields, ARRAY[v_field_idx::text], v_field);
    ELSE
      -- Append a fresh field.
      v_max_order := v_max_order + 1;
      v_field := jsonb_build_object(
        'id',            gen_random_uuid()::text,
        'name',          rec.slug,
        'label_ar',      rec.label_ar,
        'label_en',      rec.label_en,
        'type',          rec.field_type,
        'required',      false,
        'order',         v_max_order,
        'section_id',    v_section_id,
        'width',         rec.width,
        'show_in_table', rec.show_table,
        'is_computed',   true,
        'computed_kind', rec.kind
      );
      -- Range fields get unit labels so the form renders "م²" / "ر.س".
      IF rec.range_unit_ar IS NOT NULL THEN
        v_field := v_field
          || jsonb_build_object('range_unit_ar', rec.range_unit_ar, 'range_unit_en', rec.range_unit_en);
      END IF;
      v_fields := v_fields || jsonb_build_array(v_field);
    END IF;
  END LOOP;

  -- Commit the patched fields back into the target section.
  v_schema := jsonb_set(
    v_schema,
    ARRAY['sections', v_section_idx::text, 'fields'],
    v_fields
  );

  UPDATE models
  SET schema     = v_schema,
      updated_at = NOW()
  WHERE id = v_model_id;
END $$;

COMMIT;
