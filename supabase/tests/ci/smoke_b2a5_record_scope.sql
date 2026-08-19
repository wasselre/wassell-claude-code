-- ============================================================================
-- Structural smoke for B2A.5. Asserts the properties the fingerprint runs
-- cannot see: that the policy still contains the original term, that the fast
-- path agrees with the authority it duplicates, and that the helper is safe to
-- call directly.
-- ============================================================================
\set ON_ERROR_STOP on

-- ── 1. The policy is still FASTPATH OR ORIGINAL ────────────────────────────
-- Narrowing is prevented structurally, not by measurement — but only as long as
-- the original term is actually still in the qual. If a later edit "tidies" it
-- away, every equivalence result in this suite becomes meaningless, so assert
-- it directly.
DO $$
DECLARE q text; r text; p text;
BEGIN
  SELECT qual, roles::text, permissive INTO q, r, p
    FROM pg_policies WHERE schemaname='public' AND tablename='records' AND policyname='records_view';
  IF q IS NULL THEN RAISE EXCEPTION 'records_view is missing'; END IF;
  IF q NOT LIKE '%wassell_can_view_record%' THEN
    RAISE EXCEPTION 'records_view no longer contains the original per-row term; narrowing is no longer impossible: %', q;
  END IF;
  IF q NOT LIKE '%wassell_my_view_scope_all_models%' THEN
    RAISE EXCEPTION 'records_view is missing the fast path: %', q;
  END IF;
  IF p <> 'PERMISSIVE' THEN RAISE EXCEPTION 'records_view must stay PERMISSIVE, is %', p; END IF;
  IF r <> '{authenticated}' THEN RAISE EXCEPTION 'records_view role list changed: %', r; END IF;
  RAISE NOTICE 'smoke 1 OK: policy is fastpath OR original, PERMISSIVE, TO authenticated';
END $$;

-- ── 2. The fast path agrees with wassell_view_scope_class, every pair ──────
-- wassell_my_view_scope_all_models duplicates a classification that already
-- exists. Duplicated authority drifts — B2A.4's whole side-door problem was two
-- authorities disagreeing. This is the guard that catches it, and it mirrors
-- the 343-pair check run against production before shipping.
DO $$
DECLARE
  u record; m record; bad int := 0; pairs int := 0; cls text; in_set boolean;
  detail text := '';
BEGIN
  -- Includes the ghost identity, which has no users row, so the loop covers the
  -- "unknown caller" pair as well as the seven real ones.
  FOR u IN SELECT auth_uid FROM public.users
           UNION ALL SELECT '00000000-0000-0000-0000-0000000000ff'::uuid LOOP
    PERFORM set_config('test.uid', u.auth_uid::text, true);
    FOR m IN SELECT id, name FROM public.models LOOP
      cls := public.wassell_view_scope_class(u.auth_uid, m.id);
      SELECT EXISTS (SELECT 1 FROM public.wassell_my_view_scope_all_models() s
                      WHERE s.model_id = m.id) INTO in_set;
      pairs := pairs + 1;
      IF (cls = 'all') <> in_set THEN
        bad := bad + 1;
        detail := detail || format('%s/%s: class=%s fastpath=%s; ',
                                   left(u.auth_uid::text,8), m.name, cls, in_set);
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('test.uid', '', true);

  IF bad > 0 THEN
    RAISE EXCEPTION 'fast path disagrees with wassell_view_scope_class on % of % pair(s): %',
      bad, pairs, detail;
  END IF;
  RAISE NOTICE 'smoke 2 OK: fast path agrees with wassell_view_scope_class on all % (user, model) pairs', pairs;
END $$;

-- ── 3. Non-vacuity for smoke 2 ─────────────────────────────────────────────
-- An agreement check where nothing is ever 'all' and the set is always empty
-- passes trivially. Require both classes to be present.
DO $$
DECLARE n_all int; n_not int;
BEGIN
  SELECT count(*) FILTER (WHERE c = 'all'), count(*) FILTER (WHERE c <> 'all')
    INTO n_all, n_not
  FROM (SELECT public.wassell_view_scope_class(u.auth_uid, m.id) AS c
          FROM public.users u CROSS JOIN public.models m) z;
  IF n_all = 0 OR n_not = 0 THEN
    RAISE EXCEPTION 'agreement check is vacuous: % all / % non-all pairs', n_all, n_not;
  END IF;
  RAISE NOTICE 'smoke 3 OK: agreement check is non-vacuous (% all / % non-all)', n_all, n_not;
END $$;

-- ── 4. The helper is caller-scoped and safe to call directly ───────────────
-- It is SECURITY DEFINER and set-returning, so PostgREST publishes it at
-- /rest/v1/rpc/. It must take no target user, must be empty for an
-- unauthenticated caller, and must not be reachable by anon.
DO $$
DECLARE n int; args text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid) INTO args
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname='public' AND p.proname='wassell_my_view_scope_all_models';
  IF coalesce(args,'') <> '' THEN
    RAISE EXCEPTION 'helper takes arguments (%) — it must be caller-scoped with nothing to forge', args;
  END IF;

  PERFORM set_config('test.uid', '', true);
  SELECT count(*) INTO n FROM public.wassell_my_view_scope_all_models();
  IF n <> 0 THEN RAISE EXCEPTION 'helper returned % models for a null auth.uid()', n; END IF;

  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000ff', true);
  SELECT count(*) INTO n FROM public.wassell_my_view_scope_all_models();
  IF n <> 0 THEN RAISE EXCEPTION 'helper returned % models for an identity with no user row', n; END IF;

  PERFORM set_config('test.uid', '55555555-5555-5555-5555-555555555555', true);
  SELECT count(*) INTO n FROM public.wassell_my_view_scope_all_models();
  IF n <> 0 THEN RAISE EXCEPTION 'helper returned % models for a DEACTIVATED user', n; END IF;

  PERFORM set_config('test.uid', '44444444-4444-4444-4444-444444444444', true);
  SELECT count(*) INTO n FROM public.wassell_my_view_scope_all_models();
  IF n <> 0 THEN RAISE EXCEPTION 'helper returned % models for a user with edit-but-not-view', n; END IF;

  PERFORM set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n FROM public.wassell_my_view_scope_all_models();
  IF n <> 4 THEN RAISE EXCEPTION 'persona 1111 should get exactly its 4 unrestricted models, got %', n; END IF;

  PERFORM set_config('test.uid', '', true);
  RAISE NOTICE 'smoke 4 OK: helper is caller-scoped, empty for null/ghost/deactivated/no-view';
END $$;

-- ── 5. anon cannot execute the helper ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
     AND has_function_privilege('anon', 'public.wassell_my_view_scope_all_models()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute wassell_my_view_scope_all_models';
  END IF;
  IF has_function_privilege('public', 'public.wassell_my_view_scope_all_models()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute wassell_my_view_scope_all_models';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.wassell_my_view_scope_all_models()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute wassell_my_view_scope_all_models';
  END IF;
  RAISE NOTICE 'smoke 5 OK: EXECUTE granted to authenticated only';
END $$;
