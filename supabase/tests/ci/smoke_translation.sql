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

-- 10) W4 server-language: enqueue carries the requested language (coerced to
--     'ar' on garbage), and the claim returns it to the worker.
DO $$
DECLARE
  v_tmpl uuid; v_job_en uuid; v_job_bad uuid; v_claim record;
BEGIN
  INSERT INTO document_templates (file_id, model_id)
  VALUES (gen_random_uuid(), gen_random_uuid()) RETURNING id INTO v_tmpl;
  -- The claim JOINs wassel_documents on the template's file_id.
  INSERT INTO wassel_documents (file_id, content_json)
  SELECT file_id, '{"type":"doc"}'::jsonb FROM document_templates WHERE id = v_tmpl;

  SELECT document_job_enqueue(
    gen_random_uuid(), gen_random_uuid(), v_tmpl,
    (SELECT file_id FROM document_templates WHERE id = v_tmpl),
    NULL, gen_random_uuid(), gen_random_uuid(), NULL, NULL, NULL, 'en'
  ) INTO v_job_en;
  IF (SELECT language FROM document_jobs WHERE id = v_job_en) <> 'en' THEN
    RAISE EXCEPTION 'SMOKE 10 failed: enqueue dropped language=en';
  END IF;

  SELECT document_job_enqueue(
    gen_random_uuid(), gen_random_uuid(), v_tmpl,
    (SELECT file_id FROM document_templates WHERE id = v_tmpl),
    NULL, gen_random_uuid(), gen_random_uuid(), NULL, NULL, NULL, 'xx'
  ) INTO v_job_bad;
  IF (SELECT language FROM document_jobs WHERE id = v_job_bad) <> 'ar' THEN
    RAISE EXCEPTION 'SMOKE 10b failed: garbage language not coerced to ar';
  END IF;

  SELECT * INTO v_claim FROM document_job_claim_next('ci-worker');
  IF NOT FOUND OR v_claim.language NOT IN ('ar','en') THEN
    RAISE EXCEPTION 'SMOKE 10c failed: claim did not return language';
  END IF;

  RAISE NOTICE 'W4 smoke 10 (document language carrier): passed';
END $$;

-- 11) W5 search folding: wassell_search_norm folds Arabic orthography (hamza
--     forms → bare alef, ta-marbuta → heh, alef-maqsura → yeh, tatweel stripped,
--     digits unified) and — critically — آ (alef-madda) folds to ا, NOT to a
--     space (the W1 typo fixed in 2026-09-02_02). Client foldArabic() must match.
DO $$
BEGIN
  -- All three hamza-alef forms collapse to the SAME normalized token.
  IF public.wassell_search_norm('الأصيل') <> public.wassell_search_norm('الاصيل') THEN
    RAISE EXCEPTION 'SMOKE 11 failed: أ not folded to ا';
  END IF;
  IF public.wassell_search_norm('قرآن') <> public.wassell_search_norm('قران') THEN
    RAISE EXCEPTION 'SMOKE 11b failed: آ not folded to ا (the alef-madda typo)';
  END IF;
  -- No space is introduced by the آ fold (the exact bug: "قرآن" → "قر ن").
  IF position(' ' in public.wassell_search_norm('قرآن')) <> 0 THEN
    RAISE EXCEPTION 'SMOKE 11c failed: آ still folds to a space';
  END IF;
  IF public.wassell_search_norm('مدرسة') <> 'مدرسه' THEN
    RAISE EXCEPTION 'SMOKE 11d failed: ة not folded to ه';
  END IF;
  IF public.wassell_search_norm('مصطفى') <> 'مصطفي' THEN
    RAISE EXCEPTION 'SMOKE 11e failed: ى not folded to ي';
  END IF;
  IF public.wassell_search_norm('كـــتاب ١٤') <> 'كتاب 14' THEN
    RAISE EXCEPTION 'SMOKE 11f failed: tatweel/digit normalization drifted (got %)',
      public.wassell_search_norm('كـــتاب ١٤');
  END IF;
  RAISE NOTICE 'W5 smoke 11 (search folding parity): passed';
END $$;

-- 12) W5 mode-1 search: word_similarity finds a WORD inside a long document (the
--     old similarity()+`%` scored a short query against a long text too low to
--     match). Also proves cross-language: an English word matches via text_en.
DO $$
DECLARE v_model uuid; v_rec uuid;
BEGIN
  INSERT INTO models (name, schema) VALUES ('smoke_search', '{"sections":[]}'::jsonb)
  RETURNING id INTO v_model;
  INSERT INTO records (model_id, data) VALUES (v_model, '{"notes":"نص طويل جداً يحتوي على موقف سيارة خاص"}')
  RETURNING id INTO v_rec;
  -- Populate the search document directly (the worker/rebuild path is covered
  -- elsewhere) with a long AR source + its EN translation.
  INSERT INTO search_documents (resource_kind, entity_id, model_id, text_src, text_ar, text_en, dirty)
  VALUES ('record', v_rec, v_model,
    'نص طويل جداً يحتوي على موقف سيارة خاص',
    'نص طويل جداً يحتوي على موقف سيارة خاص',
    'a very long description that mentions a private parking spot for the unit',
    false);

  IF NOT EXISTS (SELECT 1 FROM record_search_v2(v_model, 'parking', 'en', 50, 0) r WHERE r.record_id = v_rec) THEN
    RAISE EXCEPTION 'SMOKE 12 failed: EN word "parking" did not find the record (word_similarity broken)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM record_search_v2(v_model, 'موقف', 'ar', 50, 0) r WHERE r.record_id = v_rec) THEN
    RAISE EXCEPTION 'SMOKE 12b failed: AR source word did not find the record';
  END IF;
  -- A word that appears in NEITHER language must NOT match (no false positives).
  IF EXISTS (SELECT 1 FROM record_search_v2(v_model, 'helicopter', 'en', 50, 0) r WHERE r.record_id = v_rec) THEN
    RAISE EXCEPTION 'SMOKE 12c failed: unrelated word matched (threshold too loose)';
  END IF;

  RAISE NOTICE 'W5 smoke 12 (word-similarity cross-language search): passed';
END $$;
