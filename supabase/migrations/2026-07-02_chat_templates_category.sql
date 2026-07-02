-- ============================================================================
-- 2026-07-02: Chat templates — two-way classification (project / contact)
-- ----------------------------------------------------------------------------
-- Adds a `category` dropdown to the chat_templates model so the in-chat
-- template picker can separate:
--   • 'project' — project/listing messages (recommendations, prices,
--     locations, brochures, generated project & listing templates)
--   • 'contact' — general client communication (greetings, follow-ups,
--     appointment reminders, check-ins)
--
-- Two changes, both additive + idempotent:
--   1. chat_templates.schema gains the `category` dropdown (Builder +
--      v_chat_templates view + generated PRD visibility). Same WHERE-guarded
--      append pattern as 2026-06-30_chat_templates_listing.sql.
--   2. Backfill: existing template records get an explicit category —
--      anything linked to a project or market listing → 'project',
--      everything else → 'contact'. The SPA resolver
--      (src/lib/chatTemplates.ts) applies the same rule at read time, so the
--      app classifies correctly even before this runs; the backfill just
--      makes the stored data explicit for views/BI/filters.
-- ============================================================================

BEGIN;

-- ── 1. chat_templates.schema += category (dropdown project|contact) ────────
UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'category',
        'label_ar', 'التصنيف',
        'label_en', 'Category',
        'type', 'dropdown',
        'required', false,
        'order', 12,
        'section_id', (schema->'sections'->0->>'id'),
        'width', 'half',
        'show_in_table', true,
        'options', jsonb_build_array(
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'label_ar', 'رسائل المشاريع',
            'label_en', 'Project messages',
            'value', 'project',
            'color', '#B8734F'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'label_ar', 'رسائل التواصل',
            'label_en', 'Contact messages',
            'value', 'contact',
            'color', '#C09B5F'
          )
        )
      )
    ),
    updated_at = now()
WHERE name = 'chat_templates'
  AND NOT ((schema->'sections'->0->'fields') @> '[{"name":"category"}]'::jsonb);

-- ── 2. Backfill existing templates (chat_templates is unfrozen → records) ──
UPDATE public.records
SET data = data || jsonb_build_object(
      'category',
      CASE
        WHEN COALESCE(data->>'project_id', '') <> ''
          OR COALESCE(data->>'listing_id', '') <> ''
        THEN 'project'
        ELSE 'contact'
      END
    ),
    updated_at = now()
WHERE model_id = (SELECT id FROM public.models WHERE name = 'chat_templates')
  AND (data->>'category' IS NULL OR data->>'category' NOT IN ('project', 'contact'));

COMMIT;
