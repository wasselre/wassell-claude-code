-- ============================================================================
-- ROLLBACK · 2026-09-04_00_market_listings_view_reconciliation.sql
-- ----------------------------------------------------------------------------
-- Restores the EXACT verified live starting state (read-only audit 2026-08-10):
--   * market_listings_view_fast policy ABSENT
--   * market_listings_summary  security_invoker = false, authenticated holds ALL
--   * v_market_listings        reloptions IS NULL (security_invoker UNSET)
--   * v_market_properties      security_invoker = true (unchanged — see below)
--   * grants on the two full-data views untouched (they were already correct:
--     service_role ALL only, no PUBLIC/anon/authenticated)
--
-- WARNING — this REOPENS the write-path gap the reconciliation closed.
-- market_listings_summary is an auto-updatable view
-- (information_schema.views.is_updatable='YES'); while it is
-- security_invoker=false, the restored INSERT/UPDATE/DELETE/TRUNCATE grants to
-- authenticated are a write path into the base table that bypasses the
-- frozen_insert/frozen_update/frozen_delete RLS policies. Run this only to back
-- out the reconciliation while investigating, then re-apply the migration as
-- soon as the underlying problem is understood.
--
-- Reviewed as a single transaction. Apply manually, not via tooling.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

DROP POLICY IF EXISTS market_listings_view_fast ON public.market_listings;

-- The migration also added the market_listings_view_deny_none RESTRICTIVE
-- policy; dropping it restores the starting state where NO restrictive policy
-- existed on the table (the verified 2026-08-10 starting state above).
DROP POLICY IF EXISTS market_listings_view_deny_none ON public.market_listings;

ALTER VIEW public.market_listings_summary SET (security_invoker = false);

-- v_market_listings started with reloptions IS NULL (security_invoker UNSET,
-- i.e. definer by default) — so it must be RESET, NOT SET (security_invoker =
-- false): SET would leave reloptions = {security_invoker=false} instead of
-- restoring the NULL starting state.
ALTER VIEW public.v_market_listings       RESET (security_invoker);

-- v_market_properties was ALREADY security_invoker=true before the migration
-- (verified 2026-08-10): it is deliberately left at true — do NOT touch it.

-- Restores the pre-change grants on the summary (authenticated held ALL:
-- SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER).
GRANT ALL ON public.market_listings_summary TO authenticated;

COMMIT;
