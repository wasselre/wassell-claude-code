-- ============================================================================
-- EMERGENCY SECURITY HOTFIX · market_listings view exposure
-- ----------------------------------------------------------------------------
-- INCIDENT (read-only audit, 2026-09-03): three public views expose market_listings
-- scraped data to anon + ordinary authenticated users, bypassing frozen_view RLS
-- (all security_invoker=false and granted to anon/authenticated):
--   * v_market_properties      — selects the FULL ml.data (contact + source_payload). NO app/API/website consumer.
--   * v_market_listings        — auto typed BI view; exposes ALL columns incl. source_payload + advertiser_phone. NO consumer.
--   * market_listings_summary  — exposes advertiser_phone + deed/permit (NOT source_payload). CONSUMER: authenticated SPA (proven).
-- Website views v_our_projects_scope / v_website_public filter to the projects model
-- and do NOT return market_listings rows — untouched.
--
-- EXPOSURE WINDOWS: summary since 2026-06-27; v_market_listings since ~2026-08-06
--   (model auto-view at freeze); v_market_properties since 2026-08-05.
-- HISTORICAL ACCESS (pg_stat_statements, COUNTS only): v_market_properties ~3 / 0 rows,
--   v_market_listings ~2 / 0 rows (essentially unused); summary heavy (authenticated SPA).
--   Stats are resettable → available evidence only, NOT proof that no access occurred.
-- SCOPE: 0 of 7 profiles carry a per-model permission for market_listings, so all three
--   must RESPECT RLS (security_invoker=true), not merely be anon-revoked, so any future
--   office scope is honoured and the model-visibility gate is not bypassed.
--
-- FIX: v_market_properties / v_market_listings → invoker=true + revoke anon+authenticated+PUBLIC (no consumer);
--      market_listings_summary → invoker=true (respects frozen_view RLS) + revoke anon; KEEP authenticated.
-- MANDATORY FOLLOW-UP: regenerate_model_view() re-exposes v_<model> views with unsafe
--   defaults; it MUST be patched before any future model regeneration (see §8 audit).
-- Standalone; safe to apply independently of Gate A 01–05.
-- ============================================================================

BEGIN;

-- 1. Transaction safety: abort rather than block; no partial changes.
SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '30s';

-- 2. Preflight (fail closed) — all three must exist, be views, and match the audited surfaces.
DO $preflight$
DECLARE v_views int;
BEGIN
  IF to_regclass('public.v_market_properties') IS NULL
     OR to_regclass('public.v_market_listings') IS NULL
     OR to_regclass('public.market_listings_summary') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: a target view is absent — STOP and investigate (do not skip v_market_listings)';
  END IF;
  SELECT count(*) INTO v_views FROM pg_class
    WHERE relname IN ('v_market_properties','v_market_listings','market_listings_summary')
      AND relnamespace = 'public'::regnamespace AND relkind = 'v';
  IF v_views <> 3 THEN RAISE EXCEPTION 'PREFLIGHT: a target is not a plain view (found % views)', v_views; END IF;
  -- summary must NOT expose source_payload (post-freeze it reads typed columns and
  -- has no `data` JSONB column, so "the full data object" cannot be selected; the
  -- source_payload check is the meaningful guarantee).
  IF pg_get_viewdef('public.market_listings_summary'::regclass) ~* 'source_payload' THEN
    RAISE EXCEPTION 'PREFLIGHT: market_listings_summary definition unexpectedly exposes source_payload — investigate before hotfix';
  END IF;
  -- the two full-data views must reference the listing surface (confirm we target the right objects)
  IF pg_get_viewdef('public.v_market_properties'::regclass) !~* '(ml\.data|unified_records|market_listings)' THEN
    RAISE EXCEPTION 'PREFLIGHT: v_market_properties definition unexpected — investigate';
  END IF;
  IF pg_get_viewdef('public.v_market_listings'::regclass) !~* '(source_payload|market_listings)' THEN
    RAISE EXCEPTION 'PREFLIGHT: v_market_listings definition unexpected — investigate';
  END IF;
END $preflight$;

-- 3. Mutations.
ALTER VIEW public.v_market_properties     SET (security_invoker = true);
REVOKE ALL ON public.v_market_properties  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_market_properties TO service_role;

ALTER VIEW public.v_market_listings       SET (security_invoker = true);
REVOKE ALL ON public.v_market_listings    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_market_listings  TO service_role;

ALTER VIEW public.market_listings_summary SET (security_invoker = true);
REVOKE ALL ON public.market_listings_summary FROM PUBLIC, anon;
GRANT SELECT ON public.market_listings_summary TO authenticated, service_role;

-- 4. Postconditions (fail closed → whole transaction rolls back on any violation).
DO $post$
DECLARE v_inv int; v_public int;
BEGIN
  SELECT count(*) INTO v_inv FROM pg_class
    WHERE relname IN ('v_market_properties','v_market_listings','market_listings_summary')
      AND relnamespace='public'::regnamespace AND reloptions @> ARRAY['security_invoker=true'];
  IF v_inv <> 3 THEN RAISE EXCEPTION 'POST: security_invoker!=true on % of 3 views', 3-v_inv; END IF;

  IF has_table_privilege('anon','public.v_market_properties','SELECT')
     OR has_table_privilege('anon','public.v_market_listings','SELECT')
     OR has_table_privilege('anon','public.market_listings_summary','SELECT') THEN
    RAISE EXCEPTION 'POST: anon can still SELECT a target view'; END IF;

  IF has_table_privilege('authenticated','public.v_market_properties','SELECT')
     OR has_table_privilege('authenticated','public.v_market_listings','SELECT') THEN
    RAISE EXCEPTION 'POST: authenticated can still SELECT a full-data view'; END IF;

  IF NOT has_table_privilege('authenticated','public.market_listings_summary','SELECT') THEN
    RAISE EXCEPTION 'POST: authenticated lost access to market_listings_summary (SPA would break)'; END IF;

  IF NOT (has_table_privilege('service_role','public.v_market_properties','SELECT')
      AND has_table_privilege('service_role','public.v_market_listings','SELECT')
      AND has_table_privilege('service_role','public.market_listings_summary','SELECT')) THEN
    RAISE EXCEPTION 'POST: service_role lost operational access'; END IF;

  -- no PUBLIC grant remains (grantee 0 = PUBLIC)
  SELECT count(*) INTO v_public FROM (
    SELECT (aclexplode(relacl)).grantee AS g FROM pg_class
     WHERE relname IN ('v_market_properties','v_market_listings','market_listings_summary')
       AND relnamespace='public'::regnamespace
  ) a WHERE a.g = 0;
  IF v_public <> 0 THEN RAISE EXCEPTION 'POST: a PUBLIC grant remains on a target view'; END IF;

  IF pg_get_viewdef('public.market_listings_summary'::regclass) ~* 'source_payload' THEN
    RAISE EXCEPTION 'POST: market_listings_summary now exposes source_payload'; END IF;
END $post$;

COMMIT;

-- Verification (manual, per role; not executed here): docs/market-ingest/hotfix-tests.sql.
