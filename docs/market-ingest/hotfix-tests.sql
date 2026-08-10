-- Verification for the market_listings view-exposure hotfix
-- (2026-09-03_00_hotfix_market_listings_view_exposure.sql).
-- Run each block; NEVER print row CONTENTS — use count()/expect-error/booleans only.

-- ── 1. Grants after the hotfix (regression guard) ───────────────────────────
SELECT has_table_privilege('anon',         'public.v_market_properties',    'SELECT') AS vmp_anon_expect_false;
SELECT has_table_privilege('authenticated','public.v_market_properties',    'SELECT') AS vmp_auth_expect_false;
SELECT has_table_privilege('anon',         'public.v_market_listings',      'SELECT') AS vml_anon_expect_false;
SELECT has_table_privilege('authenticated','public.v_market_listings',      'SELECT') AS vml_auth_expect_false;
SELECT has_table_privilege('anon',         'public.market_listings_summary','SELECT') AS sum_anon_expect_false;
SELECT has_table_privilege('authenticated','public.market_listings_summary','SELECT') AS sum_auth_expect_true;

-- ── 2. security_invoker=true on all three (RLS is respected) ─────────────────
SELECT relname,
       (reloptions @> ARRAY['security_invoker=true']) AS invoker_true_expected
FROM pg_class WHERE relname IN ('v_market_properties','v_market_listings','market_listings_summary') AND relkind='v';

-- ── 3. anon: NO access to any of the three ──────────────────────────────────
SET LOCAL ROLE anon;
--   SELECT count(*) FROM public.v_market_properties;      -- expect: ERROR permission denied
--   SELECT count(*) FROM public.v_market_listings;        -- expect: ERROR permission denied
--   SELECT count(*) FROM public.market_listings_summary;  -- expect: ERROR permission denied
RESET ROLE;

-- ── 4. Direct PUBLIC REST endpoint as anon (out-of-band; run with the ANON key) ─
--   curl -s "$SUPABASE_URL/rest/v1/market_listings_summary?select=external_id&limit=1" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"   -- expect: 401 / permission denied
--   curl -s "$SUPABASE_URL/rest/v1/v_market_properties?select=dupe_group_id&limit=1" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"   -- expect: 401 / permission denied
--   curl -s "$SUPABASE_URL/rest/v1/v_market_listings?select=external_id&limit=1" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"   -- expect: 401 / permission denied

-- ── 5. Ordinary authenticated salesperson: summary is RLS-SCOPED; no full-data views ─
--   Simulate a non-admin uid via request.jwt.claims, role=authenticated:
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claims', json_build_object('sub','<non_admin_uid>','role','authenticated')::text, true);
--   a) market_listings_summary respects RLS: the row count MUST equal the number of
--      listings this user may view per frozen_view (wassell_can_view). For an
--      unrestricted profile that is all active rows; for a scoped profile it is fewer.
--        SELECT count(*) FROM public.market_listings_summary;              -- expect: == frozen_view-visible count (NOT all rows if scoped)
--   b) advertiser_phone only for accessible rows (no phone leaks for non-viewable rows):
--        SELECT count(*) FILTER (WHERE advertiser_phone IS NOT NULL) FROM public.market_listings_summary; -- expect: only within visible set
--   c) NO full data / source_payload path for ordinary authenticated:
--        SELECT count(*) FROM public.v_market_properties;                 -- expect: ERROR permission denied
--        SELECT count(*) FROM public.v_market_listings;                   -- expect: ERROR permission denied
--        -- market_listings_summary does NOT select source_payload (verified: source_payload absent from its def)
--   RESET ROLE;

-- ── 6. Authorized admin (authenticated + profiles.is_admin=true) ─────────────
--   Same as (5); admins gain no special access to v_market_properties/v_market_listings
--   here. Raw evidence/audit stay admin-only on the Gate A tables (03/04/05).

-- ── 7. service_role (infra) ─────────────────────────────────────────────────
SET LOCAL ROLE service_role;
--   SELECT count(*) FROM public.v_market_properties;      -- expect: rows (BYPASSRLS)
--   SELECT count(*) FROM public.v_market_listings;        -- expect: rows
--   SELECT count(*) FROM public.market_listings_summary;  -- expect: rows
RESET ROLE;

-- ── 8. Historical access (evidence, counts only — no contents) ──────────────
--   SELECT CASE WHEN query ILIKE '%v_market_properties%' THEN 'v_market_properties'
--               WHEN query ILIKE '%v_market_listings%'   THEN 'v_market_listings'
--               ELSE 'market_listings_summary' END AS view, sum(calls) AS calls
--   FROM extensions.pg_stat_statements
--   WHERE query ILIKE ANY (ARRAY['%v_market_properties%','%v_market_listings%','%market_listings_summary%'])
--   GROUP BY 1;   -- Baselined 2026-09-03: v_market_properties ~3, v_market_listings ~2, summary heavy (SPA).

-- ── 9. MANDATORY follow-up (blocks future model regeneration) ────────────────
--   regenerate_model_view() re-grants anon/authenticated + security_invoker=false on
--   EVERY frozen model's v_<name>. It MUST be patched (invoker=true and/or no anon
--   grant for frozen models) BEFORE any market_listings (or other sensitive-model)
--   schema change, or v_market_listings re-exposes. Tracked as a required task.
