-- ============================================================================
-- Wassel decks — add a `size` dropdown field to the existing `decks` model
-- row in the `models` table so the brief form can render a slide-size
-- selector (16:9 / 9:16 / 4:3 / 1:1).
--
-- The field is appended to the base section. Order numbers of subsequent
-- fields (filename / file_url / file_path / anthropic_file_id /
-- error_message) are bumped by 1 to keep the seed-and-DB shapes aligned.
--
-- Idempotent: only runs the update if no field with `name = 'size'` is
-- already present. Safe to re-apply against an already-migrated row.
--
-- Frontend mirror: `healDecksSchema()` in src/lib/schemaMigrations.ts
-- performs the equivalent client-side patch on every initialize() —
-- this migration is the canonical server-side source of truth.
-- ============================================================================

BEGIN;

UPDATE models
SET
  schema = jsonb_set(
    -- Bump existing field orders >= 5 by 1 so the new size field can slot
    -- between model_used (order=4) and filename (was order=5, now 6).
    jsonb_set(
      schema,
      '{sections,0,fields}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN (f->>'order')::int >= 5
            THEN jsonb_set(f, '{order}', to_jsonb(((f->>'order')::int) + 1))
            ELSE f
          END
        )
        FROM jsonb_array_elements(schema->'sections'->0->'fields') AS f
      )
    ),
    '{sections,0,fields}',
    -- Append the new size dropdown.
    (schema->'sections'->0->'fields') || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', 'size',
      'label_ar', 'الحجم',
      'label_en', 'Size',
      'type', 'dropdown',
      'order', 5,
      'width', 'third',
      'required', false,
      'section_id', schema->'sections'->0->>'id',
      'show_in_table', false,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', '16:9', 'label_ar', '١٦:٩ (أفقي)', 'label_en', '16:9 (Widescreen)'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', '9:16', 'label_ar', '٩:١٦ (رأسي)', 'label_en', '9:16 (Vertical)'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', '4:3',  'label_ar', '٤:٣ (قياسي)', 'label_en', '4:3 (Standard)'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', '1:1',  'label_ar', '١:١ (مربع)', 'label_en', '1:1 (Square)')
      )
    ))
  ),
  updated_at = now()
WHERE name = 'decks'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(schema->'sections'->0->'fields') AS f
    WHERE f->>'name' = 'size'
  );

COMMIT;
