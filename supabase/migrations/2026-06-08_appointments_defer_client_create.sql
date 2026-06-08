-- ============================================================================
-- Appointments: defer phone→client auto-create from typing to SAVE
-- (2026-06-08)
--
-- The appointments `phone_number` field auto-creates a client when the typed
-- phone matches none. Until now that fired on the typing debounce, which could
-- spawn a junk client from a half-typed number. This patches the live model
-- JSONB so creation is deferred to the form's Save commit instead — handled by
-- createMissingLinkedRecords + the "new client created" popup. An EXISTING
-- client still links live while typing (that path is unchanged).
--
-- Two keys are added to the phone_number field:
--   - auto_link_create_timing: 'on_save'      (defer create to Save)
--   - auto_link_create_copy_fields: [{from:'client_name', to:'client_name'}]
--     (seed the new client's name from the appointment's typed Client Name)
--
-- The seed (src/data/seedModels.ts) already includes these for fresh installs.
-- This appends them to the live appointments model on existing installs.
-- Idempotent: the `||` merge re-applies the same values on re-run.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_model_id  uuid;
  v_schema    jsonb;
  v_fields    jsonb;
  v_new       jsonb;
  v_has_phone boolean;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema FROM models WHERE name = 'appointments';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'appointments model not found — fresh install will pick this up from the seed';
    RETURN;
  END IF;

  v_fields := v_schema->'sections'->0->'fields';

  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = 'phone_number')
    INTO v_has_phone;
  IF NOT v_has_phone THEN
    RAISE NOTICE 'appointments has no phone_number field (custom layout?) — nothing to patch';
    RETURN;
  END IF;

  -- Rebuild the fields array preserving original order, patching only the
  -- phone_number field with the two deferred-create keys.
  SELECT jsonb_agg(patched ORDER BY idx)
  INTO v_new
  FROM (
    SELECT
      CASE
        WHEN f.value->>'name' = 'phone_number'
        THEN f.value
             || jsonb_build_object('auto_link_create_timing', 'on_save')
             || jsonb_build_object(
                  'auto_link_create_copy_fields',
                  jsonb_build_array(jsonb_build_object('from', 'client_name', 'to', 'client_name'))
                )
        ELSE f.value
      END AS patched,
      f.ordinality AS idx
    FROM jsonb_array_elements(v_fields) WITH ORDINALITY AS f(value, ordinality)
  ) sub;

  v_schema := jsonb_set(v_schema, '{sections,0,fields}', v_new);
  UPDATE models SET schema = v_schema, updated_at = NOW() WHERE id = v_model_id;
  RAISE NOTICE 'appointments phone_number → deferred on_save client-create applied';
END $$;

COMMIT;
