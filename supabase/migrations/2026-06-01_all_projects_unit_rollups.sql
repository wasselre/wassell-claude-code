-- ============================================================================
-- all_projects: cross-record rollups computed from the units model.
--
-- Eleven read-only fields on `all_projects` (the "تفاصيل المشروع" / Project
-- Details section) are computed live at READ time from `units` rows that point
-- DIRECTLY at the project — an all_projects record IS the master the units
-- reference, so the match is:
--
--     units.data.project_id   ===   all_projects.id      (no lookup hop)
--
-- (our_projects, by contrast, hops through its `project` lookup — see
-- supabase/migrations/2026-05-23_our_projects_unit_rollups.sql.)
--
-- The frontend compute lives in src/lib/ourProjectsRollup.ts
-- (`applyProjectRollups` dispatches by model name). This migration just stamps
-- the model SCHEMA so the eleven fields carry `is_computed: true` +
-- `computed_kind: <one of eleven>` — which makes the permission resolver force
-- them readonly, the form render them display-only, and saveRecord strip them
-- before persist. It ALSO converts the three per-meter fields from `formula`
-- to `currency`: a per-record formula cannot aggregate across child units, so
-- those fields never worked as formulas — the rollup is their real source.
--
-- Targets the LIVE production schema as observed via the Supabase MCP on
-- 2026-06-01. All eleven slugs already exist in the all_projects schema; this
-- migration patches them in place by slug (in whatever section they live) and
-- raises a NOTICE if any expected slug is missing rather than creating a
-- duplicate.
--
-- Idempotent. Safe to re-run. Never mutates record DATA, only model SCHEMA.
-- The models_view_sync trigger regenerates v_all_projects automatically on the
-- schema UPDATE (range -> _min/_max, currency/number -> numeric).
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_model_id     uuid;
  v_schema       jsonb;
  v_new_sections jsonb;
  v_new_fields   jsonb;
  v_sec          jsonb;
  v_field        jsonb;
  v_found        boolean;
  v_missing      text := '';
  rec            record;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema FROM models WHERE name = 'all_projects';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'all_projects model not found — skipping rollup migration';
    RETURN;
  END IF;

  -- One row per rollup target.
  --   slug          — field's `name` in the JSONB schema (live production slug)
  --   kind          — `computed_kind` (matches OurProjectsComputedKind in src/types/index.ts)
  --   field_type    — canonical type to enforce (also fixes the formula→currency conversion)
  --   range_unit_ar / range_unit_en — only for the two priced/area ranges; null otherwise
  FOR rec IN
    SELECT * FROM (VALUES
      ('unit_count',            'units_count',            'number',   NULL::text, NULL::text),
      ('available_units',       'units_available_count',  'number',   NULL,       NULL),
      ('sold_units',            'units_sold_count',       'number',   NULL,       NULL),
      ('reserved_units',        'units_reserved_count',   'number',   NULL,       NULL),
      ('price_range',           'price_range',            'range',    'ر.س',     'SAR'),
      ('area_range',            'area_range',             'range',    'م²',      'm²'),
      ('bedroom_range',         'bedroom_range',          'range',    NULL,       NULL),
      ('bathroom_range',        'bathroom_range',         'range',    NULL,       NULL),
      ('avg_min_price_per_m2',  'min_price_per_meter',    'currency', NULL,       NULL),
      ('avg_max_price_per_m2',  'max_price_per_meter',    'currency', NULL,       NULL),
      ('avg_price_per_m2',      'avg_price_per_meter',    'currency', NULL,       NULL)
    ) AS t(slug, kind, field_type, range_unit_ar, range_unit_en)
  LOOP
    v_found := false;
    v_new_sections := '[]'::jsonb;

    -- Walk every section, rebuild it, patching the target field where found.
    FOR v_sec IN SELECT * FROM jsonb_array_elements(v_schema->'sections')
    LOOP
      v_new_fields := '[]'::jsonb;
      FOR v_field IN SELECT * FROM jsonb_array_elements(COALESCE(v_sec->'fields', '[]'::jsonb))
      LOOP
        IF v_field->>'name' = rec.slug THEN
          v_found := true;
          -- Merge: enforce canonical type, stamp the rollup flags. All other
          -- props (id, labels, order, width, section_id, show_in_table, …) are
          -- preserved. A leftover `formula` expression on a now-currency field
          -- is inert (the formula engine only evaluates type='formula').
          v_field := v_field || jsonb_build_object(
            'type',          rec.field_type,
            'is_computed',   true,
            'computed_kind', rec.kind
          );
          IF rec.range_unit_ar IS NOT NULL THEN
            v_field := v_field || jsonb_build_object(
              'range_unit_ar', rec.range_unit_ar,
              'range_unit_en', rec.range_unit_en
            );
          END IF;
        END IF;
        v_new_fields := v_new_fields || jsonb_build_array(v_field);
      END LOOP;
      v_sec := jsonb_set(v_sec, '{fields}', v_new_fields);
      v_new_sections := v_new_sections || jsonb_build_array(v_sec);
    END LOOP;

    v_schema := jsonb_set(v_schema, '{sections}', v_new_sections);

    IF NOT v_found THEN
      v_missing := v_missing || rec.slug || ' ';
    END IF;
  END LOOP;

  UPDATE models
  SET schema     = v_schema,
      updated_at = NOW()
  WHERE id = v_model_id;

  IF length(v_missing) > 0 THEN
    RAISE NOTICE 'all_projects rollup: these expected slugs were NOT found and were not stamped: %', v_missing;
  END IF;
END $$;

COMMIT;
