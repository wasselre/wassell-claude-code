-- ============================================================================
-- Backfill: copy pd_* template defaults from site_settings into every
-- existing project_details record that's missing them.
--
-- Why this is needed:
-- The 2026-05-11_b migration seeded site_settings with the 33 pd_* defaults
-- AND extended the bridge route (ProjectDetailsBridgePage.tsx) to copy those
-- defaults into every NEW project_details record at creation time. So any
-- project_details created on/after 2026-05-11 opens with the template text
-- visible and editable.
--
-- But any project_details created BEFORE 2026-05-11 still has empty pd_*
-- fields — the admin sees a blank "Page Texts (Override for This Project)"
-- section in the editor with no hint of what the defaults are. This migration
-- fixes those records by copying the current site_settings template into
-- any pd_* key that's missing on each existing project_details record.
--
-- Idempotent and non-destructive: only fills keys that are not already
-- present on the target record — never overwrites an admin's edits.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_site_model_id    uuid;
  v_details_model_id uuid;
  v_template         jsonb;
  v_rec              record;
  v_merged           jsonb;
  v_pd_key           text;
  v_pd_val           text;
BEGIN
  SELECT id INTO v_site_model_id    FROM models WHERE name = 'site_settings';
  SELECT id INTO v_details_model_id FROM models WHERE name = 'project_details';

  IF v_site_model_id IS NULL OR v_details_model_id IS NULL THEN
    RAISE NOTICE 'site_settings or project_details model missing — skipping backfill';
    RETURN;
  END IF;

  -- Build the template object from the singleton's pd_* keys (non-empty only).
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_template
  FROM records r,
       jsonb_each_text(r.data) AS kv(key, value)
  WHERE r.model_id = v_site_model_id
    AND kv.key LIKE 'pd\_%' ESCAPE '\'
    AND COALESCE(trim(kv.value), '') <> '';

  IF v_template = '{}'::jsonb THEN
    RAISE NOTICE 'site_settings has no pd_* template values — nothing to backfill';
    RETURN;
  END IF;

  -- For each project_details record, fill only the pd_* keys that are not
  -- already present (preserve any value the admin already set, including
  -- explicit empty strings).
  FOR v_rec IN
    SELECT id, data FROM records WHERE model_id = v_details_model_id
  LOOP
    v_merged := COALESCE(v_rec.data, '{}'::jsonb);
    FOR v_pd_key, v_pd_val IN SELECT * FROM jsonb_each_text(v_template) LOOP
      IF NOT (v_merged ? v_pd_key) THEN
        v_merged := v_merged || jsonb_build_object(v_pd_key, v_pd_val);
      END IF;
    END LOOP;

    IF v_merged <> COALESCE(v_rec.data, '{}'::jsonb) THEN
      UPDATE records
      SET data = v_merged, updated_at = NOW()
      WHERE id = v_rec.id;
    END IF;
  END LOOP;
END $$;

COMMIT;
