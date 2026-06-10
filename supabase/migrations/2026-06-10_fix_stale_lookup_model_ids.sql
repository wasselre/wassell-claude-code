-- 2026-06-10: Repoint stale lookup_model_id references in three seeded
-- custom-UI models to their real live target models.
--
-- Root cause (see memory reference-seed-backfill-broken-lookups): seed model
-- ids are uuid() generated per page-load, so the frontend seed-backfill upserted
-- these models into prod with a STALE target-model id baked into the lookup
-- field. The target model id never existed in prod, so the field can't resolve
-- its target (broken record picker / unresolved lookup).
--
-- A live scan (every type='lookup' field vs models.id) found exactly these 3
-- broken; all others resolve correctly:
--   copywriter_chats.linked_project_id : 5229e15f-... -> all_projects 220c49b9-...
--   ai_chats.linked_client_id          : 7762d8db-... -> clients      2e86f197-...
--   chats.client_link                  : 756eae3c-... -> clients      2e86f197-...
-- (phone_calls.client_link is the same seed field but already correct.)
--
-- Only lookup_model_id is changed; lookup_display_field ('name'/'project_name')
-- is left as the seed defines it. seedModels.ts needs NO change — it references
-- the seed-const ids (correct for fresh installs); this only heals prod rows.
-- The by-name backfill / refreshSystemModels never overwrite an existing model,
-- so this fix sticks. Idempotent: each UPDATE only fires while the stale id is
-- still present, and the schema is rebuilt preserving section/field order.

-- copywriter_chats.linked_project_id -> all_projects
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(
    CASE WHEN sec ? 'fields' THEN jsonb_set(sec, '{fields}', (
      SELECT jsonb_agg(
        CASE WHEN f->>'name' = 'linked_project_id'
              AND f->>'lookup_model_id' = '5229e15f-afd9-49a1-aa4f-7f2a43525025'
             THEN jsonb_set(f, '{lookup_model_id}', '"220c49b9-de57-492d-9eca-c0d9f54fd40f"'::jsonb)
             ELSE f END
        ORDER BY fo)
      FROM jsonb_array_elements(sec->'fields') WITH ORDINALITY AS af(f, fo)
    )) ELSE sec END
    ORDER BY so)
  FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS asx(sec, so)
))
WHERE m.name = 'copywriter_chats'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
              WHERE f->>'name' = 'linked_project_id' AND f->>'lookup_model_id' = '5229e15f-afd9-49a1-aa4f-7f2a43525025');

-- ai_chats.linked_client_id -> clients
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(
    CASE WHEN sec ? 'fields' THEN jsonb_set(sec, '{fields}', (
      SELECT jsonb_agg(
        CASE WHEN f->>'name' = 'linked_client_id'
              AND f->>'lookup_model_id' = '7762d8db-4e9d-4a61-8f8c-40bbd9b3ef33'
             THEN jsonb_set(f, '{lookup_model_id}', '"2e86f197-385f-4853-908f-b4cb7237f7d8"'::jsonb)
             ELSE f END
        ORDER BY fo)
      FROM jsonb_array_elements(sec->'fields') WITH ORDINALITY AS af(f, fo)
    )) ELSE sec END
    ORDER BY so)
  FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS asx(sec, so)
))
WHERE m.name = 'ai_chats'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
              WHERE f->>'name' = 'linked_client_id' AND f->>'lookup_model_id' = '7762d8db-4e9d-4a61-8f8c-40bbd9b3ef33');

-- chats.client_link -> clients
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(
    CASE WHEN sec ? 'fields' THEN jsonb_set(sec, '{fields}', (
      SELECT jsonb_agg(
        CASE WHEN f->>'name' = 'client_link'
              AND f->>'lookup_model_id' = '756eae3c-42a3-42c2-8227-09958ee22537'
             THEN jsonb_set(f, '{lookup_model_id}', '"2e86f197-385f-4853-908f-b4cb7237f7d8"'::jsonb)
             ELSE f END
        ORDER BY fo)
      FROM jsonb_array_elements(sec->'fields') WITH ORDINALITY AS af(f, fo)
    )) ELSE sec END
    ORDER BY so)
  FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS asx(sec, so)
))
WHERE m.name = 'chats'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
              WHERE f->>'name' = 'client_link' AND f->>'lookup_model_id' = '756eae3c-42a3-42c2-8227-09958ee22537');
