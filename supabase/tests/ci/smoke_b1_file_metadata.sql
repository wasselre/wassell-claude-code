-- ============================================================================
-- Smoke assertions for Phase 3 · B1 — Business-file metadata foundation.
--
-- Runs against a database that has had, in order:
--   fixture_file_links.sql → fixture_b1_metadata.sql
--   → 2026-08-10_file_links_projection.sql
--   → 2026-08-12_file_link_sync.sql
--   → 2026-08-16_01_business_file_metadata.sql
--
-- Every assertion RAISEs, so ON_ERROR_STOP=1 turns any failure into a red job.
-- The before/after invariants (edge counts unchanged, migration idempotent,
-- rollback clean) live in run_b1_metadata_test.sh, which can hold state across
-- the apply boundary.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Completeness: every file has the three required fields ───────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.files
   WHERE title IS NULL OR btrim(title) = '' OR document_type IS NULL OR owner_user_id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1.1 completeness: % file(s) missing title/document_type/owner', n;
  END IF;

  -- Owner must equal uploader after a pure backfill — B1 introduces no transfer.
  SELECT count(*) INTO n FROM public.files WHERE owner_user_id <> uploaded_by_user_id;
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1.1 owner: % row(s) where owner <> uploader after backfill', n;
  END IF;

  -- Every document_type must resolve in the vocabulary (the FK proves it, but
  -- assert it explicitly so a future backfill change fails here, not in prod).
  SELECT count(*) INTO n FROM public.files f
   WHERE NOT EXISTS (SELECT 1 FROM public.file_document_types t WHERE t.value = f.document_type);
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1.1 vocabulary: % file(s) carry an unknown document_type', n;
  END IF;
  RAISE NOTICE 'B1.1 completeness OK';
END $$;

-- ── 2. Title derivation, including the two degenerate names ─────────────────
DO $$
DECLARE v text;
BEGIN
  SELECT title INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a1';
  IF v <> 'لقطة للمشروع' THEN RAISE EXCEPTION 'B1.2 title: extension not stripped, got %', v; END IF;

  SELECT title INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a2';
  IF v <> 'ملف بدون امتداد' THEN RAISE EXCEPTION 'B1.2 title: no-extension name mangled, got %', v; END IF;

  -- '.pdf' strips to '' — the fallback must return the whole name.
  SELECT title INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a3';
  IF v <> '.pdf' THEN RAISE EXCEPTION 'B1.2 title: bare-extension fallback failed, got %', v; END IF;
  RAISE NOTICE 'B1.2 title derivation OK';
END $$;

-- ── 3. file_class — exactly the renditions are system ───────────────────────
DO $$
DECLARE n bigint; v text;
BEGIN
  SELECT count(*) INTO n FROM public.files WHERE file_class='system';
  IF n <> 1 THEN RAISE EXCEPTION 'B1.3 file_class: expected exactly 1 system row, got %', n; END IF;

  SELECT file_class INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a5';
  IF v <> 'system' THEN RAISE EXCEPTION 'B1.3 file_class: rendition not classified system'; END IF;

  -- The system row must be exactly the pdf_compress_jobs result, never a guess
  -- from the Arabic "(مضغوط)" in the filename.
  SELECT count(*) INTO n FROM public.files f
   WHERE f.file_class='system'
     AND NOT EXISTS (SELECT 1 FROM public.pdf_compress_jobs j WHERE j.result_file_id=f.id);
  IF n <> 0 THEN RAISE EXCEPTION 'B1.3 file_class: % system row(s) with no compress job', n; END IF;
  RAISE NOTICE 'B1.3 file_class OK';
END $$;

-- ── 4. origin provenance ────────────────────────────────────────────────────
DO $$
DECLARE v text;
BEGIN
  SELECT origin INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a5';
  IF v <> 'derived_rendition'  THEN RAISE EXCEPTION 'B1.4 origin a5: %', v; END IF;
  SELECT origin INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a6';
  IF v <> 'generated_document' THEN RAISE EXCEPTION 'B1.4 origin a6 (document_jobs): %', v; END IF;
  SELECT origin INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a7';
  IF v <> 'generated_document' THEN RAISE EXCEPTION 'B1.4 origin a7 (name pattern): %', v; END IF;
  SELECT origin INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a8';
  IF v <> 'marketing_intake'   THEN RAISE EXCEPTION 'B1.4 origin a8 (mos_assets): %', v; END IF;
  SELECT origin INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a1';
  IF v <> 'user_upload'        THEN RAISE EXCEPTION 'B1.4 origin a1 (default): %', v; END IF;
  RAISE NOTICE 'B1.4 origin OK';
END $$;

-- ── 5. document_type inference: role-derived beats kind, and the priority
--      order is respected for a file carrying more than one role ─────────────
DO $$
DECLARE n bigint; v text;
BEGIN
  -- NON-VACUITY FIRST. If the projection is empty, every rule below is
  -- trivially true and this smoke would certify nothing. The runner calls
  -- file_links_backfill() to prevent that; assert it here too so the SQL is
  -- honest on its own.
  SELECT count(*) INTO n FROM public.file_links WHERE role='floor_plan';
  IF n = 0 THEN RAISE EXCEPTION 'B1.5 vacuous: no floor_plan edge to test priority against'; END IF;

  -- Unambiguous: 'floor_plan' is reachable ONLY from the role mapping, never
  -- from the `kind` fallback. If no file carries it while floor_plan edges
  -- exist, the role-derived branch of the backfill did not run at all — which
  -- is precisely what happened when the fill-in trigger was created before the
  -- backfill instead of after it, and every floor plan silently became a
  -- gallery_image.
  SELECT count(*) INTO n FROM public.files WHERE document_type='floor_plan';
  IF n = 0 THEN
    RAISE EXCEPTION 'B1.5 role inference did not run: floor_plan edges exist but no file is typed floor_plan';
  END IF;

  -- Rule, asserted over whatever the projection actually produced: any file
  -- with a floor_plan edge is a floor_plan, regardless of its other roles.
  SELECT count(*) INTO n FROM public.files f
   WHERE EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id=f.id AND l.role='floor_plan')
     AND f.document_type <> 'floor_plan';
  IF n <> 0 THEN RAISE EXCEPTION 'B1.5 priority: % floor_plan-linked file(s) typed otherwise', n; END IF;

  -- An unlinked file falls back to kind.
  SELECT document_type INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a1';
  IF v <> 'gallery_image' THEN RAISE EXCEPTION 'B1.5 kind fallback image: %', v; END IF;
  SELECT document_type INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a4';
  IF v <> 'video' THEN RAISE EXCEPTION 'B1.5 kind fallback video: %', v; END IF;
  SELECT document_type INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a2';
  IF v <> 'other' THEN RAISE EXCEPTION 'B1.5 kind fallback pdf: %', v; END IF;

  -- No unlinked file may claim a relationship-derived type.
  SELECT count(*) INTO n FROM public.files f
   WHERE NOT EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id=f.id)
     AND f.document_type NOT IN ('gallery_image','video','other');
  IF n <> 0 THEN RAISE EXCEPTION 'B1.5 fabrication: % unlinked file(s) with a derived type', n; END IF;
  RAISE NOTICE 'B1.5 document_type inference OK';
END $$;

-- ── 6. Phase 2 is undisturbed: the backfill dirtied nothing ─────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.file_link_dirty_targets;
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1.6 phase2: dirty target set non-empty after backfill (%)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_locks WHERE locktype='advisory';
  IF n <> 0 THEN RAISE EXCEPTION 'B1.6 phase2: % advisory lock(s) held at rest', n; END IF;

  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile()
   WHERE category='drift';
  IF n <> 0 THEN RAISE EXCEPTION 'B1.6 phase2: reconcile drift is %, expected 0', n; END IF;
  RAISE NOTICE 'B1.6 phase 2 undisturbed OK';
END $$;

-- ── 7. The BEFORE trigger completes a row written the legacy way ────────────
DO $$
DECLARE r public.files%ROWTYPE;
BEGIN
  INSERT INTO public.files
    (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes, storage_bucket, storage_path)
  VALUES
    ('b1000000-0000-0000-0000-0000000000c1','مخطط الدور الأول.png','image','image/png',
     '11111111-1111-1111-1111-111111111111', 90, 'wassel-files','p/c1.png')
  RETURNING * INTO r;

  IF r.title <> 'مخطط الدور الأول' THEN RAISE EXCEPTION 'B1.7 trigger title: %', r.title; END IF;
  IF r.owner_user_id <> r.uploaded_by_user_id THEN RAISE EXCEPTION 'B1.7 trigger owner not filled'; END IF;
  IF r.document_type <> 'gallery_image' THEN RAISE EXCEPTION 'B1.7 trigger type: %', r.document_type; END IF;
  IF r.status <> 'active' OR r.file_class <> 'business' OR r.origin <> 'user_upload'
     OR r.confidentiality <> 'internal' OR r.tags <> '{}'::text[] THEN
    RAISE EXCEPTION 'B1.7 trigger defaults wrong: % % % % %',
      r.status, r.file_class, r.origin, r.confidentiality, r.tags;
  END IF;
  RAISE NOTICE 'B1.7 insert trigger OK';
END $$;

-- ── 8. D3: id_document and contract default to restricted ───────────────────
DO $$
DECLARE v text;
BEGIN
  INSERT INTO public.files
    (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes,
     storage_bucket, storage_path, document_type)
  VALUES
    ('b1000000-0000-0000-0000-0000000000c2','هوية العميل.pdf','pdf','application/pdf',
     '11111111-1111-1111-1111-111111111111', 95, 'wassel-files','p/c2.pdf','id_document');
  SELECT confidentiality INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000c2';
  IF v <> 'restricted' THEN RAISE EXCEPTION 'B1.8 D3 id_document: expected restricted, got %', v; END IF;

  INSERT INTO public.files
    (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes,
     storage_bucket, storage_path, document_type)
  VALUES
    ('b1000000-0000-0000-0000-0000000000c3','عقد بيع.pdf','pdf','application/pdf',
     '11111111-1111-1111-1111-111111111111', 96, 'wassel-files','p/c3.pdf','contract');
  SELECT confidentiality INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000c3';
  IF v <> 'restricted' THEN RAISE EXCEPTION 'B1.8 D3 contract: expected restricted, got %', v; END IF;

  -- An explicit choice must survive the trigger.
  INSERT INTO public.files
    (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes,
     storage_bucket, storage_path, document_type, confidentiality)
  VALUES
    ('b1000000-0000-0000-0000-0000000000c4','هوية عامة.pdf','pdf','application/pdf',
     '11111111-1111-1111-1111-111111111111', 97, 'wassel-files','p/c4.pdf','id_document','public');
  SELECT confidentiality INTO v FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000c4';
  IF v <> 'public' THEN RAISE EXCEPTION 'B1.8 D3: explicit confidentiality overridden, got %', v; END IF;
  RAISE NOTICE 'B1.8 D3 defaults OK';
END $$;

-- ── 9. Constraints actually reject bad data ─────────────────────────────────
DO $$
DECLARE ok boolean;
BEGIN
  ok := false;
  BEGIN
    UPDATE public.files SET status='bogus' WHERE id='b1000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'B1.9 status CHECK did not fire'; END IF;

  ok := false;
  BEGIN
    UPDATE public.files SET confidentiality='secret' WHERE id='b1000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'B1.9 confidentiality CHECK did not fire'; END IF;

  -- archived is a pair: status without archived_at must fail. The BEFORE
  -- trigger fills archived_at, so the violation is provoked from the other side.
  ok := false;
  BEGIN
    UPDATE public.files SET archived_at = now() WHERE id='b1000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'B1.9 archived pair CHECK did not fire'; END IF;

  ok := false;
  BEGIN
    UPDATE public.files SET document_type='not_a_type' WHERE id='b1000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN foreign_key_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'B1.9 document_type FK did not fire'; END IF;

  ok := false;
  BEGIN
    INSERT INTO public.document_links (file_id, model_id, record_id, role)
    VALUES ('b1000000-0000-0000-0000-0000000000a1', gen_random_uuid(), gen_random_uuid(), 'nope');
  EXCEPTION WHEN foreign_key_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'B1.9 document_links.role FK did not fire'; END IF;
  RAISE NOTICE 'B1.9 constraints OK';
END $$;

-- ── 10. The vocabulary ships dark: RLS on, no policies, no role grants ──────
DO $$
DECLARE n bigint; rls boolean;
BEGIN
  SELECT relrowsecurity INTO rls FROM pg_class WHERE oid='public.file_document_types'::regclass;
  IF NOT rls THEN RAISE EXCEPTION 'B1.10 vocabulary: RLS not enabled'; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_document_types';
  IF n <> 0 THEN RAISE EXCEPTION 'B1.10 vocabulary: % policy(ies) present, expected deny-all', n; END IF;

  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='file_document_types'
     AND grantee IN ('anon','authenticated','service_role');
  IF n <> 0 THEN RAISE EXCEPTION 'B1.10 vocabulary: % grant(s) to app roles, expected none', n; END IF;

  SELECT count(*) INTO n FROM public.file_document_types;
  IF n <> 16 THEN RAISE EXCEPTION 'B1.10 vocabulary: expected 16 seeded types, got %', n; END IF;
  RAISE NOTICE 'B1.10 vocabulary dark OK';
END $$;

-- ── 11. Checksums are deliberately absent in B1 ─────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.files WHERE checksum_sha256 IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'B1.11 checksum: % row(s) populated — B7 owns checksums', n;
  END IF;
  RAISE NOTICE 'B1.11 checksum deferral OK';
END $$;

-- ── 12. The timestamp trigger is back on and still works ───────────────────
-- The backfill disables files_set_updated_at by name so it cannot flatten the
-- historical updated_at spread. That bypass is only safe if the trigger is
-- restored, so assert both halves: it is enabled, and it still fires.
DO $$
DECLARE v_state "char"; t0 timestamptz; t1 timestamptz;
BEGIN
  SELECT tgenabled INTO v_state FROM pg_trigger
   WHERE tgrelid='public.files'::regclass AND tgname='files_set_updated_at' AND NOT tgisinternal;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'B1.12 vacuous: files_set_updated_at does not exist — the bypass was never exercised';
  END IF;
  IF v_state <> 'O' THEN
    RAISE EXCEPTION 'B1.12 timestamp trigger left in state %, expected O', v_state;
  END IF;

  SELECT updated_at INTO t0 FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a4';
  UPDATE public.files SET description = 'touched by B1.12'
   WHERE id='b1000000-0000-0000-0000-0000000000a4';
  SELECT updated_at INTO t1 FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a4';
  IF NOT (t1 > t0) THEN
    RAISE EXCEPTION 'B1.12 post-migration edit did not advance updated_at (% -> %)', t0, t1;
  END IF;
  RAISE NOTICE 'B1.12 timestamp trigger restored and working OK';
END $$;

SELECT 'B1 smoke: all assertions passed' AS result;
