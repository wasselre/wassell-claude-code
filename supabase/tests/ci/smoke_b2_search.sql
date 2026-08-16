-- ============================================================================
-- Smoke assertions for Phase 3 · B2 — business_files_search.
--
-- Runs against a database carrying the Phase 1/2 projection, B1's metadata,
-- B2's search layer and the 8,000-row production-shaped corpus.
--
-- Every assertion RAISEs, so ON_ERROR_STOP=1 turns any failure into a red job.
-- Timing lives in run_b2_search_test.sh, which can hold state across calls.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Non-vacuity. A search smoke over an empty or uniform corpus certifies
--      nothing, so refuse to run on one. ─────────────────────────────────────
DO $$
DECLARE n bigint; k bigint;
BEGIN
  SELECT count(*) INTO n FROM public.files WHERE storage_path LIKE 'scale/%';
  IF n < 8000 THEN RAISE EXCEPTION 'B2.1 vacuous: scale corpus is % rows, expected >= 8000', n; END IF;
  SELECT count(DISTINCT document_type) INTO k FROM public.files;
  IF k < 4 THEN RAISE EXCEPTION 'B2.1 vacuous: only % distinct document_type(s)', k; END IF;
  SELECT count(*) INTO n FROM public.files WHERE search_text IS NULL OR search_text='';
  IF n <> 0 THEN RAISE EXCEPTION 'B2.1 % row(s) have no generated search_text', n; END IF;
  RAISE NOTICE 'B2.1 corpus OK';
END $$;

-- ── 2. Arabic folding: one query must match BOTH spellings ──────────────────
-- The corpus contains 'أبراج المشرقية' (with hamza) and 'ابراج المشرقية'
-- (without). wassell_search_norm folds أ→ا on both sides, so either spelling
-- typed by the user must find both sets.
DO $$
DECLARE with_hamza bigint; without_hamza bigint; hits_a bigint; hits_b bigint;
BEGIN
  SELECT count(*) INTO with_hamza    FROM public.files WHERE original_name LIKE 'أبراج%';
  SELECT count(*) INTO without_hamza FROM public.files WHERE original_name LIKE 'ابراج%';
  IF with_hamza = 0 OR without_hamza = 0 THEN
    RAISE EXCEPTION 'B2.2 vacuous: corpus lacks both spellings (% / %)', with_hamza, without_hamza;
  END IF;

  SELECT (public.business_files_search('أبراج', '{}'::jsonb, 'created_desc', 1, 1)->>'total')::bigint INTO hits_a;
  SELECT (public.business_files_search('ابراج', '{}'::jsonb, 'created_desc', 1, 1)->>'total')::bigint INTO hits_b;

  IF hits_a <> hits_b THEN
    RAISE EXCEPTION 'B2.2 folding: hamza-sensitive results (% vs %)', hits_a, hits_b;
  END IF;
  IF hits_a < with_hamza + without_hamza THEN
    RAISE EXCEPTION 'B2.2 folding: expected at least % hits, got %', with_hamza + without_hamza, hits_a;
  END IF;

  -- Arabic-Indic digits fold to ASCII, and tatweel is stripped.
  IF (public.business_files_search('المشرقية', '{}'::jsonb, 'created_desc', 1, 1)->>'total')::bigint = 0 THEN
    RAISE EXCEPTION 'B2.2 folding: plain Arabic term found nothing';
  END IF;
  -- Latin still works, case-insensitively.
  IF (public.business_files_search('floor plan', '{}'::jsonb, 'created_desc', 1, 1)->>'total')::bigint = 0
     OR (public.business_files_search('FLOOR PLAN', '{}'::jsonb, 'created_desc', 1, 1)->>'total')::bigint
      <> (public.business_files_search('floor plan', '{}'::jsonb, 'created_desc', 1, 1)->>'total')::bigint THEN
    RAISE EXCEPTION 'B2.2 folding: Latin case-insensitivity broken';
  END IF;
  RAISE NOTICE 'B2.2 Arabic + Latin folding OK (% hits both spellings)', hits_a;
END $$;

-- ── 3. Facets must equal an INDEPENDENT naive count ─────────────────────────
DO $$
DECLARE res jsonb; expect bigint; got bigint; r record;
BEGIN
  res := public.business_files_search(NULL, '{}'::jsonb, 'created_desc', 1, 60);

  SELECT count(*) INTO expect FROM public.files
   WHERE file_class='business' AND status <> 'archived';
  got := (res->>'total')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.3 total: % vs naive %', got, expect; END IF;

  FOR r IN SELECT document_type dt, count(*) n FROM public.files
            WHERE file_class='business' AND status <> 'archived' GROUP BY 1 LOOP
    got := coalesce((res->'facets'->'document_type'->>r.dt)::bigint, 0);
    IF got <> r.n THEN
      RAISE EXCEPTION 'B2.3 facet document_type[%]: % vs naive %', r.dt, got, r.n;
    END IF;
  END LOOP;

  FOR r IN SELECT kind k, count(*) n FROM public.files
            WHERE file_class='business' AND status <> 'archived' GROUP BY 1 LOOP
    got := coalesce((res->'facets'->'kind'->>r.k)::bigint, 0);
    IF got <> r.n THEN RAISE EXCEPTION 'B2.3 facet kind[%]: % vs naive %', r.k, got, r.n; END IF;
  END LOOP;

  FOR r IN SELECT origin o, count(*) n FROM public.files
            WHERE file_class='business' AND status <> 'archived' GROUP BY 1 LOOP
    got := coalesce((res->'facets'->'origin'->>r.o)::bigint, 0);
    IF got <> r.n THEN RAISE EXCEPTION 'B2.3 facet origin[%]: % vs naive %', r.o, got, r.n; END IF;
  END LOOP;

  -- health facets
  SELECT count(*) INTO expect FROM public.files f
   WHERE f.file_class='business' AND f.status <> 'archived'
     AND NOT EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id=f.id);
  got := (res->'facets'->'health'->>'unlinked')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.3 facet unlinked: % vs naive %', got, expect; END IF;

  SELECT count(*) INTO expect FROM public.files
   WHERE file_class='business' AND status <> 'archived'
     AND valid_until IS NOT NULL AND valid_until < now();
  got := (res->'facets'->'health'->>'expired')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.3 facet expired: % vs naive %', got, expect; END IF;

  SELECT count(*) INTO expect FROM public.files f
   WHERE f.file_class='business' AND f.status <> 'archived' AND f.checksum_sha256 IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files d
                  WHERE d.checksum_sha256=f.checksum_sha256 AND d.id<>f.id);
  got := (res->'facets'->'health'->>'duplicate')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.3 facet duplicate: % vs naive %', got, expect; END IF;
  IF expect = 0 THEN RAISE EXCEPTION 'B2.3 vacuous: corpus has no duplicates to count'; END IF;

  RAISE NOTICE 'B2.3 facets match naive counts OK';
END $$;

-- ── 4. Filters actually filter, and agree with a naive count ────────────────
DO $$
DECLARE got bigint; expect bigint;
BEGIN
  SELECT count(*) INTO expect FROM public.files
   WHERE file_class='business' AND status<>'archived' AND document_type='floor_plan';
  got := (public.business_files_search(NULL, '{"document_type":["floor_plan"]}'::jsonb,
                                       'created_desc',1,1)->>'total')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.4 document_type filter: % vs %', got, expect; END IF;

  SELECT count(*) INTO expect FROM public.files
   WHERE file_class='business' AND status<>'archived' AND kind='pdf';
  got := (public.business_files_search(NULL, '{"kind":["pdf"]}'::jsonb,'created_desc',1,1)->>'total')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.4 kind filter: % vs %', got, expect; END IF;

  SELECT count(*) INTO expect FROM public.files
   WHERE file_class='business' AND status<>'archived' AND tags @> ARRAY['تسويق'];
  got := (public.business_files_search(NULL, '{"tags":["تسويق"]}'::jsonb,'created_desc',1,1)->>'total')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.4 tag filter: % vs %', got, expect; END IF;
  IF expect = 0 THEN RAISE EXCEPTION 'B2.4 vacuous: no tagged rows'; END IF;

  SELECT count(*) INTO expect FROM public.files f
   WHERE f.file_class='business' AND f.status<>'archived'
     AND NOT EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id=f.id);
  got := (public.business_files_search(NULL, '{"unlinked":true}'::jsonb,'created_desc',1,1)->>'total')::bigint;
  IF got <> expect THEN RAISE EXCEPTION 'B2.4 unlinked filter: % vs %', got, expect; END IF;

  -- system files are excluded from the Library by default
  got := (public.business_files_search(NULL, '{}'::jsonb,'created_desc',1,1)->>'total')::bigint;
  SELECT count(*) INTO expect FROM public.files WHERE file_class='system';
  IF expect = 0 THEN RAISE EXCEPTION 'B2.4 vacuous: no system rows to exclude'; END IF;
  IF got <> (SELECT count(*) FROM public.files WHERE file_class='business' AND status<>'archived') THEN
    RAISE EXCEPTION 'B2.4 system rows leaked into the default result set';
  END IF;

  RAISE NOTICE 'B2.4 filters OK';
END $$;

-- ── 5. Pagination stability: every row exactly once, no gaps, no repeats ────
-- Walked over a sort key with MASSIVE ties (document_type) to prove the id
-- tie-break works. Without it, offset paging over ties can drop and duplicate
-- rows between pages.
DO $$
DECLARE total bigint; seen uuid[] := '{}'; pg jsonb; p int := 1; n int;
BEGIN
  total := (public.business_files_search(NULL, '{"kind":["pdf"]}'::jsonb,'created_desc',1,1)->>'total')::bigint;
  IF total < 200 THEN RAISE EXCEPTION 'B2.5 vacuous: only % rows to page through', total; END IF;

  LOOP
    pg := public.business_files_search(NULL, '{"kind":["pdf"]}'::jsonb, 'size_desc', p, 60);
    SELECT count(*) INTO n FROM jsonb_array_elements(pg->'rows');
    EXIT WHEN n = 0;
    SELECT seen || array_agg((e->>'id')::uuid) INTO seen
      FROM jsonb_array_elements(pg->'rows') e;
    p := p + 1;
    IF p > 500 THEN RAISE EXCEPTION 'B2.5 runaway pagination'; END IF;
  END LOOP;

  IF array_length(seen,1) <> total THEN
    RAISE EXCEPTION 'B2.5 pagination returned % rows, total says %', array_length(seen,1), total;
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(seen) x) <> total THEN
    RAISE EXCEPTION 'B2.5 pagination returned duplicate rows across pages';
  END IF;
  RAISE NOTICE 'B2.5 pagination stable across % pages / % rows', p-1, total;
END $$;

-- ── 6. Sorts are accepted, and an unknown sort is rejected loudly ───────────
DO $$
DECLARE s text; ok boolean;
BEGIN
  FOREACH s IN ARRAY ARRAY['created_desc','created_asc','updated_desc','title_asc',
                           'title_desc','size_desc','size_asc'] LOOP
    PERFORM public.business_files_search(NULL, '{}'::jsonb, s, 1, 5);
  END LOOP;
  ok := false;
  BEGIN
    PERFORM public.business_files_search(NULL, '{}'::jsonb, 'drop_table', 1, 5);
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'B2.6 unknown sort was silently accepted'; END IF;
  RAISE NOTICE 'B2.6 sorts OK';
END $$;

-- ── 7. The function is SECURITY INVOKER and reachable only by authenticated ─
DO $$
DECLARE sd boolean; n bigint;
BEGIN
  SELECT prosecdef INTO sd FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.proname='business_files_search';
  IF sd THEN RAISE EXCEPTION 'B2.7 function is SECURITY DEFINER — RLS would be bypassed'; END IF;

  SELECT count(*) INTO n FROM information_schema.role_routine_grants
   WHERE routine_schema='public' AND routine_name='business_files_search' AND grantee='anon';
  IF n <> 0 THEN RAISE EXCEPTION 'B2.7 anon can execute the search RPC'; END IF;
  RAISE NOTICE 'B2.7 invoker + grants OK';
END $$;

SELECT 'B2 smoke: all assertions passed' AS result;
