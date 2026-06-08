-- Add a `project_id` lookup field (→ all_projects) to the chat_templates
-- model schema, so AI-generated project message templates carry a real,
-- Builder-visible link back to the master project they were built from.
--
-- chat_templates is an UNFROZEN model (JSONB rows in `records`), so its schema
-- lives in the `models` table. Adding the field is a JSONB append on that row;
-- the `models_view_sync` trigger regenerates `v_chat_templates` automatically.
-- The generator already writes `data.project_id` regardless of this migration —
-- running it just surfaces the field in the Builder + the per-model view + the
-- generated PRD.
--
-- Idempotent: the WHERE guard skips the row if a `project_id` field already
-- exists, so re-running is a no-op.

BEGIN;

UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'project_id',
        'label_ar', 'المشروع',
        'label_en', 'Project',
        'type', 'lookup',
        'required', false,
        'order', 10,
        'section_id', (schema->'sections'->0->>'id'),
        'width', 'half',
        'show_in_table', true,
        'lookup_model_id', (SELECT id::text FROM public.models WHERE name = 'all_projects'),
        'lookup_display_field', 'project_name'
      )
    ),
    updated_at = now()
WHERE name = 'chat_templates'
  AND NOT ((schema->'sections'->0->'fields') @> '[{"name":"project_id"}]'::jsonb);

COMMIT;
