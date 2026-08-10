-- Verification for 2026-09-03_01_market_listings_view_fast_path.sql.
-- Run each block; output BOOLEANS / COUNTS / PLANS only — never row contents.
-- Replace <all_uid> with an active 'all' non-admin auth_uid and <none_uid> with a 'none' one.

-- 1. Policy shape: the fast path exists as a permissive SELECT policy; frozen_view remains.
SELECT polname, polcmd, polpermissive
FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass
  AND polname IN ('market_listings_view_fast','frozen_view') ORDER BY polname;

-- 2. Grants/invoker invariants unchanged by this migration.
SELECT has_table_privilege('anon','public.market_listings_summary','SELECT')          AS sum_anon_expect_false;
SELECT has_table_privilege('authenticated','public.market_listings_summary','SELECT') AS sum_auth_expect_true;
SELECT has_table_privilege('authenticated','public.v_market_properties','SELECT')     AS vmp_auth_expect_false;
SELECT has_table_privilege('authenticated','public.v_market_listings','SELECT')       AS vml_auth_expect_false;
SELECT (reloptions @> ARRAY['security_invoker=true']) AS summary_invoker_true
FROM pg_class WHERE relname='market_listings_summary' AND relnamespace='public'::regnamespace;

-- 3. Authorized unrestricted ('all'): fast path, NO per-row wassell_can_view_jsonb.
--   BEGIN;
--   SELECT set_config('request.jwt.claims', json_build_object('sub','<all_uid>','role','authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--   EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
--     SELECT id, data FROM public.market_listings_summary
--     WHERE id > '00000000-0000-0000-0000-000000000000'::uuid ORDER BY id LIMIT 1000;
--     -- expect: Index Scan market_listings_pkey; scope-class InitPlan rows=1;
--     --         per-row wassell_can_view_jsonb InitPlans "never executed"; stops at 1000 rows.
--   RESET ROLE; ROLLBACK;

-- 4. User without permission ('none'): zero rows, no timeout.
--   BEGIN;
--   SELECT set_config('request.jwt.claims', json_build_object('sub','<none_uid>','role','authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--   SELECT count(*) FROM public.market_listings_summary;   -- expect: 0
--   RESET ROLE; ROLLBACK;

-- 5. Synthetic restricted ('filtered', rolled back): per-row path engages, strict subset.
--   BEGIN;
--     -- temporarily set an 'all' profile's market_listings view_scope to
--     -- {mode:filtered, conditions:[source equals 'bayut']}, then:
--   SELECT set_config('request.jwt.claims', json_build_object('sub','<all_uid>','role','authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--   EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
--     SELECT id FROM public.market_listings
--     WHERE id > '00000000-0000-0000-0000-000000000000'::uuid ORDER BY id LIMIT 1000;
--     -- expect: per-row wassell_can_view_jsonb executed; "Rows Removed by Filter" > 0 (subset).
--   RESET ROLE; ROLLBACK;

-- 6. anon: no grant.
--   SET LOCAL ROLE anon;
--   SELECT count(*) FROM public.market_listings_summary;   -- expect: ERROR permission denied
--   RESET ROLE;

-- 7. service_role: bypass (infra).
--   SET LOCAL ROLE service_role;
--   SELECT count(*) FROM public.market_listings_summary;   -- expect: rows
--   RESET ROLE;
