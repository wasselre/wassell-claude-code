-- ============================================================================
-- Regression guard for raw-asset analysis (2026-08-20).
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_asset_processing_test.sql
--
-- Runs inside a transaction that ROLLS BACK — safe against production.
--
-- Two of these pin bugs found while building the feature:
--
--   * SERVICE-ROLE LOCKOUT. The capability gate resolved the caller through
--     auth.uid(), which is NULL server-side, so every system caller graded as
--     role 'none'. The worker and any scheduled sweep could never queue work —
--     the feature looked fine in the UI and was dead everywhere else.
--
--   * DOUBLE-QUEUE. A harness run reported an asset being queued twice, which
--     would spend model budget twice per double-click. It could not be
--     reproduced in isolation and no root cause was established, so the
--     behaviour is pinned here rather than trusted to memory.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_user uuid; v_file uuid; v_asset uuid; v_pdf_file uuid; v_pdf uuid;
  n1 int; n2 int; v_status text; v_ocr text;
BEGIN
  SELECT id INTO v_user FROM public.users LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE 'SKIP: no users'; RETURN; END IF;

  -- an analysable asset and one with no analyser
  v_file := gen_random_uuid();
  INSERT INTO public.files(id, uploaded_by_user_id, original_name, mime_type, size_bytes,
                           storage_bucket, storage_path, kind)
  VALUES (v_file, v_user, 't.png','image/png',10,'wassel-files','t/'||v_file||'.png','image');
  INSERT INTO public.mkt_raw_assets(file_id, asset_name, asset_type, mime_type,
                                    processing_status, uploaded_by_user_id)
  VALUES (v_file,'TEST asset','custom','image/png','not_attempted',v_user) RETURNING id INTO v_asset;

  v_pdf_file := gen_random_uuid();
  INSERT INTO public.files(id, uploaded_by_user_id, original_name, mime_type, size_bytes,
                           storage_bucket, storage_path, kind)
  VALUES (v_pdf_file, v_user, 't.pdf','application/pdf',10,'wassel-files','t/'||v_pdf_file||'.pdf','document');
  INSERT INTO public.mkt_raw_assets(file_id, asset_name, asset_type, mime_type,
                                    processing_status, uploaded_by_user_id)
  VALUES (v_pdf_file,'TEST pdf','custom','application/pdf','not_attempted',v_user) RETURNING id INTO v_pdf;

  -- ── system caller must be able to enqueue ────────────────────────────────
  n1 := public.mkt_asset_enqueue_processing(ARRAY[v_asset], 5);
  IF n1 <> 1 THEN
    RAISE EXCEPTION 'FAILED: system caller could not enqueue (got %) — the worker would be locked out', n1;
  END IF;
  RAISE NOTICE 'PASS: system caller can enqueue';

  -- ── the asset must read as in-flight, not "not attempted" ────────────────
  SELECT processing_status INTO v_status FROM public.mkt_raw_assets WHERE id=v_asset;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'FAILED: queued asset still reads % — the UI would offer to queue it again', v_status;
  END IF;
  RAISE NOTICE 'PASS: queued asset reads pending';

  -- ── no double-queue, even when named explicitly ──────────────────────────
  n2 := public.mkt_asset_enqueue_processing(ARRAY[v_asset], 5);
  IF n2 <> 0 THEN
    RAISE EXCEPTION 'FAILED: re-queued an in-flight asset (% jobs) — a double-click spends twice', n2;
  END IF;
  IF (SELECT count(*) FROM public.mkt_collection_jobs
       WHERE kind='asset_process' AND params->>'asset_id' = v_asset::text) <> 1 THEN
    RAISE EXCEPTION 'FAILED: more than one job exists for the same asset';
  END IF;
  RAISE NOTICE 'PASS: no double-queue';

  -- ── a sweep skips in-flight work but still finds untouched assets ────────
  IF public.mkt_asset_enqueue_processing(NULL, 50) < 1 THEN
    RAISE EXCEPTION 'FAILED: sweep found nothing though an un-analysed asset exists';
  END IF;
  RAISE NOTICE 'PASS: sweep picks up un-analysed assets';

  -- ── terminal states ──────────────────────────────────────────────────────
  PERFORM public.mkt_asset_processing_complete(v_pdf,'unsupported',NULL,NULL,NULL,NULL,'no analyser');
  SELECT processing_status INTO v_status FROM public.mkt_raw_assets WHERE id=v_pdf;
  IF v_status <> 'unsupported' THEN
    RAISE EXCEPTION 'FAILED: a file with no analyser recorded % instead of unsupported', v_status;
  END IF;
  RAISE NOTICE 'PASS: missing analyser is unsupported, not failed';

  -- ── a later partial run must not erase an earlier result ─────────────────
  PERFORM public.mkt_asset_processing_complete(v_asset,'completed','خصم 10%',NULL,'desc',ARRAY['offer_shown'],NULL);
  PERFORM public.mkt_asset_processing_complete(v_asset,'degraded',NULL,NULL,NULL,NULL,'second pass');
  SELECT ocr_text INTO v_ocr FROM public.mkt_raw_assets WHERE id=v_asset;
  IF v_ocr IS DISTINCT FROM 'خصم 10%' THEN
    RAISE EXCEPTION 'FAILED: a degraded second pass wiped the first pass OCR (now %)', coalesce(v_ocr,'NULL');
  END IF;
  RAISE NOTICE 'PASS: partial re-run preserves earlier results';

  -- ── an unknown state must be refused, never stored ───────────────────────
  BEGIN
    PERFORM public.mkt_asset_processing_complete(v_asset,'done');
    RAISE EXCEPTION 'FAILED: an unknown processing state was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: unknown processing state refused';
  END;

  RAISE NOTICE 'ALL ASSET-PROCESSING TESTS PASSED';
END $$;

ROLLBACK;
