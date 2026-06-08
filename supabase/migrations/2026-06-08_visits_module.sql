-- 2026-06-08  Visit module enhancements
-- ---------------------------------------------------------------------------
-- `visits` is a NON-FROZEN builder model — its schema lives as JSONB in
-- public.models. This migration brings the PROD model row in line with the
-- seed (src/data/seedModels.ts) for the Visit-module feature work:
--
--   1. Client lookup display: 'client_code' did NOT exist on the clients model
--      (so the cell fell back to a truncated record UUID) → repoint to
--      'client_id' (the clients auto-ID, populated on 82/82 rows).
--   2. Phone field: keep the live "find client by phone" auto-link, but DEFER
--      the create-if-missing to the form Save commit (auto_link_create_timing
--      = 'on_save') and copy the typed name into the new client (client_name).
--   3. scheduled_datetime → default to now; sales_representative → default to
--      the signed-in user (default_dynamic, applied by useFieldDefaults).
--   4. Add the new `units` field (type 'unit_picker', multi): a project→unit
--      cascade that stores the selected unit id(s). Project step is a filter
--      only (All Projects that own units); units render as cards.
--
-- The standalone `project_id` (→ Our Projects) field is intentionally LEFT
-- UNCHANGED. The models_view_sync trigger regenerates v_visits automatically
-- on UPDATE; `unit_picker` falls through to a text column there (harmless).
-- visits is NOT frozen, so no freeze-artifact / unified_records rebuild.
-- Re-runnable: the field patches are overwrites; the `units` append is guarded.
-- ---------------------------------------------------------------------------

BEGIN;

-- (1)–(3): patch existing fields in place, matched by name (order-independent).
-- sales_representative / visit_notes are bumped to order 6 / 7 so the new
-- `units` field (order 5) slots in right after project_id (order 4).
UPDATE public.models
SET schema = jsonb_set(
  schema,
  '{sections,0,fields}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN f->>'name' = 'client_id'
          THEN f || jsonb_build_object('lookup_display_field', 'client_id')
        WHEN f->>'name' = 'phone'
          THEN f || jsonb_build_object(
            'auto_link_create_if_missing', true,
            'auto_link_create_timing', 'on_save',
            'auto_link_create_min_length', 9,
            'auto_link_create_copy_fields',
              jsonb_build_array(jsonb_build_object('from', 'name', 'to', 'client_name'))
          )
        WHEN f->>'name' = 'scheduled_datetime'
          THEN f || jsonb_build_object('default_dynamic', 'now')
        WHEN f->>'name' = 'sales_representative'
          THEN f || jsonb_build_object('default_dynamic', 'current_user', 'order', 6)
        WHEN f->>'name' = 'visit_notes'
          THEN f || jsonb_build_object('order', 7)
        ELSE f
      END
      ORDER BY (f->>'order')::int
    )
    FROM jsonb_array_elements(schema->'sections'->0->'fields') f
  )
)
WHERE name = 'visits';

-- (4): append the new `units` field (idempotent — skip if already present).
UPDATE public.models
SET schema = jsonb_set(
  schema,
  '{sections,0,fields}',
  (schema->'sections'->0->'fields') || jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'units',
    'label_ar', 'الوحدات',
    'label_en', 'Units',
    'type', 'unit_picker',
    'required', false,
    'order', 5,
    'section_id', (schema->'sections'->0->>'id'),
    'width', 'half',
    'show_in_table', true,
    'is_multi', true,
    -- units model id (prod). Project model is derived from this field's lookup.
    'unit_picker_unit_model_id', '7ca3014d-f658-418e-9c53-2d279c97f009',
    'unit_picker_project_link_field', 'project_id'
  )
)
WHERE name = 'visits'
  AND NOT (schema->'sections'->0->'fields' @> '[{"name": "units"}]'::jsonb);

COMMIT;
