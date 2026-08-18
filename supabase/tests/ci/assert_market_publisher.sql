\set ON_ERROR_STOP on

-- canonical object as the aqar adapter emits it (reused across calls)
SELECT (jsonb_build_object(
  'external_id','9999001','source','aqar',
  'title','شقة للبيع في حي النزهة','description','وصف تجريبي',
  'price',990000,'area',80,'bedrooms',2,'bathrooms',2,
  'property_type','شقة','property_category','شقق-للبيع',
  'latitude',24.760451,'longitude',46.707711,
  'image_urls', jsonb_build_array('https://images.aqar.fm/a.jpg','https://images.aqar.fm/b.jpg'),
  'video_url','https://stream/v.m3u8',
  'street','شارع تجريبي','listing_url','https://sa.aqar.fm/9999001',
  'date_posted','2026-08-17T12:00:00Z',
  'features', jsonb_build_array('مدخل سيارة','موقف خاص')))::text AS canon \gset

-- ── 1) gate: publishing_enabled=false → controlled no-op ─────────────────────
SET ROLE service_role;
SELECT (public.market_listing_publish('aqar','9999001', :'canon'::jsonb))->>'reason' AS r1 \gset
RESET ROLE;
SELECT CASE WHEN :'r1'='publishing_disabled' THEN 'OK gate: publishing_disabled' ELSE 1/0||'' END AS a1;

-- enable publishing (owner-only setup)
UPDATE public.listing_sources SET publishing_enabled=true WHERE source_key='aqar';

-- ── 2) enabled but not allowlisted → no-op ───────────────────────────────────
SET ROLE service_role;
SELECT (public.market_listing_publish('aqar','9999001', :'canon'::jsonb))->>'reason' AS r2 \gset
RESET ROLE;
SELECT CASE WHEN :'r2'='not_allowlisted' THEN 'OK gate: not_allowlisted' ELSE 1/0||'' END AS a2;

-- allowlist the canary ids
INSERT INTO public.market_publish_allowlist(source,external_id,note) VALUES
  ('aqar','9999001','canary'),('aqar','9999002','canary'),('aqar','9999003','canary');

-- ── 3) publish → INSERT ──────────────────────────────────────────────────────
SET ROLE service_role;
SELECT public.market_listing_publish('aqar','9999001', :'canon'::jsonb)::text AS p3 \gset
-- ── 4) publish again (same bytes) → UPDATE, idempotent (no dup row) ──────────
SELECT public.market_listing_publish('aqar','9999001', :'canon'::jsonb)::text AS p4 \gset
RESET ROLE;
SELECT CASE WHEN (:'p3'::jsonb->>'published')::bool AND :'p3'::jsonb->>'action'='insert' THEN 'OK insert' ELSE 1/0||'' END AS a3;
SELECT CASE WHEN (:'p4'::jsonb->>'published')::bool AND :'p4'::jsonb->>'action'='update' THEN 'OK update' ELSE 1/0||'' END AS a4;

DO $v$
DECLARE v_rows int; v_price numeric; v_ver int; v_imgs int; v_prov int; v_ev int; v_ob int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.market_listings WHERE source='aqar' AND external_id='9999001';
  SELECT price, version, jsonb_array_length(image_urls) INTO v_price, v_ver, v_imgs FROM public.market_listings WHERE external_id='9999001';
  SELECT count(*) INTO v_prov FROM public.listing_field_provenance p JOIN public.market_listings m ON m.id=p.record_id WHERE m.external_id='9999001';
  SELECT count(*) INTO v_ev FROM public.listing_change_events WHERE external_id='9999001';
  SELECT count(*) INTO v_ob FROM public.mirror_outbox o JOIN public.market_listings m ON m.id=o.record_id WHERE m.external_id='9999001';
  IF v_rows<>1 THEN RAISE EXCEPTION 'FAIL rows=% (dup on update?)',v_rows; END IF;
  IF v_price<>990000 THEN RAISE EXCEPTION 'FAIL price=%',v_price; END IF;
  IF v_ver<>2 THEN RAISE EXCEPTION 'FAIL version=% (expected 2 after insert+update)',v_ver; END IF;
  IF v_imgs<>2 THEN RAISE EXCEPTION 'FAIL image_urls len=%',v_imgs; END IF;
  IF v_prov<>1 THEN RAISE EXCEPTION 'FAIL provenance rows=%',v_prov; END IF;
  IF v_ev<>2 THEN RAISE EXCEPTION 'FAIL change_events=% (expected 2: insert+update)',v_ev; END IF;
  IF v_ob<>1 THEN RAISE EXCEPTION 'FAIL outbox=% (dedup expected 1)',v_ob; END IF;
  RAISE NOTICE 'OK persisted: 1 row / price 990000 / version 2 / 2 imgs / 1 prov / 2 events / 1 outbox (dedup)';
END $v$;

-- ── 5) destructive change (>50% price swing) → quarantined, row unchanged ────
SET ROLE service_role;
SELECT (public.market_listing_publish('aqar','9999001', (:'canon'::jsonb || '{"price":3000000}'::jsonb)))->>'reason' AS r5 \gset
RESET ROLE;
SELECT CASE WHEN :'r5'='quarantined_destructive' THEN 'OK destructive quarantined' ELSE 1/0||'' END AS a5;
DO $v$
DECLARE v_price numeric; v_rev int;
BEGIN
  SELECT price INTO v_price FROM public.market_listings WHERE external_id='9999001';
  SELECT count(*) INTO v_rev FROM public.listing_change_review WHERE external_id='9999001' AND resolved=false;
  IF v_price<>990000 THEN RAISE EXCEPTION 'FAIL destructive applied! price=%',v_price; END IF;
  IF v_rev<1 THEN RAISE EXCEPTION 'FAIL no review row for destructive change'; END IF;
  RAISE NOTICE 'OK destructive: price unchanged 990000, review row present';
END $v$;

-- ── 6) missing required (title null) → not published, review row ─────────────
SET ROLE service_role;
SELECT (public.market_listing_publish('aqar','9999002',
   (jsonb_build_object('external_id','9999002','source','aqar','price',500000) )))->>'reason' AS r6 \gset
RESET ROLE;
SELECT CASE WHEN :'r6'='missing_required' THEN 'OK missing_required' ELSE 1/0||'' END AS a6;
DO $v$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.market_listings WHERE external_id='9999002';
  IF v_rows<>0 THEN RAISE EXCEPTION 'FAIL missing-required wrote a row'; END IF;
  RAISE NOTICE 'OK missing_required: no listing written';
END $v$;

-- ── 7) ambiguous identity (2 rows already match) → rejected ──────────────────
INSERT INTO public.market_listings (id, source, external_id, title, price, version) VALUES
  (gen_random_uuid(),'aqar','9999003','A',100,1),
  (gen_random_uuid(),'aqar','9999003','B',200,1);
SET ROLE service_role;
SELECT (public.market_listing_publish('aqar','9999003',
   (jsonb_build_object('external_id','9999003','source','aqar','title','X','price',300))))->>'reason' AS r7 \gset
RESET ROLE;
SELECT CASE WHEN :'r7'='ambiguous_identity' THEN 'OK ambiguous_identity rejected' ELSE 1/0||'' END AS a7;

-- ── 8) ACL: authenticated cannot EXECUTE the publisher ──────────────────────
DO $v$
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.market_listing_publish('aqar','9999001','{}'::jsonb);
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: authenticated could call market_listing_publish';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK authenticated denied EXECUTE (insufficient_privilege)';
  END;
END $v$;
RESET ROLE;

\echo ==== PHASE 3 PUBLISHER VALIDATION: ALL CHECKS PASSED ====
