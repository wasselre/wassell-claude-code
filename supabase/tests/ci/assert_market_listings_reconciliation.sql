-- ============================================================================
-- CI assertions: market_listings view reconciliation.
-- Run by psql -v ON_ERROR_STOP=1 AFTER
--   supabase/tests/ci/fixture_market_listings.sql and a SUCCESSFUL apply of
--   supabase/migrations/2026-09-04_00_market_listings_view_reconciliation.sql.
-- Every check RAISEs EXCEPTION on failure (fails the psql run) and emits NO
-- row values — only booleans and counts.
-- ============================================================================

-- Helper: count market_listings_summary rows AS a given role with a given JWT
-- subject. SET LOCAL inside a function is restored at function exit, so each
-- call is self-contained (one logical sub-transaction per subject).
CREATE OR REPLACE FUNCTION public._ci_count_summary_as(p_role text, p_uid uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '{}'
         ELSE json_build_object('sub', p_uid::text)::text END,
    true
  );
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE 'SELECT count(*) FROM public.market_listings_summary' INTO v_count;
  RETURN v_count;
END;
$fn$;

DO $assert$
DECLARE
  v_total       bigint;
  v_bayut       bigint;
  v_count       bigint;
  v_acl         text;
  v_anon_denied boolean;
BEGIN
  -- Seeded-row expectations, computed from the fixture (never hardcoded).
  SELECT count(*), count(*) FILTER (WHERE source = 'bayut')
    INTO v_total, v_bayut
    FROM public.market_listings;

  -- 1. market_listings_view_fast: permissive SELECT to exactly {authenticated}.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.market_listings'::regclass
       AND p.polname = 'market_listings_view_fast'
       AND p.polcmd = 'r'
       AND p.polpermissive
       AND p.polroles::regrole[] = ARRAY['authenticated'::regrole]
  ) THEN
    RAISE EXCEPTION 'ASSERT 1 FAILED: market_listings_view_fast missing or not a permissive SELECT to exactly {authenticated}';
  END IF;

  -- 2. market_listings_view_deny_none: RESTRICTIVE SELECT to exactly
  --    {authenticated}. polpermissive = false is the whole point — a permissive
  --    policy with this name would BROADEN access, not narrow it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.market_listings'::regclass
       AND p.polname = 'market_listings_view_deny_none'
       AND p.polcmd = 'r'
       AND NOT p.polpermissive
       AND p.polroles::regrole[] = ARRAY['authenticated'::regrole]
  ) THEN
    RAISE EXCEPTION 'ASSERT 2 FAILED: market_listings_view_deny_none missing or not a RESTRICTIVE SELECT to exactly {authenticated}';
  END IF;

  -- 3. All four frozen_* policies still present.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_view')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_insert')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_update')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_delete') THEN
    RAISE EXCEPTION 'ASSERT 3 FAILED: a frozen_view/frozen_insert/frozen_update/frozen_delete policy is missing';
  END IF;

  -- 4. All three views are security_invoker=true.
  IF (SELECT count(*) FROM pg_class
       WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
         AND relnamespace = 'public'::regnamespace
         AND relkind = 'v'
         AND reloptions @> ARRAY['security_invoker=true']) <> 3 THEN
    RAISE EXCEPTION 'ASSERT 4 FAILED: not all three views have reloptions security_invoker=true';
  END IF;

  -- 5. Exact ACLs via information_schema.role_table_grants.
  SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO v_acl
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'market_listings_summary' AND grantee = 'authenticated';
  IF v_acl <> 'SELECT' THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: authenticated on market_listings_summary must be exactly SELECT, found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO v_acl
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'v_market_listings' AND grantee = 'authenticated';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: authenticated on v_market_listings must be (none), found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO v_acl
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'v_market_properties' AND grantee = 'authenticated';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: authenticated on v_market_properties must be (none), found: %', v_acl;
  END IF;

  FOR v_acl IN
    SELECT coalesce((
             SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type)
               FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND grantee = 'anon' AND table_name = t.name
           ), '(none)')
      FROM (VALUES ('market_listings_summary'), ('v_market_listings'), ('v_market_properties')) AS t(name)
  LOOP
    IF v_acl <> '(none)' THEN
      RAISE EXCEPTION 'ASSERT 5 FAILED: anon must have (none) on all three views, found: %', v_acl;
    END IF;
  END LOOP;

  IF NOT (has_table_privilege('service_role', 'public.market_listings_summary', 'SELECT')
      AND has_table_privilege('service_role', 'public.v_market_listings', 'SELECT')
      AND has_table_privilege('service_role', 'public.v_market_properties', 'SELECT')) THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: service_role lost SELECT on a target view';
  END IF;

  -- 6. authenticated and service_role keep SELECT on the base table — with the
  --    views at security_invoker=true this grant is load-bearing for reads.
  IF NOT (has_table_privilege('authenticated', 'public.market_listings', 'SELECT')
      AND has_table_privilege('service_role', 'public.market_listings', 'SELECT')) THEN
    RAISE EXCEPTION 'ASSERT 6 FAILED: authenticated/service_role lost SELECT on public.market_listings';
  END IF;

  -- 7. Role matrix over the summary view (one sub-transaction per subject).
  BEGIN
    v_count := public._ci_count_summary_as('authenticated', '11111111-1111-1111-1111-111111111111'::uuid);
  END;
  IF v_count <> v_total THEN
    RAISE EXCEPTION 'ASSERT 7 FAILED: scope class ''all'' saw % rows, expected % (total seeded)', v_count, v_total;
  END IF;

  BEGIN
    v_count := public._ci_count_summary_as('authenticated', '22222222-2222-2222-2222-222222222222'::uuid);
  END;
  IF v_count <> v_bayut OR NOT (v_count > 0 AND v_count < v_total) THEN
    RAISE EXCEPTION 'ASSERT 7 FAILED: scope class ''filtered'' saw % rows, expected % (bayut rows) and a strict subset of %', v_count, v_bayut, v_total;
  END IF;

  BEGIN
    v_count := public._ci_count_summary_as('authenticated', '33333333-3333-3333-3333-333333333333'::uuid);
  END;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSERT 7 FAILED: scope class ''none'' saw % rows, expected 0', v_count;
  END IF;

  -- 8. service_role sees all rows (BYPASSRLS — mirrors production).
  BEGIN
    v_count := public._ci_count_summary_as('service_role', NULL);
  END;
  IF v_count <> v_total THEN
    RAISE EXCEPTION 'ASSERT 8 FAILED: service_role saw % rows, expected % (total seeded)', v_count, v_total;
  END IF;

  -- 9. anon is denied outright (insufficient_privilege — no grant at all).
  v_anon_denied := false;
  BEGIN
    PERFORM public._ci_count_summary_as('anon', NULL);
  EXCEPTION WHEN insufficient_privilege THEN
    v_anon_denied := true;
  END;
  IF NOT v_anon_denied THEN
    RAISE EXCEPTION 'ASSERT 9 FAILED: anon SELECT on market_listings_summary did NOT raise insufficient_privilege';
  END IF;

  RAISE NOTICE 'market_listings reconciliation assertions: ALL PASSED';
END
$assert$;

DROP FUNCTION public._ci_count_summary_as(text, uuid);
