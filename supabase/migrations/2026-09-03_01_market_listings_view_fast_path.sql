-- ============================================================================
-- PERFORMANCE FIX · market_listings unrestricted view fast path
-- ----------------------------------------------------------------------------
-- CONTEXT: 2026-09-03_00 hotfix set market_listings_summary (+ two full-data
-- views) to security_invoker=true to close an anon/authenticated exposure.
-- Correct for security, but it re-activated the base-table frozen_view RLS
-- policy UNDER the summary: frozen_view rebuilds a 90-column jsonb and calls
-- wassell_can_view_jsonb() PER ROW across 314,070 rows, with no scope-class
-- fast path. Every authenticated market_listings read (summary page, finder,
-- record views) now pays that per-row cost and trips the statement timeout.
--
-- The summary VIEW already carries the scope-class fast path in its own WHERE
-- (2026-07-17_market_listings_summary_fast_path.sql). This migration gives the
-- BASE TABLE the same fast path as a SEPARATE permissive SELECT policy:
--   * scope_class='all'      -> constant-true InitPlan (once per statement),
--                               frozen_view's per-row call short-circuits.
--   * scope_class='filtered' -> fast branch false, frozen_view runs per row
--                               (EXACT scoped semantics preserved) -> subset.
--   * scope_class='none'     -> both false -> zero rows.
-- The unrestricted decision is ONE uncorrelated InitPlan, NOT per-row.
--
-- This does NOT weaken RLS and adds NO SECURITY DEFINER bypass: it ADDS a
-- permissive branch true only for profiles wassell_view_scope_class already
-- classifies as fully-authorized ('all'); the existing frozen_view policy is
-- untouched and remains the scoped path. The summary stays security_invoker=
-- true; anon keeps no grant; the two full-data views stay revoked from
-- anon+authenticated (2026-09-03_00 unchanged).
--
-- Durable across schema regeneration: regenerate_frozen_model_artifacts() drops
-- ONLY the four frozen_* policies by name, so this separately-named policy
-- survives. The freeze baseline migration (02) ALSO creates it (fresh-DB parity).
--
-- Verified in an isolated rolled-back tx on prod data (2026-08-09):
--   before: frozen_view full-90col wassell_can_view_jsonb per 314,070 rows -> timeout.
--   after 'all' keyset LIMIT 1000 page: Index Scan market_listings_pkey, scope-class
--     InitPlan rows=1, per-row wassell_can_view_jsonb NEVER executed, 39 ms.
--   after 'filtered' (temp source='bayut' restriction): per-row engages,
--     Rows Removed by Filter=1636 -> bayut subset, 543 ms. Auto-fallback confirmed.
--   'none' -> 0 rows; anon -> no grant; service_role -> bypass.
-- Standalone; safe to apply after 2026-09-03_00. Guarded to no-op on a fresh
-- replay that reaches it BEFORE the freeze baseline (02 owns creation there).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '30s';

-- Preflight (fail closed).
DO $preflight$
BEGIN
  -- Fresh replay may reach this before the freeze baseline creates the table;
  -- the baseline (02) creates the policy itself, so no-op safely here.
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE NOTICE 'market_listings absent (pre-freeze replay) - fast-path policy deferred to the freeze baseline';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.market_listings'::regclass
                    AND polname = 'frozen_view') THEN
    RAISE EXCEPTION 'PREFLIGHT: frozen_view policy missing on market_listings - investigate before adding the fast path';
  END IF;
  IF to_regprocedure('public.wassell_view_scope_class(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: wassell_view_scope_class(uuid,uuid) missing';
  END IF;
END $preflight$;

-- Create the fast-path policy (guarded so a pre-freeze replay is a clean no-op).
DO $mk$
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS market_listings_view_fast ON public.market_listings';
  EXECUTE $ddl$
    CREATE POLICY market_listings_view_fast ON public.market_listings
      FOR SELECT TO authenticated
      USING ( (SELECT public.wassell_view_scope_class((SELECT auth.uid()),
               '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid)) = 'all' )
  $ddl$;
END $mk$;

-- Postconditions (fail closed -> whole tx rolls back on any violation).
DO $post$
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.market_listings'::regclass
       AND polname = 'market_listings_view_fast'
       AND polcmd = 'r' AND polpermissive) THEN
    RAISE EXCEPTION 'POST: market_listings_view_fast not created as a permissive SELECT policy';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.market_listings'::regclass
                    AND polname = 'frozen_view') THEN
    RAISE EXCEPTION 'POST: frozen_view disappeared - the scoped path must remain';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE relname = 'market_listings_summary'
                    AND relnamespace = 'public'::regnamespace
                    AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'POST: market_listings_summary is no longer security_invoker=true';
  END IF;

  IF has_table_privilege('anon','public.market_listings_summary','SELECT') THEN
    RAISE EXCEPTION 'POST: anon can SELECT market_listings_summary';
  END IF;

  IF has_table_privilege('authenticated','public.v_market_properties','SELECT')
     OR has_table_privilege('authenticated','public.v_market_listings','SELECT') THEN
    RAISE EXCEPTION 'POST: a full-data view is readable by authenticated';
  END IF;
END $post$;

COMMIT;

-- Verification (manual, per role; not executed here): docs/market-ingest/perf-fix-tests.sql.
