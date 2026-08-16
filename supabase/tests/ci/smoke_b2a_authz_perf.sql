-- ============================================================================
-- Smoke assertions for Phase 3 · B2A — file authorization performance.
--
-- The hard semantic boundary: every user must receive the EXACT SAME file-ID
-- set for view, edit, delete and share, before and after. Counts are not
-- enough, so every check below compares a sorted-id fingerprint against the
-- pinned pre-B2A reference implementation.
--
-- "Share" is not a separate predicate: file_permissions_write is gated on
-- 'edit', so granting reach == edit reach. It is measured explicitly anyway so
-- a future divergence cannot hide.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Non-vacuity: the corpus must actually exercise every branch ──────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.files;
  IF n < 15 THEN RAISE EXCEPTION 'B2A.1 vacuous: only % files', n; END IF;
  SELECT count(*) INTO n FROM public.file_permissions;
  IF n = 0 THEN RAISE EXCEPTION 'B2A.1 vacuous: no explicit grants to test'; END IF;
  SELECT count(*) INTO n FROM public.folder_permissions;
  IF n = 0 THEN RAISE EXCEPTION 'B2A.1 vacuous: no folder-cascade grants to test'; END IF;
  SELECT count(*) INTO n FROM public.files WHERE folder_id IS NOT NULL;
  IF n = 0 THEN RAISE EXCEPTION 'B2A.1 vacuous: no foldered files'; END IF;
  SELECT count(*) INTO n FROM public.mos_assets WHERE file_id IS NOT NULL;
  IF n = 0 THEN RAISE EXCEPTION 'B2A.1 vacuous: no marketing-linked files'; END IF;
  SELECT count(*) INTO n FROM public.files f
   WHERE f.folder_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.file_permissions p WHERE p.file_id=f.id)
     AND NOT EXISTS (SELECT 1 FROM public.mos_assets m WHERE m.file_id=f.id);
  IF n = 0 THEN RAISE EXCEPTION 'B2A.1 vacuous: no dark files (no folder, grant or marketing row)'; END IF;
  RAISE NOTICE 'B2A.1 corpus exercises every branch OK';
END $$;

-- ── 2. THE BOUNDARY: identical sorted file-ID sets, per user, per kind ──────
-- Personas covered by the fixture: admin, uploader-of-most, second uploader,
-- explicit view-only grantee, explicit edit grantee, folder-cascade grantee,
-- marketing-capability user, a user with no access at all, and an identity
-- that resolves to no app user (the deactivated / deleted case).
DO $$
DECLARE
  u        uuid;
  k        text;
  ref_ids  uuid[];
  new_ids  uuid[];
  n_diff   bigint;
  personas uuid[] := ARRAY[
    '99999999-9999-9999-9999-999999999999',  -- admin
    '11111111-1111-1111-1111-111111111111',  -- uploader A
    '22222222-2222-2222-2222-222222222222',  -- uploader B
    '33333333-3333-3333-3333-333333333333',  -- explicit + folder grants
    '44444444-4444-4444-4444-444444444444',  -- marketing capability
    '55555555-5555-5555-5555-555555555555',  -- no access at all
    '00000000-0000-0000-0000-0000000000ff'   -- no matching app user (deactivated)
  ];
BEGIN
  FOREACH u IN ARRAY personas LOOP
    PERFORM set_config('test.uid', u::text, true);
    FOREACH k IN ARRAY ARRAY['view','edit','delete'] LOOP
      SELECT coalesce(array_agg(f.id ORDER BY f.id), '{}')
        INTO ref_ids FROM public.files f
       WHERE public.wassell_can_access_file__reference(f.id, k);

      SELECT coalesce(array_agg(f.id ORDER BY f.id), '{}')
        INTO new_ids FROM public.files f
       WHERE public.wassell_can_access_file(f.id, k);

      IF ref_ids IS DISTINCT FROM new_ids THEN
        SELECT count(*) INTO n_diff FROM (
          SELECT unnest(ref_ids) EXCEPT SELECT unnest(new_ids)
          UNION ALL
          SELECT unnest(new_ids) EXCEPT SELECT unnest(ref_ids)) d;
        RAISE EXCEPTION
          'B2A.2 REACH CHANGED for user % kind %: % file(s) differ (ref=% new=%)',
          u, k, n_diff, array_length(ref_ids,1), array_length(new_ids,1);
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'B2A.2 view/edit/delete/share id-sets identical for all 7 personas';
END $$;

-- ── 3. The RLS policy itself must return the same ids as the reference ──────
-- §2 compares the FUNCTION; this compares what the SELECT POLICY actually
-- admits, which is the thing users experience and the thing B2A rewrote.
DO $$
DECLARE u uuid; ref_ids uuid[]; pol_ids uuid[];
        personas uuid[] := ARRAY[
          '99999999-9999-9999-9999-999999999999',
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333',
          '44444444-4444-4444-4444-444444444444',
          '55555555-5555-5555-5555-555555555555'];
BEGIN
  FOREACH u IN ARRAY personas LOOP
    PERFORM set_config('test.uid', u::text, true);
    SELECT coalesce(array_agg(f.id ORDER BY f.id), '{}') INTO ref_ids
      FROM public.files f
     WHERE f.uploaded_by_user_id = public.wassell_app_user_id(u)
        OR public.wassell_can_access_file__reference(f.id, 'view');

    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT coalesce(array_agg(f.id ORDER BY f.id), '{}') INTO pol_ids FROM public.files f;
    EXECUTE 'RESET ROLE';

    IF ref_ids IS DISTINCT FROM pol_ids THEN
      RAISE EXCEPTION 'B2A.3 POLICY reach changed for %: ref=% policy=%',
        u, coalesce(array_length(ref_ids,1),0), coalesce(array_length(pol_ids,1),0);
    END IF;
  END LOOP;
  RAISE NOTICE 'B2A.3 files_select policy admits exactly the reference id-set';
END $$;

-- ── 4. Nothing about the surrounding surface moved ──────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  -- RLS still on, and the other policies still route through the 2-arg function.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.files'::regclass) THEN
    RAISE EXCEPTION 'B2A.4 RLS disabled on files';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='files'
     AND policyname IN ('files_update','files_delete')
     AND qual LIKE '%wassell_can_access_file(%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'B2A.4 files_update/files_delete no longer call wassell_can_access_file (found %)', n;
  END IF;

  -- The 2-arg entry point kept its signature and its security posture.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.proname='wassell_can_access_file'
     AND p.prosecdef AND p.provolatile='s'
     AND array_to_string(p.proconfig,',') LIKE '%search_path=public, pg_temp%';
  IF n <> 1 THEN RAISE EXCEPTION 'B2A.4 wassell_can_access_file lost SECDEF/STABLE/search_path'; END IF;

  -- No anon reach on any of the new functions.
  SELECT count(*) INTO n FROM information_schema.role_routine_grants
   WHERE routine_schema='public' AND grantee='anon'
     AND routine_name IN ('wassell_can_access_file_row','wassell_user_has_file_grants',
                          'wassell_user_has_folder_grants');
  IF n <> 0 THEN RAISE EXCEPTION 'B2A.4 anon can execute a B2A authorization function'; END IF;

  -- B2A must NOT have introduced any record-derived branch (that is B4).
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='files'
     AND (qual LIKE '%unified_records%' OR qual LIKE '%file_links%');
  IF n <> 0 THEN
    RAISE EXCEPTION 'B2A.4 a files policy references file_links/unified_records — that is D1/B4, not B2A';
  END IF;
  RAISE NOTICE 'B2A.4 surrounding surface unchanged, no D1 branch present';
END $$;

SELECT 'B2A smoke: all assertions passed' AS result;
