-- FOLLOWUP_4: add `source_followup_id` (lookup → followups) to the visits model.
--
-- The Follow-up Workspace's "Register Visit / تسجيل زيارة" action lets a call /
-- WhatsApp rep record a visit the client reports during a follow-up. Each visit
-- created that way is linked back to the originating follow-up via this field so
-- the workspace can show "Visit already registered" instead of pushing a
-- duplicate, and so the link is queryable in BI / views.
--
-- `visits` is UNFROZEN (JSONB in `records`, is_hardcoded=false, table_name=null),
-- so this is a pure `models.schema` update — no DDL, no data backfill. The
-- `models_view_sync` trigger regenerates the `v_visits` typed view automatically
-- when the schema changes. The field mirrors the existing
-- `appointments.source_followup_id` (same lookup target + display field + hidden
-- from tables), which the appointment-create flow already sets the same way.
--
-- Idempotent: only appends the field when it is not already present.

BEGIN;

UPDATE public.models m
SET schema = jsonb_set(
      m.schema,
      '{sections,0,fields}',
      (m.schema->'sections'->0->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'source_followup_id',
        'label_ar', 'المتابعة المصدر',
        'label_en', 'Source Follow-up',
        'type', 'lookup',
        'required', false,
        'order', 50,
        'section_id', (m.schema->'sections'->0->>'id'),
        'width', 'half',
        'is_multi', false,
        'show_in_table', false,
        'lookup_model_id', (SELECT id::text FROM public.models WHERE name = 'followups'),
        'lookup_display_field', 'scheduled_datetime',
        'lookup_max_records', 20
      )
    )
WHERE m.name = 'visits'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f
    WHERE f->>'name' = 'source_followup_id'
  );

COMMIT;
