-- Flip the `icon` columns on the `project_details` model's `features`
-- and `landmarks` table fields from `dropdown` (curated slug) to
-- `image_icon` (URL pointing at a PNG in `marketing-assets/icons/...`).
--
-- The new column type renders inline thumbnails in the CRM and opens
-- a Library + Generate picker modal on click. Storage shape is one
-- string field — library icons and AI-generated icons share the same
-- column with no discriminator.
--
-- Existing rows keep their slug values (`"building"`, `"metro"`, …)
-- until the next save. The frontend transparently resolves legacy
-- slugs to library URLs at render time (see resolveSlugToLibraryUrl
-- in src/data/iconLibrary.ts), so this migration deliberately does
-- NOT rewrite the records data — that happens lazily on the next
-- edit of each row.
--
-- Idempotent. Re-running is a no-op once the column types are
-- already `image_icon`.

BEGIN;

WITH new_schemas AS (
  SELECT
    m.id,
    jsonb_set(
      m.schema,
      '{sections}',
      (
        SELECT jsonb_agg(
          jsonb_set(
            sec,
            '{fields}',
            (
              SELECT jsonb_agg(
                CASE
                  -- features table → flip the `icon` column inside table_columns
                  WHEN f->>'name' IN ('features', 'landmarks')
                       AND f->>'type' = 'table'
                  THEN jsonb_set(
                    f,
                    '{table_columns}',
                    (
                      SELECT jsonb_agg(
                        CASE
                          WHEN c->>'name' = 'icon' AND c->>'type' = 'dropdown'
                          THEN (c - 'options') || jsonb_build_object('type', 'image_icon')
                          ELSE c
                        END
                      )
                      FROM jsonb_array_elements(f->'table_columns') c
                    )
                  )
                  ELSE f
                END
              )
              FROM jsonb_array_elements(sec->'fields') f
            )
          )
        )
        FROM jsonb_array_elements(m.schema->'sections') sec
      )
    ) AS new_schema
  FROM models m
  WHERE m.name = 'project_details'
)
UPDATE models m
SET schema = ns.new_schema,
    updated_at = now()
FROM new_schemas ns
WHERE m.id = ns.id
  AND m.schema IS DISTINCT FROM ns.new_schema;

-- The per-model auto-view trigger (`models_view_sync`) regenerates
-- `v_project_details` automatically on this UPDATE. No manual
-- regenerate_model_view call needed — the table-column-type change
-- doesn't affect the view's column projection anyway (table fields
-- always land as jsonb regardless of inner column types).

COMMIT;
