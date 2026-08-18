\set ON_ERROR_STOP on
SET ROLE service_role;

SELECT public.ingestion_run_start('aqar','v1') AS run_id \gset

SELECT public.ingest_capture_put(
  :'run_id'::uuid, 'aqar', 'LST-1', 'market-ingest/adapters/aqar', 'v1', repeat('c',64),
  '{"images":{"source_count":1,"captured_count":1},"videos":{"source_count":1,"captured_count":1}}'::jsonb,
  jsonb_build_array(
    jsonb_build_object('content_hash',repeat('a',64),'media_type','text/html','size_bytes',1000,'storage_bucket','market-raw','storage_object_path','aqar/'||repeat('a',64)),
    jsonb_build_object('content_hash',repeat('b',64),'media_type','image/jpeg','size_bytes',5000,'storage_bucket','listing-photos','storage_object_path','LST-1/'||repeat('b',64)||'.jpg')
  ),
  jsonb_build_array(
    jsonb_build_object('artifact_type','detail_html','media_type','text/html','content_hash',repeat('a',64),'retention_mode','original_bytes','retention_state','durable_original'),
    jsonb_build_object('artifact_type','image','media_type','image/jpeg','content_hash',repeat('b',64),'retention_mode','existing_storage_ref','retention_state','durable_existing_asset','order_index',0),
    jsonb_build_object('artifact_type','video','source_url_or_endpoint','https://stream/vid','retention_mode','source_url_metadata_only','retention_state','external_reference_only')
  ),
  jsonb_build_array(
    jsonb_build_object('section','detail_html','state','captured','why_expected','platform_contract','artifact_index',0),
    jsonb_build_object('section','images','state','captured','why_expected','source_reported_count','artifact_index',1),
    jsonb_build_object('section','videos','state','captured','why_expected','tab','artifact_index',2),
    jsonb_build_object('section','floor_plans','state','not_present','why_expected','none')
  )
) AS put1 \gset

SELECT public.ingest_capture_put(
  :'run_id'::uuid, 'aqar', 'LST-1', 'market-ingest/adapters/aqar', 'v1', repeat('c',64),
  '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) AS put2 \gset

-- psql-var assertions live OUTSIDE dollar-quoted blocks (forced error on failure)
SELECT CASE WHEN (:'put1'::jsonb->>'was_new')::bool AND NOT (:'put2'::jsonb->>'was_new')::bool
            THEN 'OK was_new true->false' ELSE 1/0 || '' END AS a1;
SELECT CASE WHEN (:'put1'::jsonb->>'capture_class') = 'complete'
            THEN 'OK class=complete' ELSE 1/0 || '' END AS a2;

-- table-state assertions (no psql vars → safe inside DO)
DO $v$
DECLARE v_snaps int; v_arts int; v_manifest int; v_class text; v_state text; v_link int;
BEGIN
  SELECT count(*) INTO v_snaps FROM public.raw_snapshots WHERE source='aqar' AND external_id='LST-1';
  SELECT count(*) INTO v_arts FROM public.raw_snapshot_artifacts a JOIN public.raw_snapshots s ON s.id=a.snapshot_id WHERE s.external_id='LST-1';
  SELECT count(*) INTO v_manifest FROM public.page_capture_manifest m JOIN public.raw_snapshots s ON s.id=m.snapshot_id WHERE s.external_id='LST-1';
  SELECT capture_class INTO v_class FROM public.raw_snapshots WHERE external_id='LST-1';
  SELECT state INTO v_state FROM public.ingestion_items WHERE external_id='LST-1';
  SELECT count(*) INTO v_link FROM public.page_capture_manifest m JOIN public.raw_snapshot_artifacts a ON a.id=m.artifact_id WHERE m.section='videos' AND a.artifact_type='video';
  IF v_snaps <> 1 THEN RAISE EXCEPTION 'FAIL snapshots=%',v_snaps; END IF;
  IF v_arts  <> 3 THEN RAISE EXCEPTION 'FAIL artifacts=% (dup on re-capture?)',v_arts; END IF;
  IF v_manifest <> 4 THEN RAISE EXCEPTION 'FAIL manifest=%',v_manifest; END IF;
  IF v_class <> 'complete' THEN RAISE EXCEPTION 'FAIL class=%',v_class; END IF;
  IF v_state <> 'raw_snapshot_saved' THEN RAISE EXCEPTION 'FAIL item state=%',v_state; END IF;
  IF v_link <> 1 THEN RAISE EXCEPTION 'FAIL video manifest link=%',v_link; END IF;
  RAISE NOTICE 'OK capture idempotent: 1 snap / 3 arts / 4 manifest / complete / raw_snapshot_saved / video linked';
END $v$;

-- source_field_observe twice
SELECT public.source_field_observe('aqar','market-ingest/adapters/aqar','v001','property.price','detail','السعر','number','SAR','ar','[100000]'::jsonb,NULL,NULL);
SELECT public.source_field_observe('aqar','market-ingest/adapters/aqar','v001','property.price','detail','السعر','number','SAR','ar','[200000]'::jsonb,NULL,NULL);
DO $v$
DECLARE v_occ bigint; v_ex jsonb;
BEGIN
  SELECT occurrence_count, example_values INTO v_occ, v_ex FROM public.source_field_catalog WHERE source_path='property.price';
  IF v_occ <> 2 THEN RAISE EXCEPTION 'FAIL occurrence_count=%',v_occ; END IF;
  IF jsonb_array_length(v_ex) <> 2 THEN RAISE EXCEPTION 'FAIL examples=%',v_ex; END IF;
  RAISE NOTICE 'OK source_field_observe occ=2 examples=%',v_ex;
END $v$;

-- schema_gap_raise: unmapped -> gap; mapped/excluded -> no gap (returns NULL)
SELECT public.schema_gap_raise('aqar','property.new_weird_field','v001','string',NULL,'non_critical',1,gen_random_uuid());
INSERT INTO public.source_field_mappings(platform,source_path,contract_version,status,canonical_field)
  VALUES ('aqar','property.price','v001','mapped_existing_field','price');
INSERT INTO public.source_field_mappings(platform,source_path,contract_version,status,reviewer,reason,decided_at)
  VALUES ('aqar','property.internal_tracking','v001','technical_excluded','tester','not business data', now());
-- these return NULL (terminal mapping exists) → no gap; verified by the count below
SELECT public.schema_gap_raise('aqar','property.price','v001','number','price','non_critical',1,NULL) AS gap_mapped;
SELECT public.schema_gap_raise('aqar','property.internal_tracking','v001','string',NULL,'non_critical',1,NULL) AS gap_excluded;
DO $v$
DECLARE v_gaps int; v_mapped_gap int;
BEGIN
  SELECT count(*) INTO v_gaps FROM public.schema_gap_events;
  SELECT count(*) INTO v_mapped_gap FROM public.schema_gap_events WHERE source_path IN ('property.price','property.internal_tracking');
  IF v_gaps <> 1 THEN RAISE EXCEPTION 'FAIL gaps=% (expected 1 unmapped only)',v_gaps; END IF;
  IF v_mapped_gap <> 0 THEN RAISE EXCEPTION 'FAIL mapped/excluded fields raised gaps=%',v_mapped_gap; END IF;
  RAISE NOTICE 'OK schema_gap_raise: exactly 1 gap (unmapped field only); mapped/excluded raised none';
END $v$;

-- state advance + finish
SELECT public.ingestion_item_set_state(:'run_id'::uuid,'aqar','LST-1','parsed',NULL);
SELECT public.ingestion_run_finish(:'run_id'::uuid, '{"captured":1}'::jsonb);
DO $v$
DECLARE v_state text; v_ended timestamptz;
BEGIN
  SELECT state INTO v_state FROM public.ingestion_items WHERE external_id='LST-1';
  SELECT ended_at INTO v_ended FROM public.ingestion_runs WHERE source='aqar' ORDER BY started_at DESC LIMIT 1;
  IF v_state <> 'parsed' THEN RAISE EXCEPTION 'FAIL state=%',v_state; END IF;
  IF v_ended IS NULL THEN RAISE EXCEPTION 'FAIL run not finished'; END IF;
  RAISE NOTICE 'OK state=parsed, run finished';
END $v$;

RESET ROLE;

-- ACL boundary: authenticated cannot EXECUTE the worker RPCs
DO $v$
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.ingestion_run_start('aqar','v1');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: authenticated could call ingestion_run_start';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK authenticated denied EXECUTE (insufficient_privilege)';
  END;
END $v$;
RESET ROLE;

\echo ==== PHASE 2 VALIDATION: ALL CHECKS PASSED ====
