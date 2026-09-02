-- Client retirement — Part 1: schema fields.
--
-- Adds three action-driven fields to the (unfrozen) `clients` model's JSONB
-- schema so the Builder/generic form know about them and the auto-generated
-- `v_clients` view exposes them as columns (the `models_view_sync` trigger
-- regenerates the view on this UPDATE). The fields are NEVER free-form-editable
-- — the app lists them in DERIVED_READONLY_SLUGS and writes them only through
-- the Retire / Un-retire action and the inbound-message auto-un-retire trigger.
--
--   is_retired      checkbox   — true ⇒ hidden from lists + every client count
--   retired_at      datetime   — when it was retired
--   retired_reason  text       — 'pre_aug_2026_bulk' | 'manual' | …
--
-- clients is unfrozen (JSONB in `records`), so this is a plain schema patch —
-- no frozen-table DDL / artifact regen. Idempotent: skips if is_retired exists.

UPDATE public.models m
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields')
        || jsonb_build_array(
             jsonb_build_object(
               'id', gen_random_uuid()::text,
               'name', 'is_retired',
               'label_ar', 'متقاعد',
               'label_en', 'Retired',
               'type', 'checkbox',
               'required', false,
               'order', 90,
               'section_id', (schema->'sections'->0->>'id'),
               'width', 'half',
               'show_in_table', false
             ),
             jsonb_build_object(
               'id', gen_random_uuid()::text,
               'name', 'retired_at',
               'label_ar', 'تاريخ التقاعد',
               'label_en', 'Retired At',
               'type', 'datetime',
               'required', false,
               'order', 91,
               'section_id', (schema->'sections'->0->>'id'),
               'width', 'half',
               'show_in_table', false
             ),
             jsonb_build_object(
               'id', gen_random_uuid()::text,
               'name', 'retired_reason',
               'label_ar', 'سبب التقاعد',
               'label_en', 'Retirement Reason',
               'type', 'text',
               'required', false,
               'order', 92,
               'section_id', (schema->'sections'->0->>'id'),
               'width', 'full',
               'show_in_table', false
             )
           )
    )
WHERE m.name = 'clients'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') f
    WHERE f->>'name' = 'is_retired'
  );
