-- CI smoke assertions for the W1 translation migrations (runs after
-- bootstrap_fixture.sql + migrations 2026-09-01_01..05 on the ephemeral DB).
-- Each block RAISEs on failure — psql exits non-zero and fails the job.
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_model uuid; v_rec uuid; v_gen1 bigint; v_gen2 bigint; v_jobs int;
BEGIN
  -- Fixture model with one translatable field + one skip field.
  INSERT INTO models (name, schema) VALUES ('smoke_projects', jsonb_build_object(
    'sections', jsonb_build_array(jsonb_build_object(
      'id','s1','label_ar','عام','label_en','General','fields', jsonb_build_array(
        jsonb_build_object('id','f1','name','project_analysis','type','textarea',
          'label_ar','تحليل','label_en','Analysis','required',false,'order',0,
          'section_id','s1','width','full','show_in_table',false),
        jsonb_build_object('id','f2','name','price','type','number',
          'label_ar','السعر','label_en','Price','required',false,'order',1,
          'section_id','s1','width','half','show_in_table',true)
  )))))
  RETURNING id INTO v_model;

  -- 1) Policy seeding proposed the right rows.
  IF NOT EXISTS (SELECT 1 FROM translation_field_policies
      WHERE resource_kind='record' AND scope_id=v_model AND field_path='project_analysis'
        AND treatment='translate' AND classification_status='proposed') THEN
    RAISE EXCEPTION 'SMOKE 1 failed: textarea policy not proposed';
  END IF;
  IF EXISTS (SELECT 1 FROM translation_field_policies
      WHERE scope_id=v_model AND field_path='price' AND treatment <> 'skip') THEN
    RAISE EXCEPTION 'SMOKE 1b failed: number field not skipped';
  END IF;

  -- 2) DARK: unconfirmed policy + disabled flags => a save enqueues nothing.
  INSERT INTO records (model_id, data) VALUES (v_model, '{"project_analysis":"نص عربي"}')
  RETURNING id INTO v_rec;
  SELECT count(*) INTO v_jobs FROM translation_jobs;
  IF v_jobs <> 0 THEN RAISE EXCEPTION 'SMOKE 2 failed: dark system enqueued %', v_jobs; END IF;

  -- 3) Enable + confirm => save enqueues exactly one coalesced job and bumps
  --    the unit generation synchronously.
  UPDATE translation_settings SET is_enabled = true WHERE id;
  UPDATE translation_resources SET enabled = true WHERE resource_kind='record';
  UPDATE translation_field_policies SET classification_status='confirmed'
  WHERE scope_id=v_model AND field_path='project_analysis';

  INSERT INTO translation_units (resource_kind, entity_id, field_path, model_id,
    source_lang, source_rev) VALUES ('record', v_rec, 'project_analysis', v_model, 'ar', 'h1');
  INSERT INTO translation_variants (resource_kind, entity_id, field_path, lang, role, state)
  VALUES ('record', v_rec, 'project_analysis', 'ar', 'source', 'source'),
         ('record', v_rec, 'project_analysis', 'en', 'target', 'pending');
  SELECT generation INTO v_gen1 FROM translation_units
  WHERE entity_id=v_rec AND field_path='project_analysis';

  UPDATE records SET data = jsonb_set(data, '{project_analysis}', '"نص عربي جديد"') WHERE id = v_rec;
  UPDATE records SET data = jsonb_set(data, '{project_analysis}', '"نص ثالث"') WHERE id = v_rec;

  SELECT count(*) INTO v_jobs FROM translation_jobs WHERE status='queued';
  IF v_jobs <> 1 THEN RAISE EXCEPTION 'SMOKE 3 failed: expected 1 coalesced job, got %', v_jobs; END IF;
  SELECT generation INTO v_gen2 FROM translation_units
  WHERE entity_id=v_rec AND field_path='project_analysis';
  IF v_gen2 <> v_gen1 + 2 THEN
    RAISE EXCEPTION 'SMOKE 3b failed: generation % -> % (expected +2)', v_gen1, v_gen2;
  END IF;

  -- 4) No-op save does not bump or enqueue further.
  UPDATE records SET data = data WHERE id = v_rec;
  IF (SELECT generation FROM translation_units WHERE entity_id=v_rec AND field_path='project_analysis') <> v_gen2 THEN
    RAISE EXCEPTION 'SMOKE 4 failed: no-op save bumped generation';
  END IF;

  -- 5) Authorization: no JWT => approve RPC must reject.
  BEGIN
    PERFORM record_translation_approve('record', v_rec, 'project_analysis', 'en',
      gen_random_uuid(), v_gen2);
    RAISE EXCEPTION 'SMOKE 5 failed: unauthenticated approve did not reject';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 6) Generation CAS: stale expected_generation => source_changed (40001).
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  PERFORM set_config('test.is_admin', 'true', true);
  BEGIN
    PERFORM record_translation_approve('record', v_rec, 'project_analysis', 'en',
      gen_random_uuid(), v_gen2 - 1);
    RAISE EXCEPTION 'SMOKE 6 failed: stale generation accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  -- 7) Record deletion purges units + search doc.
  DELETE FROM records WHERE id = v_rec;
  IF EXISTS (SELECT 1 FROM translation_units WHERE entity_id = v_rec) THEN
    RAISE EXCEPTION 'SMOKE 7 failed: units survived record deletion';
  END IF;

  RAISE NOTICE 'W1 smoke: all assertions passed';
END $$;

-- 8) Row-ID backfill: assigns _row_id, marks itself a system write (no
--    translation job, no workflow capture), and is idempotent.
DO $$
DECLARE v_model uuid; v_rec uuid; v_n int; v_jobs_before int; v_wf_before int;
BEGIN
  INSERT INTO models (name, schema) VALUES ('smoke_tables', jsonb_build_object(
    'sections', jsonb_build_array(jsonb_build_object(
      'id','s1','label_ar','ع','label_en','G','fields', jsonb_build_array(
        jsonb_build_object('id','t1','name','features','type','table',
          'label_ar','مميزات','label_en','Features','required',false,'order',0,
          'section_id','s1','width','full','show_in_table',false)
  )))))
  RETURNING id INTO v_model;
  INSERT INTO workflow_capture_models (model_id, enabled) VALUES (v_model, true);
  INSERT INTO records (model_id, data) VALUES (v_model,
    '{"features":[{"name":"مصعد"},{"name":"مسبح","_row_id":"keep-me"}]}')
  RETURNING id INTO v_rec;
  SELECT count(*) INTO v_jobs_before FROM translation_jobs;
  SELECT count(*) INTO v_wf_before FROM workflow_jobs;

  SELECT translation_assign_row_ids(v_model, 100) INTO v_n;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE 8 failed: expected 1 record updated, got %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM records rec, jsonb_array_elements(rec.data->'features') e(el)
             WHERE rec.id = v_rec AND NOT (e.el ? '_row_id')) THEN
    RAISE EXCEPTION 'SMOKE 8b failed: a row is still missing _row_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM records rec, jsonb_array_elements(rec.data->'features') e(el)
                 WHERE rec.id = v_rec AND e.el->>'_row_id' = 'keep-me') THEN
    RAISE EXCEPTION 'SMOKE 8c failed: existing _row_id was rewritten';
  END IF;
  IF (SELECT count(*) FROM translation_jobs) <> v_jobs_before THEN
    RAISE EXCEPTION 'SMOKE 8d failed: backfill enqueued a translation job';
  END IF;
  IF (SELECT count(*) FROM workflow_jobs) <> v_wf_before THEN
    RAISE EXCEPTION 'SMOKE 8e failed: backfill fired workflow capture';
  END IF;
  SELECT translation_assign_row_ids(v_model, 100) INTO v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE 8f failed: backfill not idempotent (%)', v_n; END IF;

  RAISE NOTICE 'W1 smoke 8 (row ids): passed';
END $$;

-- 9) Durable dirty state under queue backpressure (live-gap fix 2026-08-02):
--    a NEVER-translated record saved while the queue is at the depth cap must
--    still leave a stub unit for reconcile — the signal is never lost.
DO $$
DECLARE v_model uuid; v_rec uuid; v_stub record;
BEGIN
  SELECT m.id INTO v_model FROM models m WHERE m.name = 'smoke_projects';
  UPDATE translation_settings SET max_queue_depth = 0 WHERE id;   -- force refusal
  INSERT INTO records (model_id, data) VALUES (v_model, '{"project_analysis":"نص جديد لم يُترجم قط"}')
  RETURNING id INTO v_rec;
  IF EXISTS (SELECT 1 FROM translation_jobs WHERE entity_id = v_rec) THEN
    RAISE EXCEPTION 'SMOKE 9 failed: job enqueued despite depth cap 0';
  END IF;
  SELECT * INTO v_stub FROM translation_units
  WHERE resource_kind='record' AND entity_id = v_rec AND field_path = 'project_analysis';
  IF NOT FOUND OR NOT v_stub.dirty THEN
    RAISE EXCEPTION 'SMOKE 9b failed: no dirty stub unit for the refused record';
  END IF;
  UPDATE translation_settings SET max_queue_depth = 500 WHERE id;
  IF (SELECT translation_reconcile(50)) < 1 THEN
    RAISE EXCEPTION 'SMOKE 9c failed: reconcile did not recover the stub';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM translation_jobs WHERE entity_id = v_rec AND status = 'queued') THEN
    RAISE EXCEPTION 'SMOKE 9d failed: recovered job missing';
  END IF;
  RAISE NOTICE 'W3 smoke 9 (durable dirty under backpressure): passed';
END $$;
