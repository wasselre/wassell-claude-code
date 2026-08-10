-- ============================================================================
-- ROLLBACK · 2026-09-04_00_market_listings_view_reconciliation.sql
-- ----------------------------------------------------------------------------
-- DEFAULT OPERATIONAL ROLLBACK. Restores AVAILABILITY of the summary view for
-- authenticated SPA reads WITHOUT reopening the write-path gap the
-- reconciliation closed:
--
--   * market_listings_summary is flipped back to security_invoker = false
--     (definer — fast reads, base-table RLS no longer applies under it), BUT
--   * authenticated keeps SELECT ONLY on it. The pre-migration
--     INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants are NOT
--     restored: the summary is auto-updatable
--     (information_schema.views.is_updatable='YES'), so under a definer view
--     those grants are a write path into the base table that bypasses the
--     frozen_insert/frozen_update/frozen_delete RLS policies.
--
-- End state after this rollback:
--   * market_listings_view_fast        ABSENT (dropped)
--   * market_listings_view_deny_none   ABSENT (dropped)
--   * frozen_view / frozen_insert / frozen_update / frozen_delete  untouched
--   * market_listings_summary  security_invoker = false, authenticated SELECT only
--   * v_market_listings        reloptions IS NULL (security_invoker UNSET)
--   * v_market_properties      security_invoker = true (deliberately untouched)
--   * grants on the two full-data views untouched (already correct:
--     service_role only, no PUBLIC/anon/authenticated)
--
-- If the EXACT pre-migration state (including the write grants) is needed for
-- forensic reconstruction, use
-- docs/market-ingest/reconciliation-breakglass-restore-exact.sql — NEVER as an
-- operational rollback.
--
-- Reviewed as a single transaction. Apply manually, not via tooling.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

-- PRECONDITIONS (fail closed — abort before changing anything).
DO $pre$
DECLARE v_views int;
BEGIN
  -- P.1 The base table must exist (the policy drops below target it).
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE EXCEPTION 'PRE: public.market_listings is absent — nothing to roll back; STOP';
  END IF;

  -- P.2 All three views must exist, be plain views, and be owned by postgres.
  IF to_regclass('public.market_listings_summary') IS NULL
     OR to_regclass('public.v_market_listings') IS NULL
     OR to_regclass('public.v_market_properties') IS NULL THEN
    RAISE EXCEPTION 'PRE: a target view is absent — STOP and investigate before rolling back';
  END IF;
  SELECT count(*) INTO v_views FROM pg_class
   WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
     AND relnamespace = 'public'::regnamespace AND relkind = 'v'
     AND pg_get_userbyid(relowner) = 'postgres';
  IF v_views <> 3 THEN
    RAISE EXCEPTION 'PRE: expected 3 plain views owned by postgres, found % — investigate', v_views;
  END IF;

  -- P.3 The summary view body must still match the pinned md5 — so a later
  --     schema change cannot be silently clobbered during an incident.
  IF md5(pg_get_viewdef('public.market_listings_summary'::regclass)) <> '0ddd7ab480fcf167ca9d684d9c1f2db6' THEN
    RAISE EXCEPTION 'PRE: market_listings_summary definition md5 mismatch (expected 0ddd7ab480fcf167ca9d684d9c1f2db6) — the view changed since the reconciliation; STOP and re-derive this rollback by hand rather than clobbering the newer definition';
  END IF;
END $pre$;

-- 1. Drop BOTH policies the migration created. Dropping deny_none restores the
--    starting state where NO restrictive policy existed on the table.
DROP POLICY IF EXISTS market_listings_view_fast ON public.market_listings;
DROP POLICY IF EXISTS market_listings_view_deny_none ON public.market_listings;

-- 2. Restore fast definer reads on the summary.
ALTER VIEW public.market_listings_summary SET (security_invoker = false);

-- 3. v_market_listings started with reloptions IS NULL (security_invoker UNSET,
--    i.e. definer by default) — so it must be RESET, NOT SET (security_invoker =
--    false): SET would leave reloptions = {security_invoker=false} instead of
--    restoring the NULL starting state.
ALTER VIEW public.v_market_listings       RESET (security_invoker);

-- v_market_properties was ALREADY security_invoker=true before the migration
-- (verified 2026-08-10): it is deliberately left at true — do NOT touch it.

-- 4. SELECT-only grants on the summary — NOT GRANT ALL. See the header: the
--    write grants are the vulnerability and are not restored operationally.
REVOKE ALL ON public.market_listings_summary FROM authenticated;
GRANT SELECT ON public.market_listings_summary TO authenticated;

-- POSTCONDITIONS (fail closed — the transaction rolls back on any violation).
DO $post$
DECLARE v_acl text;
BEGIN
  -- POST.1 Both reconciliation policies are gone.
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.market_listings'::regclass
       AND polname IN ('market_listings_view_fast','market_listings_view_deny_none')
  ) THEN
    RAISE EXCEPTION 'POST: a reconciliation policy (market_listings_view_fast / market_listings_view_deny_none) survived the rollback';
  END IF;

  -- POST.2 The four frozen_* policies remain.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_view')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_insert')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_update')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_delete') THEN
    RAISE EXCEPTION 'POST: a frozen_* policy disappeared during the rollback — they must remain untouched';
  END IF;

  -- POST.3 Summary is security_invoker = false.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.market_listings_summary'::regclass
       AND reloptions @> ARRAY['security_invoker=false']
  ) THEN
    RAISE EXCEPTION 'POST: market_listings_summary is not security_invoker=false after the rollback';
  END IF;

  -- POST.4 authenticated privileges on the summary are EXACTLY SELECT (covers
  --      all privilege types, incl. REFERENCES and TRIGGER).
  SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO v_acl
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='market_listings_summary' AND grantee='authenticated';
  IF v_acl <> 'SELECT' THEN
    RAISE EXCEPTION 'POST: authenticated privileges on market_listings_summary must be exactly SELECT after the rollback, found: %', v_acl;
  END IF;

  -- POST.5 anon still has no privileges on any of the three views.
  SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO v_acl
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee='anon'
     AND table_name IN ('market_listings_summary','v_market_listings','v_market_properties');
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: anon privileges on the target views must be exactly (none) after the rollback, found: %', v_acl;
  END IF;
END $post$;

COMMIT;
