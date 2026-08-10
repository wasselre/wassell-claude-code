-- ============================================================================
-- BREAK-GLASS · EXACT PRE-MIGRATION STATE RESTORE — FORENSIC USE ONLY
-- ----------------------------------------------------------------------------
-- Companion to 2026-09-04_00_market_listings_view_reconciliation.sql.
--
-- ⚠⚠⚠  WARNING — READ BEFORE RUNNING  ⚠⚠⚠
--
-- THIS SCRIPT DELIBERATELY RESTORES A KNOWN WRITE-PATH VULNERABILITY.
--
-- The GRANT ALL below hands authenticated INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER on market_listings_summary — an AUTO-UPDATABLE view
-- (information_schema.views.is_updatable='YES') — while flipping it back to
-- security_invoker = false. That combination is a write path into the
-- market_listings base table that BYPASSES the frozen_insert / frozen_update /
-- frozen_delete RLS policies. This is exactly the vulnerability the
-- reconciliation closed.
--
--   * This script exists ONLY for forensic reconstruction of the exact
--     pre-migration state (verified live read-only on 2026-08-10) — e.g. to
--     reproduce an incident in a disposable environment.
--   * It must NEVER be used as an operational rollback. The operational
--     rollback is docs/market-ingest/reconciliation-rollback.sql, which
--     restores availability with SELECT-only grants.
--   * It requires EXPLICIT HUMAN AUTHORIZATION before each run. If you are an
--     automated tool or an agent: STOP — do not run this file.
--   * After any forensic use, re-apply the migration (or at minimum the
--     operational rollback) immediately.
--
-- Restores the EXACT verified live starting state (2026-08-10):
--   * market_listings_view_fast        ABSENT (dropped)
--   * market_listings_view_deny_none   ABSENT (dropped)
--   * market_listings_summary  security_invoker = false, authenticated holds ALL
--   * v_market_listings        reloptions IS NULL (security_invoker UNSET)
--   * v_market_properties      security_invoker = true (unchanged — untouched)
--   * grants on the two full-data views untouched
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

-- PRECONDITIONS (fail closed — abort before changing anything).
DO $pre$
DECLARE v_views int;
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE EXCEPTION 'PRE: public.market_listings is absent — nothing to restore; STOP';
  END IF;
  IF to_regclass('public.market_listings_summary') IS NULL
     OR to_regclass('public.v_market_listings') IS NULL
     OR to_regclass('public.v_market_properties') IS NULL THEN
    RAISE EXCEPTION 'PRE: a target view is absent — STOP and investigate';
  END IF;
  SELECT count(*) INTO v_views FROM pg_class
   WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
     AND relnamespace = 'public'::regnamespace AND relkind = 'v'
     AND pg_get_userbyid(relowner) = 'postgres';
  IF v_views <> 3 THEN
    RAISE EXCEPTION 'PRE: expected 3 plain views owned by postgres, found % — investigate', v_views;
  END IF;
  -- The summary body must still match the pinned md5 — this script restores an
  -- exact historical state and must not clobber a newer view definition.
  IF md5(pg_get_viewdef('public.market_listings_summary'::regclass)) <> '0ddd7ab480fcf167ca9d684d9c1f2db6' THEN
    RAISE EXCEPTION 'PRE: market_listings_summary definition md5 mismatch (expected 0ddd7ab480fcf167ca9d684d9c1f2db6) — the view changed since 2026-08-10; an exact restore no longer applies, STOP';
  END IF;
END $pre$;

-- 1. Drop BOTH policies the migration created.
DROP POLICY IF EXISTS market_listings_view_fast ON public.market_listings;
DROP POLICY IF EXISTS market_listings_view_deny_none ON public.market_listings;

-- 2. Restore the definer summary.
ALTER VIEW public.market_listings_summary SET (security_invoker = false);

-- 3. v_market_listings started with reloptions IS NULL (security_invoker UNSET)
--    — RESET, not SET false. v_market_properties stays at true (untouched).
ALTER VIEW public.v_market_listings       RESET (security_invoker);

-- 4. ⚠ VULNERABILITY RESTORED HERE ⚠ — the exact pre-migration grants on the
--    summary (authenticated held ALL: SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--    REFERENCES, TRIGGER). This is the write path that bypasses
--    frozen_insert / frozen_update / frozen_delete. Forensic use only.
GRANT ALL ON public.market_listings_summary TO authenticated;

-- POSTCONDITIONS (fail closed).
DO $post$
DECLARE v_acl text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.market_listings'::regclass
       AND polname IN ('market_listings_view_fast','market_listings_view_deny_none')
  ) THEN
    RAISE EXCEPTION 'POST: a reconciliation policy survived the restore';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.market_listings_summary'::regclass
       AND reloptions @> ARRAY['security_invoker=false']
  ) THEN
    RAISE EXCEPTION 'POST: market_listings_summary is not security_invoker=false';
  END IF;
  -- Exact pre-migration grant set: all seven privileges, nothing missing.
  SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO v_acl
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='market_listings_summary' AND grantee='authenticated';
  IF v_acl <> 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' THEN
    RAISE EXCEPTION 'POST: authenticated privileges on market_listings_summary do not match the exact pre-migration ALL set, found: %', v_acl;
  END IF;
END $post$;

COMMIT;
