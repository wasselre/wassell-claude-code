-- 2026-08-31  Add a Units field to the Appointments model
-- ---------------------------------------------------------------------------
-- Reps want to record WHICH units an appointment is about — chosen after the
-- appointment's project. `appointments` is a NON-FROZEN builder model (schema
-- as JSONB in public.models), so we patch models.schema in place. Mirrors the
-- visits-module precedent (2026-06-08_visits_module.sql):
--
--   1. Bump sales_rep / appointment_status / notes down one slot so the new
--      `units` field (order 6) slots in right after project_id (order 5).
--   2. Append `units` (type 'unit_picker', multi): a project→unit cascade that
--      stores the selected unit id(s). `unit_picker_project_from_field` is set
--      to the appointment's own `project_id`, so the picker lands directly on
--      that project's units — the user selects units "after selecting a
--      project" with no redundant re-pick (still allows browsing other
--      projects). Project step within the picker is a filter only, never stored.
--
-- The models_view_sync trigger regenerates v_appointments automatically on
-- UPDATE; `unit_picker` falls through to a text column there (harmless).
-- appointments is NOT frozen, so no freeze-artifact / unified_records rebuild.
-- Re-runnable: the order bumps are overwrites; the `units` append is guarded.
-- ---------------------------------------------------------------------------

BEGIN;

-- (1): bump the trailing scalar fields down one slot (order-independent, by name).
UPDATE public.models
SET schema = jsonb_set(
  schema,
  '{sections,0,fields}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN f->>'name' = 'sales_rep'          THEN f || jsonb_build_object('order', 7)
        WHEN f->>'name' = 'appointment_status' THEN f || jsonb_build_object('order', 8)
        WHEN f->>'name' = 'notes'              THEN f || jsonb_build_object('order', 9)
        ELSE f
      END
      ORDER BY (f->>'order')::int
    )
    FROM jsonb_array_elements(schema->'sections'->0->'fields') f
  )
)
WHERE name = 'appointments';

-- (2): append the new `units` field (idempotent — skip if already present).
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
    'order', 6,
    'section_id', (schema->'sections'->0->>'id'),
    'width', 'full',
    'show_in_table', true,
    'is_multi', true,
    -- units model id (prod). Project model is derived from this field's lookup.
    'unit_picker_unit_model_id', '7ca3014d-f658-418e-9c53-2d279c97f009',
    'unit_picker_project_link_field', 'project_id',
    -- land the picker on the appointment's own selected project.
    'unit_picker_project_from_field', 'project_id'
  )
)
WHERE name = 'appointments'
  AND NOT (schema->'sections'->0->'fields' @> '[{"name": "units"}]'::jsonb);

COMMIT;
