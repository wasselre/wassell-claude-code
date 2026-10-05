-- Live verification of the price tuple's undo behavior using synthetic Sandbox
-- records only. Every inserted group, model, record and log is rolled back.
-- Run with scripts/binghatti-db.mjs; no credentials belong in this file.
BEGIN;
DO $verification$
DECLARE
  v_group uuid;
  v_model uuid;
  v_record uuid;
  v_run uuid;
  v_before jsonb := '{"total_price":1021,"source_price":1000,"source_currency":"AED","source_fx_rate":1.021103,"unit_status":"available"}'::jsonb;
  v_after jsonb := '{"total_price":2042,"source_price":2000,"source_currency":"AED","source_fx_rate":1.021103,"unit_status":"sold"}'::jsonb;
  v_current jsonb;
  v_result jsonb;
  v_name text := 'binghatti_revert_verification_' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  -- The old claude_link_test Sandbox model is optional and may have been removed.
  SELECT id INTO v_model FROM public.models
    WHERE id = 'ff2cb628-83b3-452f-beea-0b62cf9f51b6' AND name = 'claude_link_test';
  IF v_model IS NULL THEN
    INSERT INTO public.model_groups(label_ar, label_en)
      VALUES ('اختبار مؤقت — يتم التراجع', 'Sandbox — temporary rollback verification') RETURNING id INTO v_group;
    INSERT INTO public.models(name, label_ar, label_en, group_id)
      VALUES (v_name, 'اختبار التراجع المؤقت', 'Temporary Binghatti revert verification', v_group)
      RETURNING id INTO v_model;
  END IF;

  -- Case 1: no later edits. All four price fields and the status must restore.
  v_record := gen_random_uuid();
  INSERT INTO public.records(id, model_id, data) VALUES (v_record, v_model, v_after);
  INSERT INTO public.project_update_runs(run_key, source_type, trigger, dry_run, status, outcome, params, finished_at)
    VALUES ('verification-sandbox:binghatti:' || gen_random_uuid()::text, 'binghatti_broker', 'manual', false,
      'done', 'applied', '{"verification_sandbox":true,"case":"complete_tuple"}'::jsonb, now())
    RETURNING id INTO v_run;
  INSERT INTO public.project_update_changes(run_id, project_id, record_id, model, action, before, after, reason)
    VALUES (v_run, NULL, v_record, v_name, 'update', v_before, v_after, 'synthetic Sandbox rollback verification');
  v_result := public.project_update_revert(v_run);
  SELECT data INTO v_current FROM public.records WHERE id = v_record;
  IF v_current IS DISTINCT FROM v_before OR v_result IS DISTINCT FROM '{"reverted":1,"partial":0,"skipped":0}'::jsonb THEN
    RAISE EXCEPTION 'complete tuple revert failed: result %, current %', v_result, v_current USING ERRCODE = 'WS422';
  END IF;

  -- Case 2: a later SAR edit keeps the entire source/SAR tuple. Status reverts.
  v_record := gen_random_uuid();
  INSERT INTO public.records(id, model_id, data) VALUES (v_record, v_model, v_after);
  INSERT INTO public.project_update_runs(run_key, source_type, trigger, dry_run, status, outcome, params, finished_at)
    VALUES ('verification-sandbox:binghatti:' || gen_random_uuid()::text, 'binghatti_broker', 'manual', false,
      'done', 'applied', '{"verification_sandbox":true,"case":"later_sar_edit"}'::jsonb, now())
    RETURNING id INTO v_run;
  INSERT INTO public.project_update_changes(run_id, project_id, record_id, model, action, before, after, reason)
    VALUES (v_run, NULL, v_record, v_name, 'update', v_before, v_after, 'synthetic Sandbox rollback verification');
  UPDATE public.records SET data = jsonb_set(data, '{total_price}', '2500'::jsonb) WHERE id = v_record;
  v_result := public.project_update_revert(v_run);
  SELECT data INTO v_current FROM public.records WHERE id = v_record;
  IF v_current IS DISTINCT FROM (v_after || '{"total_price":2500,"unit_status":"available"}'::jsonb)
      OR v_result IS DISTINCT FROM '{"reverted":0,"partial":1,"skipped":0}'::jsonb THEN
    RAISE EXCEPTION 'later SAR edit revert failed: result %, current %', v_result, v_current USING ERRCODE = 'WS422';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.project_update_changes WHERE run_id = v_run AND reverted_at IS NOT NULL
      AND revert_note LIKE 'partly reverted%'
      AND revert_note LIKE '%total_price%' AND revert_note LIKE '%source_price%'
      AND revert_note LIKE '%source_currency%' AND revert_note LIKE '%source_fx_rate%') THEN
    RAISE EXCEPTION 'partial revert did not report the preserved complete price tuple' USING ERRCODE = 'WS422';
  END IF;
END $verification$;
ROLLBACK;
SELECT jsonb_build_object('complete_tuple_revert', 'passed', 'later_sar_edit_preserves_tuple', 'passed',
  'non_price_status_revert', 'passed', 'all_probe_writes', 'rolled_back') AS verification;
