-- ============================================================================
-- Regression guard for LIVE fact extraction (2026-08-06).
--
-- Run against production or a branch at any time:
--   psql "$DATABASE_URL" -f supabase/tests/mkt_fact_extraction_test.sql
-- or paste into the Supabase SQL editor. Every test runs inside a transaction
-- that ROLLS BACK, so it is safe against production and leaves no residue.
--
-- Each test raises an exception on failure, so a non-zero exit / visible error
-- means the guarantee is broken.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_post   uuid;
  v_media  uuid;
  v_vt     uuid;
  v_facts  int;
  v_price  numeric;
  v_phones int;
  v_before bigint;
  v_after  bigint;
  v_dupes  bigint;
BEGIN
  SELECT id INTO v_post  FROM mkt_content_posts LIMIT 1;
  SELECT id INTO v_media FROM mkt_content_media LIMIT 1;
  IF v_post IS NULL OR v_media IS NULL THEN
    RAISE NOTICE 'SKIP: no content rows to test against';
    RETURN;
  END IF;

  -- ── TEST 1: new OCR content emits facts at write time, no backfill ────────
  INSERT INTO mkt_visual_text
    (content_media_id, content_post_id, source, model, text, structured, status)
  VALUES (v_media, v_post, 'image', '__test_live_emit__', 'اسعار تبدأ من 1,234,000 ريال',
    jsonb_build_object(
      'prices',        jsonb_build_array('اسعار تبدأ من 1,234,000 ريال'),
      -- same number written two ways: must collapse to ONE fact
      'phones',        jsonb_build_array('92000 11 222', '9200011222'),
      'offers',        jsonb_build_array('تقسيط حتى 60 شهر'),
      'districts',     jsonb_build_array('حي الياسمين'),
      'project_names', jsonb_build_array('مشروع الاختبار')),
    'done')
  RETURNING id INTO v_vt;

  SELECT count(*), max(value_num) FILTER (WHERE fact_type='price'),
         count(*) FILTER (WHERE fact_type='phone')
    INTO v_facts, v_price, v_phones
  FROM mkt_observed_facts WHERE source_type='visual_text' AND source_id=v_vt;

  IF v_facts = 0 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: no facts emitted on INSERT (trigger not firing)';
  END IF;
  IF v_price IS DISTINCT FROM 1234000 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: price parsed as %, expected 1234000', v_price;
  END IF;
  IF v_phones <> 1 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: % phone facts, expected 1 (two spellings of one number must collapse)', v_phones;
  END IF;
  RAISE NOTICE 'TEST 1 PASS: % facts emitted live, price=%, phones deduped to %', v_facts, v_price, v_phones;

  -- ── TEST 2: re-emission is idempotent ────────────────────────────────────
  SELECT count(*) INTO v_before FROM mkt_observed_facts;
  PERFORM mkt_emit_facts_visual_text(v_vt);
  PERFORM mkt_emit_facts_visual_text(v_vt);
  SELECT count(*) INTO v_after FROM mkt_observed_facts;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'TEST 2 FAILED: re-emit changed count % -> % (not idempotent)', v_before, v_after;
  END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM mkt_observed_facts
    GROUP BY source_type, source_id, fact_type, normalized_key, extractor
    HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: % duplicate fact groups', v_dupes;
  END IF;
  RAISE NOTICE 'TEST 2 PASS: idempotent, 0 duplicate groups';

  -- ── TEST 3: updating the artifact REPLACES its facts (no stale rows) ─────
  UPDATE mkt_visual_text
  SET structured = jsonb_build_object('prices', jsonb_build_array('999,000 ريال'))
  WHERE id = v_vt;

  SELECT count(*), max(value_num) FILTER (WHERE fact_type='price')
    INTO v_facts, v_price
  FROM mkt_observed_facts WHERE source_type='visual_text' AND source_id=v_vt;

  IF v_facts <> 1 OR v_price IS DISTINCT FROM 999000 THEN
    RAISE EXCEPTION 'TEST 3 FAILED: after UPDATE expected exactly 1 fact @999000, got % facts @%', v_facts, v_price;
  END IF;
  RAISE NOTICE 'TEST 3 PASS: re-extraction replaced stale facts';

  RAISE NOTICE 'ALL FACT-EXTRACTION TESTS PASSED';
END $$;

-- ── TEST 4: a broken extractor must NOT destroy the collected artifact ──────
-- Collected OCR costs real money and is unrecoverable; facts are regenerable.
DO $$
DECLARE v_post uuid; v_media uuid; v_saved int; v_facts int;
BEGIN
  SELECT id INTO v_post  FROM mkt_content_posts LIMIT 1;
  SELECT id INTO v_media FROM mkt_content_media LIMIT 1;
  IF v_post IS NULL THEN RETURN; END IF;

  CREATE OR REPLACE FUNCTION public.mkt_emit_facts_visual_text(p_vt_id uuid)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
  BEGIN RAISE EXCEPTION 'simulated extractor bug'; END $f$;

  INSERT INTO mkt_visual_text
    (content_media_id, content_post_id, source, model, text, structured, status)
  VALUES (v_media, v_post, 'image', '__test_broken_extractor__', 'نص',
          jsonb_build_object('prices', jsonb_build_array('500,000 ريال')), 'done');

  SELECT count(*) INTO v_saved FROM mkt_visual_text WHERE model='__test_broken_extractor__';
  SELECT count(*) INTO v_facts FROM mkt_observed_facts f
    JOIN mkt_visual_text v ON v.id=f.source_id WHERE v.model='__test_broken_extractor__';

  IF v_saved <> 1 THEN
    RAISE EXCEPTION 'TEST 4 FAILED: artifact lost when extractor errored (% saved)', v_saved;
  END IF;
  IF v_facts <> 0 THEN
    RAISE EXCEPTION 'TEST 4 FAILED: expected 0 facts from broken extractor, got %', v_facts;
  END IF;
  RAISE NOTICE 'TEST 4 PASS: artifact survived a broken extractor (facts skipped, warning logged)';
END $$;

-- ROLLBACK restores the real extractor and discards every test row.
ROLLBACK;
