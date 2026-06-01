-- Follow-ups: field-level conditional visibility keyed on `followup_type`.
--
-- The follow-ups model was hand-edited in the Builder into a flat layout (all
-- detail fields live in one base section), so the old section_selector no longer
-- hides per-type fields. This backfills the new `visible_when` field rule
-- (see src/types FieldVisibilityRule + src/lib/fieldVisibility.ts) so each set
-- of fields shows only for its follow-up type:
--
--   appointment_confirmation_call → appointment_id, appointment_date, appointment_project
--   follow_up_call_after_visit    → visit, visited_projects
--   whatsapp_follow_up            → next_followup_after_days
--
-- followups is UNFROZEN (models.is_hardcoded = false) so we edit models.schema
-- directly. The controlling field is `followup_type`
-- (id cd8b0b3f-6d77-4ea6-9c5f-55449f88df4c). `visible_when` references it by id
-- so the rule survives a label/slug rename of the controller.
--
-- Idempotent: re-running just re-sets the same `visible_when` objects.

BEGIN;

-- Safety snapshot of the current schema (drop once verified).
CREATE TABLE IF NOT EXISTS public._backup_followups_schema_20260601 AS
SELECT id, name, schema, now() AS backed_up_at
FROM public.models
WHERE name = 'followups';

UPDATE public.models m
SET
  schema = jsonb_set(
    schema,
    '{sections}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN sec ? 'fields' THEN jsonb_set(
            sec,
            '{fields}',
            (
              SELECT jsonb_agg(
                CASE
                  WHEN fld->>'name' IN ('appointment_id', 'appointment_date', 'appointment_project')
                    THEN fld || jsonb_build_object(
                      'visible_when',
                      jsonb_build_object(
                        'field_id', 'cd8b0b3f-6d77-4ea6-9c5f-55449f88df4c',
                        'values', jsonb_build_array('appointment_confirmation_call')
                      )
                    )
                  WHEN fld->>'name' IN ('visit', 'visited_projects')
                    THEN fld || jsonb_build_object(
                      'visible_when',
                      jsonb_build_object(
                        'field_id', 'cd8b0b3f-6d77-4ea6-9c5f-55449f88df4c',
                        'values', jsonb_build_array('follow_up_call_after_visit')
                      )
                    )
                  WHEN fld->>'name' = 'next_followup_after_days'
                    THEN fld || jsonb_build_object(
                      'visible_when',
                      jsonb_build_object(
                        'field_id', 'cd8b0b3f-6d77-4ea6-9c5f-55449f88df4c',
                        'values', jsonb_build_array('whatsapp_follow_up')
                      )
                    )
                  ELSE fld
                END
              )
              FROM jsonb_array_elements(sec->'fields') AS fld
            )
          )
          ELSE sec
        END
      )
      FROM jsonb_array_elements(schema->'sections') AS sec
    )
  ),
  updated_at = now()
WHERE m.name = 'followups';

COMMIT;
