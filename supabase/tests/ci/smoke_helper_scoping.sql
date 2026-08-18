-- ============================================================================
-- DIRECT-FUNCTION / RPC abuse tests for the authorization helpers.
--
-- Every previous Files suite asserted POLICY fingerprints. That is necessary
-- and it was not sufficient: B2A.2's policy was correct while the SECURITY
-- DEFINER helpers it called were, on their own, a bypass — they took a target
-- user as a parameter and were granted to `authenticated`, and being
-- set-returning they were published by PostgREST at /rest/v1/rpc/<name>.
--
-- Measured on production before the fix: a non-admin with zero grants read
-- another user's 15 view and 14 delete grants; identity-less and deactivated
-- callers, who see ZERO files through the policy, each read all 1,270 marketing
-- file ids.
--
-- So these assertions call the functions DIRECTLY, as `authenticated`, the way
-- a client with a JWT can. A suite that only diffs policy output cannot see
-- this class of bug.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. The forgeable helpers must be GONE, not merely revoked ───────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('wassell_granted_file_ids','wassell_cascade_folder_ids',
                       'wassell_marketing_file_ids');
  IF n <> 0 THEN
    RAISE EXCEPTION 'H.1 % forgeable helper(s) still installed — revoking is not enough, they must be dropped', n;
  END IF;

  -- and the caller-scoped replacements must exist, taking NO target user
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('wassell_my_granted_file_ids','wassell_my_cascade_folder_ids',
                       'wassell_my_marketing_file_ids');
  IF n <> 3 THEN RAISE EXCEPTION 'H.1 expected 3 caller-scoped helpers, found %', n; END IF;

  -- none of them may accept a uuid argument (that is what "forgeable" means)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname LIKE 'wassell_my_%'
     AND 'uuid'::regtype::oid = ANY(p.proargtypes);
  IF n <> 0 THEN
    RAISE EXCEPTION 'H.1 a caller-scoped helper still accepts a uuid — it can be pointed at another user';
  END IF;
  RAISE NOTICE 'H.1 forgeable helpers dropped, caller-scoped replacements take no target user';
END $$;

-- ── 2. anon may not execute any of them ─────────────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_routine_grants
   WHERE routine_schema='public' AND grantee='anon'
     AND routine_name LIKE 'wassell_my_%';
  IF n <> 0 THEN RAISE EXCEPTION 'H.2 anon can execute % caller-scoped helper(s)', n; END IF;

  -- the non-live helpers must not be reachable by the app roles either
  SELECT count(*) INTO n FROM information_schema.role_routine_grants
   WHERE routine_schema='public' AND grantee IN ('anon','authenticated')
     AND routine_name IN ('wassell_can_access_file_row','wassell_user_has_file_grants',
                          'wassell_user_has_folder_grants');
  IF n <> 0 THEN
    RAISE EXCEPTION 'H.2 % grant(s) remain on helpers no live policy uses', n;
  END IF;
  RAISE NOTICE 'H.2 grants correct';
END $$;

-- ── 3. THE ABUSE TEST. Call the helpers directly as each caller class. ──────
-- A caller may only ever receive their OWN sets, and identity-less /
-- deactivated / non-MOS callers must receive nothing at all.
DO $$
DECLARE
  n_grant bigint; n_folder bigint; n_mkt bigint;
  own_grants bigint; u uuid; label text;
  cases text[][] := ARRAY[
    ARRAY['33333333-3333-3333-3333-333333333333','grant-holder'],
    ARRAY['55555555-5555-5555-5555-555555555555','no-access'],
    ARRAY['44444444-4444-4444-4444-444444444444','marketing'],
    ARRAY['00000000-0000-0000-0000-0000000000ff','identity-less'],
    ARRAY['00000000-0000-0000-0000-0000000000fe','identity-less-2']
  ];
  c text[];
BEGIN
  FOREACH c SLICE 1 IN ARRAY cases LOOP
    u := c[1]::uuid; label := c[2];
    PERFORM set_config('test.uid', u::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    SELECT count(*) INTO n_grant  FROM public.wassell_my_granted_file_ids('view');
    SELECT count(*) INTO n_folder FROM public.wassell_my_cascade_folder_ids('view');
    SELECT count(*) INTO n_mkt    FROM public.wassell_my_marketing_file_ids();

    EXECUTE 'RESET ROLE';

    -- what this caller ACTUALLY holds, computed independently
    SELECT count(*) INTO own_grants FROM public.file_permissions fp
     WHERE fp.user_id = public.wassell_app_user_id(u)
       AND public.wassell_role_satisfies(fp.role,'view');

    IF n_grant <> own_grants THEN
      RAISE EXCEPTION 'H.3 % received % grant ids but holds % — helper is not caller-scoped',
        label, n_grant, own_grants;
    END IF;

    -- identity-less callers must get NOTHING from any helper
    IF public.wassell_app_user_id(u) IS NULL THEN
      IF n_grant <> 0 OR n_folder <> 0 OR n_mkt <> 0 THEN
        RAISE EXCEPTION 'H.3 identity-less % got grants=% folders=% marketing=% (expected 0/0/0)',
          label, n_grant, n_folder, n_mkt;
      END IF;
    END IF;

    -- the marketing helper must enforce MOS read on its own
    IF NOT public.wassell_mos_can('read', u) AND n_mkt <> 0 THEN
      RAISE EXCEPTION 'H.3 % lacks MOS read yet the marketing helper returned % ids', label, n_mkt;
    END IF;

    RAISE NOTICE 'H.3 % -> grants=% folders=% marketing=% OK', label, n_grant, n_folder, n_mkt;
  END LOOP;
END $$;

-- ── 4. NON-VACUITY: the grant-holder must actually hold something, or §3
--      proves nothing about scoping. ─────────────────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('test.uid','33333333-3333-3333-3333-333333333333', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.wassell_my_granted_file_ids('view');
  EXECUTE 'RESET ROLE';
  IF n = 0 THEN
    RAISE EXCEPTION 'H.4 vacuous: the grant-holder persona holds no grants, so scoping is untested';
  END IF;
  RAISE NOTICE 'H.4 grant-holder holds % grants — scoping test is non-vacuous', n;
END $$;

SELECT 'helper scoping smoke: all assertions passed' AS result;
