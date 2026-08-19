-- ============================================================================
-- Phase 3 · B5 — smoke assertions for 2026-08-19_10_file_views.sql
--
-- Run by supabase/tests/ci/run_b5_file_views_test.sh against an ephemeral
-- Postgres 17 that already carries the B1 fixture (files, users,
-- file_document_types) and the B5 migration.
--
-- What this proves, and why each one is here:
--   1. the objects exist with the grants and policies the migration claims
--   2. a saved view is OWNED — a private one is invisible to a colleague, a
--      shared one is visible but not writable by them
--   3. nobody can write a row on someone else's behalf
--   4. a saved sort can never be one business_files_search would reject
--   5. saving the same NAME updates rather than duplicating
--   6. the document-type vocabulary became readable, and ONLY the active rows
--
-- Every assertion RAISES on failure, so a red step is a real failure rather
-- than output somebody has to read.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages = warning;

DO $smoke$
DECLARE
  v_a   uuid;                       -- user A (the author)
  v_b   uuid;                       -- user B (a colleague)
  v_n   integer;
  v_txt text;
  v_id  uuid;
BEGIN
  SELECT id INTO v_a FROM public.users ORDER BY id LIMIT 1;
  SELECT id INTO v_b FROM public.users WHERE id <> v_a ORDER BY id LIMIT 1;
  IF v_a IS NULL OR v_b IS NULL THEN
    -- NON-VACUITY. Every ownership assertion below needs TWO distinct users;
    -- with one, "B cannot see A's view" would pass because B does not exist.
    RAISE EXCEPTION 'B5 smoke: fixture needs at least two users, found %',
      (SELECT count(*) FROM public.users);
  END IF;

  -- ── 1. structure ────────────────────────────────────────────────────────
  IF to_regclass('public.file_views') IS NULL THEN
    RAISE EXCEPTION 'B5.1: file_views does not exist';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_views';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'B5.1: expected 4 policies on file_views, found %', v_n;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.file_views'::regclass) THEN
    RAISE EXCEPTION 'B5.1: RLS is not enabled on file_views';
  END IF;

  -- anon must hold NOTHING. Supabase's ALTER DEFAULT PRIVILEGES grants ALL on
  -- every new public table to anon/authenticated, and REVOKE ... FROM PUBLIC
  -- does not touch a role-specific grant — this repo already shipped a table
  -- to production with both roles holding full DML for exactly that reason.
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='file_views' AND grantee='anon';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'B5.1: anon holds % grant(s) on file_views', v_n;
  END IF;

  -- ── 4. a bad sort or a non-object filter cannot be stored ───────────────
  --    Checked BEFORE the RLS work so a failure here is unambiguous.
  BEGIN
    INSERT INTO public.file_views (name, owner_user_id, sort)
    VALUES ('bad sort', v_a, 'relevance');
    RAISE EXCEPTION 'B5.4: an unknown sort was accepted — business_files_search would raise on every open';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.file_views (name, owner_user_id, filters)
    VALUES ('bad filters', v_a, '[]'::jsonb);
    RAISE EXCEPTION 'B5.4: a non-object filters value was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.file_views (name, owner_user_id) VALUES ('   ', v_a);
    RAISE EXCEPTION 'B5.4: a blank name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 5. save-or-update by name ──────────────────────────────────────────
  INSERT INTO public.file_views (name, owner_user_id, filters, grouping, sort, layout, visibility)
  VALUES ('smoke view', v_a, '{"document_type":["floor_plan"]}'::jsonb,
          'document_type', 'title_asc', 'list', 'private')
  RETURNING id INTO v_id;

  BEGIN
    -- Same owner, same name, different case and padding: the unique index is
    -- on lower(btrim(name)), so this must COLLIDE rather than create a twin.
    INSERT INTO public.file_views (name, owner_user_id) VALUES ('  Smoke View  ', v_a);
    RAISE EXCEPTION 'B5.5: a case/whitespace variant of an existing name created a second row';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- The same name under a DIFFERENT owner is a different view and must work.
  INSERT INTO public.file_views (name, owner_user_id) VALUES ('smoke view', v_b);

  SELECT count(*) INTO v_n FROM public.file_views WHERE lower(btrim(name)) = 'smoke view';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'B5.5: expected one "smoke view" per owner (2), found %', v_n;
  END IF;

  -- ── the touch trigger OWNS updated_at ──────────────────────────────────
  --
  -- Note what is NOT asserted: that updated_at advances between two writes in
  -- this block. It cannot — `now()` is the TRANSACTION timestamp, constant for
  -- the whole DO block, and pg_sleep does not move it. An earlier draft of
  -- this test asserted exactly that and failed against a perfectly correct
  -- trigger.
  --
  -- What IS provable, and is the thing that matters: a client cannot write
  -- updated_at itself. The trigger overwrites whatever the statement supplies,
  -- so a stale or forged timestamp can never be stored.
  UPDATE public.file_views
     SET pinned = true, updated_at = timestamptz '1999-01-01'
   WHERE id = v_id;
  SELECT updated_at::text INTO v_txt FROM public.file_views WHERE id = v_id;
  IF v_txt LIKE '1999%' THEN
    RAISE EXCEPTION 'B5.5: a client-supplied updated_at was stored (%) — the touch trigger did not fire', v_txt;
  END IF;
  IF (SELECT updated_at FROM public.file_views WHERE id = v_id) <> now() THEN
    RAISE EXCEPTION 'B5.5: updated_at is not the transaction timestamp after a write';
  END IF;

  -- ── 6. the document-type vocabulary ────────────────────────────────────
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_document_types' AND cmd='SELECT';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'B5.6: expected exactly 1 SELECT policy on file_document_types, found %', v_n;
  END IF;

  -- Writes stay closed: changing the vocabulary is a migration, because every
  -- value is referenced by an FK from files.document_type.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_document_types' AND cmd <> 'SELECT';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'B5.6: file_document_types has % write policy/policies', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='file_document_types'
     AND grantee='authenticated' AND privilege_type='SELECT';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'B5.6: authenticated has no SELECT grant on file_document_types';
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='file_document_types'
     AND grantee='authenticated' AND privilege_type <> 'SELECT';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'B5.6: authenticated holds % write grant(s) on file_document_types', v_n;
  END IF;

  DELETE FROM public.file_views;
  RAISE NOTICE 'B5 smoke (structure, constraints, vocabulary): PASS';
END
$smoke$;

-- ---------------------------------------------------------------------------
-- 2 + 3. Ownership under REAL RLS.
--
-- These cannot live in the DO block above: a DO block runs as the invoking
-- superuser, for whom RLS is not enforced at all, so every assertion would
-- pass vacuously. Each statement below runs as `authenticated` with a JWT
-- claim, which is the only way to exercise the policies. (The same lesson the
-- B2A work recorded: measuring RLS needs SET LOCAL ROLE, not just claims.)
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_a uuid; v_b uuid;
  v_auth_a uuid; v_auth_b uuid;
  v_has_auth boolean;
BEGIN
  SELECT id INTO v_a FROM public.users ORDER BY id LIMIT 1;
  SELECT id INTO v_b FROM public.users WHERE id <> v_a ORDER BY id LIMIT 1;

  -- Which uuid to impersonate depends on the environment, and getting it wrong
  -- makes every assertion below pass for the wrong reason:
  --   production   users.auth_uid -> users.id via wassell_app_user_id
  --   CI fixture   has no auth_uid column at all, and its wassell_app_user_id
  --                is the identity function, so the app user id IS the claim
  -- The column is probed rather than assumed, because reading a column that
  -- does not exist is an error, not a NULL.
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='users'
                    AND column_name='auth_uid') INTO v_has_auth;
  IF v_has_auth THEN
    EXECUTE 'SELECT auth_uid FROM public.users WHERE id = $1' INTO v_auth_a USING v_a;
    EXECUTE 'SELECT auth_uid FROM public.users WHERE id = $1' INTO v_auth_b USING v_b;
  END IF;
  v_auth_a := coalesce(v_auth_a, v_a);
  v_auth_b := coalesce(v_auth_b, v_b);

  PERFORM set_config('b5.user_a', v_a::text, false);
  PERFORM set_config('b5.user_b', v_b::text, false);
  PERFORM set_config('b5.auth_a', v_auth_a::text, false);
  PERFORM set_config('b5.auth_b', v_auth_b::text, false);

  INSERT INTO public.file_views (name, owner_user_id, visibility)
  VALUES ('a private', v_a, 'private'), ('a shared', v_a, 'shared');
END
$seed$;

BEGIN;
  SET LOCAL ROLE authenticated;
  -- Impersonation is set THREE ways on purpose, because auth.uid() is not one
  -- function — it is whichever stub the surrounding environment defines:
  --   production            reads request.jwt.claims ->> 'sub'
  --   fixture_file_links    reads current_setting('test.uid')
  --   bootstrap_fixture     reads current_setting('request.jwt.claim.sub')
  -- Setting only the production shape resolves to NULL under the CI fixture,
  -- which the non-vacuity guard below would (correctly) report as a failure.
  -- Setting all three is what makes this file mean the same thing in both.
  SELECT set_config('request.jwt.claims',
                    json_build_object('sub', current_setting('b5.auth_b'),
                                      'role', 'authenticated')::text, true);
  SELECT set_config('test.uid', current_setting('b5.auth_b'), true);
  SELECT set_config('request.jwt.claim.sub', current_setting('b5.auth_b'), true);

  DO $b$
  DECLARE v_n integer; v_me uuid;
  BEGIN
    -- NON-VACUITY, and the most important line in this file. If the claim does
    -- not resolve to user B, then B is NOBODY — and "B cannot see A's private
    -- view", "B cannot update", "B cannot delete" all pass because a null
    -- identity can do nothing at all. The suite would be green while testing
    -- the opposite of what it claims.
    v_me := public.wassell_app_user_id((SELECT auth.uid()));
    IF v_me IS DISTINCT FROM current_setting('b5.user_b')::uuid THEN
      RAISE EXCEPTION 'B5.2: impersonation resolved to %, expected user B (%) — every assertion below would be vacuous',
        coalesce(v_me::text, '<null>'), current_setting('b5.user_b');
    END IF;

    SELECT count(*) INTO v_n FROM public.file_views WHERE name = 'a private';
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'B5.2: user B can see user A''s PRIVATE view';
    END IF;

    SELECT count(*) INTO v_n FROM public.file_views WHERE name = 'a shared';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'B5.2: user B cannot see user A''s SHARED view (found %)', v_n;
    END IF;

    -- Shared means readable, NOT writable. A refused UPDATE/DELETE comes back
    -- as zero rows, not as an error, which is why the count is asserted.
    UPDATE public.file_views SET name = 'hijacked' WHERE name = 'a shared';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'B5.2: user B UPDATEd a shared view they do not own (% row(s))', v_n;
    END IF;

    DELETE FROM public.file_views WHERE name = 'a shared';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'B5.2: user B DELETEd a shared view they do not own (% row(s))', v_n;
    END IF;

    -- 3. And cannot forge a row owned by someone else.
    BEGIN
      INSERT INTO public.file_views (name, owner_user_id)
      VALUES ('forged', current_setting('b5.user_a')::uuid);
      RAISE EXCEPTION 'B5.3: user B inserted a view owned by user A';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    RAISE NOTICE 'B5 smoke (ownership under RLS): PASS';
  END
  $b$;
ROLLBACK;

DELETE FROM public.file_views;

\echo 'B5 file_views smoke: ALL ASSERTIONS PASSED'
