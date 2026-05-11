-- ============================================================================
-- Followups: add `fired_at` (datetime) for the on_due sweeper (2026-05-10)
--
-- The new on_due workflow trigger fires when a followup's scheduled_datetime
-- arrives. The sweeper (api/sweep-due-followups.ts, every 5 minutes) marks
-- each row's data->>'fired_at' the first time it picks it up so the row
-- never fires twice.
--
-- The seed (src/data/seedModels.ts) already includes this field for fresh
-- installs. This migration appends it to the live model JSONB so existing
-- installs match.
--
-- Idempotent — re-running is a no-op.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_model_id     uuid;
  v_schema       jsonb;
  v_basic_id     text;
  v_existing     boolean;
  v_new_field    jsonb;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema FROM models WHERE name = 'followups';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'followups model not found — skipping fired_at migration (fresh install will pick up the seed)';
    RETURN;
  END IF;

  -- The basic section is is_base=true and lives at sections[0].
  v_basic_id := v_schema->'sections'->0->>'id';
  IF v_basic_id IS NULL THEN
    RAISE EXCEPTION 'followups schema has no base section — refusing to mutate';
  END IF;

  -- Idempotency check: if any field anywhere in the schema already has name='fired_at', stop.
  SELECT EXISTS(
    SELECT 1
    FROM jsonb_array_elements(v_schema->'sections') s,
         jsonb_array_elements(s->'fields') f
    WHERE f->>'name' = 'fired_at'
  ) INTO v_existing;
  IF v_existing THEN
    RAISE NOTICE 'fired_at field already present on followups — no change';
    RETURN;
  END IF;

  v_new_field := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'fired_at',
    'label_ar', 'وقت تشغيل التذكير الآلي',
    'label_en', 'Auto-Reminder Fired At',
    'type', 'datetime',
    'required', false,
    'order', 99,
    'section_id', v_basic_id,
    'width', 'half',
    'show_in_table', false
  );

  -- Append to the basic section's fields array.
  v_schema := jsonb_set(
    v_schema,
    ARRAY['sections', '0', 'fields'],
    (v_schema->'sections'->0->'fields') || jsonb_build_array(v_new_field)
  );

  UPDATE models SET schema = v_schema, updated_at = NOW() WHERE id = v_model_id;
END $$;

COMMIT;
