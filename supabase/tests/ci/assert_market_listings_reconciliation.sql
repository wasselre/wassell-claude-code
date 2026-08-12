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
  v_colacl      text;
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

  -- 5. Exact ACLs over pg_class.relacl + aclexplode (grantee resolved via
  --    pg_get_userbyid, grantee oid 0 = PUBLIC), NOT
  --    information_schema.role_table_grants: role_table_grants does NOT
  --    surface MAINTAIN (PostgreSQL 17 added it and folded it into GRANT ALL),
  --    so an exact-set assertion written against role_table_grants cannot see
  --    one privilege class and would give false assurance. GRANTABILITY-AWARE:
  --    each privilege is rendered as privilege_type || '*' when held WITH
  --    GRANT OPTION — REVOKE only removes grants issued by the revoking
  --    grantor, so a delegation granted by a different grantor survives; a
  --    privilege-name-only aggregate would see just 'SELECT' and PASS while
  --    authenticated retains the power to RE-GRANT access. The rendered form
  --    ('SELECT,SELECT*' or 'SELECT*') fails the exact-set match instead.
  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.market_listings_summary'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> 'SELECT' THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: authenticated on market_listings_summary must be exactly SELECT, found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.v_market_listings'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: authenticated on v_market_listings must be (none), found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.v_market_properties'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: authenticated on v_market_properties must be (none), found: %', v_acl;
  END IF;

  FOR v_acl IN
    SELECT coalesce((
             SELECT string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END)
               FROM pg_class c
                    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
              WHERE c.oid = format('public.%I', t.name)::regclass
                AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'anon'
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

  -- 5b. No COLUMN-LEVEL grants on any of the three views. Column privileges
  --     live in pg_attribute.attacl and are invisible to the pg_class.relacl
  --     exact-set assertions above — a GRANT SELECT (col) would pass every
  --     check in assert 5 while remaining in force. The migration's
  --     table-level REVOKE ALL removes same-grantor column grants
  --     automatically, so a survivor can only come from a foreign grantor; the
  --     correct end state is the empty set. A surviving
  --     SELECT (source_payload) on v_market_listings would defeat the
  --     2026-09-03_00 guarantee that source_payload is not exposed.
  SELECT coalesce(string_agg(
           c.relname||'.'||att.attname||' -> '||
           (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)||':'||
           a.privilege_type||CASE WHEN a.is_grantable THEN '*' ELSE '' END||
           ' (granted by '||pg_get_userbyid(a.grantor)||')',
           ', ' ORDER BY c.relname, att.attname), '(none)')
    INTO v_colacl
    FROM pg_class c
         JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0
         CROSS JOIN LATERAL aclexplode(att.attacl) a
   WHERE c.relname IN ('market_listings_summary','v_market_listings','v_market_properties')
     AND c.relnamespace = 'public'::regnamespace;
  IF v_colacl <> '(none)' THEN
    RAISE EXCEPTION 'ASSERT 5b FAILED: column-level grants exist on the target views (pg_attribute.attacl — invisible to the relacl assertions): %', v_colacl;
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
