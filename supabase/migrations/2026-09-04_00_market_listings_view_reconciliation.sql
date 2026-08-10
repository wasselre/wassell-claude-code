-- ============================================================================
-- RECONCILIATION · market_listings view security + authorization fast path
-- ----------------------------------------------------------------------------
-- WHAT THIS IS: a CONVERGENT reconciliation migration derived from the recovered
-- migrations 2026-09-03_00 (market_listings view exposure hotfix) and
-- 2026-09-03_01 (unrestricted view fast path) — recovery commit 01b47456,
-- PR #13 — plus live production state verified read-only on 2026-08-10. It is
-- NOT a claim that either historical migration was ever applied to production;
-- it drives the database to the intended end state from the verified live
-- starting state below. It does NOT claim to succeed cleanly on a fresh replay
-- after 2026-09-03_00/_01/_02: the preflight pins the md5 of frozen_view's
-- predicate AND the md5 of all three view bodies to the objects as they exist
-- in live production today, and on a fresh replay those objects are regenerated
-- by the freeze baseline, so their md5s may legitimately differ. In that case —
-- or after any legitimate regenerate_frozen_model_artifacts() run — the pinned
-- md5s must be re-verified and updated by a human first; this migration fails
-- closed rather than guessing.
--
-- WHY ONE ATOMIC TRANSACTION: the fix has two halves that must land together —
--   (a) the three views flipped to security_invoker=true with grants tightened,
--       which restores base-table RLS (frozen_view) UNDER the summary view, and
--   (b) the market_listings_view_fast policy that keeps authenticated SPA reads
--       fast once RLS applies under the summary.
--   Applying (a) without (b) would leave an interval where security is restored
--   but every authenticated market_listings read pays frozen_view's per-row
--   90-column jsonb rebuild across 314k rows (the 2026-09-03 timeout incident).
--   The fast-path policy is therefore created BEFORE the summary is flipped to
--   invoker, all inside one tx, so no reader ever sees the slow-secure
--   intermediate state.
--
-- WHY THE RESTRICTIVE 'none' DENY IS AN ADDITION BEYOND 2026-09-03_01:
-- measured against live production 2026-08-10 in rolled-back transactions
-- (warm cache), SELECT count(*) FROM public.market_listings_summary for a
-- user whose scope class is 'none' costs:
--   * today (summary security_invoker=false, base RLS never applies):
--     596 ms, 0 rows;
--   * with only the recovered 2026-09-03_01 applied: ~0.95 ms/row over
--     314,070 rows ~= 299 s -> statement timeout. Cause: once the summary is
--     security_invoker=true, frozen_view applies, and it has NO scope-class
--     guard — it rebuilds a ~90-key jsonb and calls wassell_can_view_jsonb
--     PER ROW; market_listings_view_fast only fast-paths 'all', so 'none'
--     falls through to the per-row path;
--   * with the market_listings_view_deny_none RESTRICTIVE policy added:
--     613 ms, 0 rows, and every per-row wassell_can_view_jsonb InitPlan
--     reports 'never executed' — parity with today.
--   The recovered 2026-09-03_01 ALONE would regress 'none' users from
--   596 ms to a timeout; the restrictive policy is required on top of it.
--
-- VERIFIED LIVE STARTING STATE (read-only audit, 2026-08-10):
--   object                              state
--   public.market_listings              frozen physical table, relrowsecurity = true
--   policy frozen_view                  SELECT, permissive, roles {authenticated},
--                                       md5(pg_get_expr(polqual,polrelid)) =
--                                       6087e8fdcfcb9f3df3da7898c1163c18
--   policies frozen_insert/_update/_delete  present
--   policy market_listings_view_fast    ABSENT
--   view market_listings_summary        owner postgres, reloptions={security_invoker=false},
--                                       md5(pg_get_viewdef(oid)) = 0ddd7ab480fcf167ca9d684d9c1f2db6
--   view v_market_listings              owner postgres, reloptions IS NULL
--                                       (security_invoker unset => definer),
--                                       md5(pg_get_viewdef(oid)) = 3675d4c9bab1019312eae01035ab18ba
--   view v_market_properties            owner postgres, reloptions={security_invoker=true},
--                                       md5(pg_get_viewdef(oid)) = 416a3eaac713f2eaf27d46f8867c5d4a
--   grants on market_listings_summary   authenticated ALL; service_role ALL;
--                                       no PUBLIC, no anon
--   grants on the two full-data views   service_role ALL only;
--                                       no PUBLIC, no anon, no authenticated
--   (md5 values are the NON-pretty pg_get_viewdef(c.oid) form. Setting
--    security_invoker does NOT change pg_get_viewdef, so these pins stay valid
--    across the mutations below.)
--
-- Model market_listings id = 8f06bc39-4bee-42e9-9fab-77023fb89ede (verified
-- against public.models; preflight re-verifies because the fast-path policy
-- hardcodes it in its predicate).
--
-- ROLLBACK: docs/market-ingest/reconciliation-rollback.sql — restores the exact
-- starting state above. Read its warning first: it reopens the auto-updatable
-- write-path gap on market_listings_summary.
-- ============================================================================

BEGIN;

-- 1. Transaction safety: abort rather than block; no partial changes.
SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. Preflight (fail closed). Convergent: asserts the identity/shape of the
--    objects it touches, NOT the starting value of security_invoker or grants.
DO $preflight$
DECLARE v_views int;
BEGIN
  -- Fresh replay may reach this before the freeze baseline creates the table;
  -- the baseline + 2026-09-03_00/_01 own the end state there, so no-op safely.
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE NOTICE 'market_listings absent (pre-freeze replay) - reconciliation deferred to the freeze baseline + 2026-09-03_00/_01';
    RETURN;
  END IF;

  -- 2.1 Model identity: the fast-path policy hardcodes this UUID.
  IF (SELECT id FROM public.models WHERE name = 'market_listings')
       IS DISTINCT FROM '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid THEN
    RAISE EXCEPTION 'PREFLIGHT: models.id for market_listings is not 8f06bc39-4bee-42e9-9fab-77023fb89ede — the hardcoded UUID in the fast-path policy predicate would be wrong; STOP and investigate';
  END IF;

  -- 2.2 RLS must be on before the views are flipped to invoker.
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.market_listings'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'PREFLIGHT: market_listings.relrowsecurity is false — RLS must be enabled before the views become security_invoker';
  END IF;

  -- 2.3 Helper functions both paths depend on.
  IF to_regprocedure('public.wassell_view_scope_class(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: wassell_view_scope_class(uuid,uuid) missing — the fast-path predicate cannot be built';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'wassell_can_view_jsonb') THEN
    RAISE EXCEPTION 'PREFLIGHT: no wassell_can_view_jsonb procedure in public — frozen_view''s scoped path depends on it';
  END IF;

  -- 2.4 frozen_view pinned: permissive SELECT, roles exactly {authenticated},
  --     predicate md5 pinned. A legitimate regenerate_frozen_model_artifacts()
  --     run can change this predicate — a human must re-verify the live policy
  --     and update the pin before proceeding.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.market_listings'::regclass
       AND p.polname = 'frozen_view'
       AND p.polcmd = 'r' AND p.polpermissive
       AND p.polroles::regrole[] = ARRAY['authenticated'::regrole]
       AND md5(pg_get_expr(p.polqual, p.polrelid)) = '6087e8fdcfcb9f3df3da7898c1163c18'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: frozen_view on market_listings does not match the pinned shape (permissive SELECT, roles exactly {authenticated}, predicate md5 6087e8fdcfcb9f3df3da7898c1163c18). A legitimate regenerate_frozen_model_artifacts() run can change this — a human must re-verify the live policy and update the pin before proceeding.';
  END IF;

  -- 2.5 All three views must exist, be plain views, and be owned by postgres.
  IF to_regclass('public.market_listings_summary') IS NULL
     OR to_regclass('public.v_market_listings') IS NULL
     OR to_regclass('public.v_market_properties') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: a target view is absent — STOP and investigate';
  END IF;
  SELECT count(*) INTO v_views FROM pg_class
   WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
     AND relnamespace = 'public'::regnamespace AND relkind = 'v'
     AND pg_get_userbyid(relowner) = 'postgres';
  IF v_views <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT: expected 3 plain views owned by postgres, found % — investigate', v_views;
  END IF;

  -- 2.6 Pin each view body (NON-pretty pg_get_viewdef). Abort on mismatch.
  IF md5(pg_get_viewdef('public.market_listings_summary'::regclass)) <> '0ddd7ab480fcf167ca9d684d9c1f2db6' THEN
    RAISE EXCEPTION 'PREFLIGHT: market_listings_summary definition md5 mismatch — a human must re-verify the live view and update the pin';
  END IF;
  IF md5(pg_get_viewdef('public.v_market_listings'::regclass)) <> '3675d4c9bab1019312eae01035ab18ba' THEN
    RAISE EXCEPTION 'PREFLIGHT: v_market_listings definition md5 mismatch — a human must re-verify the live view and update the pin';
  END IF;
  IF md5(pg_get_viewdef('public.v_market_properties'::regclass)) <> '416a3eaac713f2eaf27d46f8867c5d4a' THEN
    RAISE EXCEPTION 'PREFLIGHT: v_market_properties definition md5 mismatch — a human must re-verify the live view and update the pin';
  END IF;

  -- 2.7 Carry forward the 2026-09-03_00 guarantee: the summary must not expose source_payload.
  IF pg_get_viewdef('public.market_listings_summary'::regclass) ~* 'source_payload' THEN
    RAISE EXCEPTION 'PREFLIGHT: market_listings_summary definition unexpectedly exposes source_payload — investigate before reconciling';
  END IF;
END $preflight$;

-- 3. Mutations, in order: fast-path policy FIRST (so the authorization fast
--    path is in place when RLS begins to apply under the summary), then the
--    security_invoker flips, then grants.
DO $mk$
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN RETURN; END IF;

  -- 3a. Authorization fast path on the base table (posture of 2026-09-03_01).
  EXECUTE 'DROP POLICY IF EXISTS market_listings_view_fast ON public.market_listings';
  EXECUTE $ddl$
    CREATE POLICY market_listings_view_fast ON public.market_listings
      FOR SELECT TO authenticated
      USING ( (SELECT public.wassell_view_scope_class((SELECT auth.uid()),
               '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid)) = 'all' )
  $ddl$;

  -- 3a.2 Deny scope-class 'none' via a RESTRICTIVE policy. RESTRICTIVE policies
  --     AND with the permissive group, so this can only ever NARROW access,
  --     never broaden it. For 'none' it is a single uncorrelated InitPlan
  --     evaluated once per statement that excludes every row before the per-row
  --     path runs; for 'all' and 'filtered' it is true, so their semantics are
  --     completely unchanged. Its name is deliberately not frozen_*, so
  --     regenerate_frozen_model_artifacts() will not drop it — same durability
  --     argument as market_listings_view_fast.
  EXECUTE 'DROP POLICY IF EXISTS market_listings_view_deny_none ON public.market_listings';
  EXECUTE $ddl2$
    CREATE POLICY market_listings_view_deny_none ON public.market_listings
      AS RESTRICTIVE FOR SELECT TO authenticated
      USING ( (SELECT public.wassell_view_scope_class((SELECT auth.uid()),
               '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid)) <> 'none' )
  $ddl2$;

  -- 3b. Flip all three views to security_invoker=true (reloptions only — no
  --     view body is rewritten).
  EXECUTE 'ALTER VIEW public.market_listings_summary SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.v_market_listings       SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.v_market_properties     SET (security_invoker = true)';

  -- 3c. Grants. Revoke first, then grant back exactly what is needed.
  --     NOTE: revoking ALL from authenticated on the summary and granting back
  --     only SELECT deliberately removes the pre-existing INSERT/UPDATE/DELETE/
  --     TRUNCATE grants: the summary view is auto-updatable
  --     (information_schema.views.is_updatable='YES'), so while it was
  --     security_invoker=false those grants were a write path into the base
  --     table that bypassed the frozen_insert/frozen_update/frozen_delete
  --     policies. Application writes go through the record_save /
  --     record_delete RPCs, never through this view. service_role is NOT
  --     revoked — it retains its existing operational access.
  EXECUTE 'REVOKE ALL ON public.v_market_properties     FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON public.v_market_listings       FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON public.market_listings_summary FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.market_listings_summary TO authenticated';
  EXECUTE 'GRANT SELECT ON public.v_market_properties     TO service_role';
  EXECUTE 'GRANT SELECT ON public.v_market_listings       TO service_role';
  EXECUTE 'GRANT SELECT ON public.market_listings_summary TO service_role';
END $mk$;

-- 4. Postconditions (fail closed -> whole transaction rolls back on any violation).
DO $post$
DECLARE v_expr text; v_public int; v_views int;
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN RETURN; END IF;

  -- 4.1 + 4.2 Fast-path policy: exact role and predicate, not just the name.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_expr
    FROM pg_policy p
   WHERE p.polrelid = 'public.market_listings'::regclass
     AND p.polname = 'market_listings_view_fast'
     AND p.polcmd = 'r' AND p.polpermissive
     AND p.polroles::regrole[] = ARRAY['authenticated'::regrole];
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'POST: market_listings_view_fast missing or not a permissive SELECT to exactly {authenticated}';
  END IF;
  IF v_expr NOT LIKE '%wassell_view_scope_class%'
     OR position('8f06bc39-4bee-42e9-9fab-77023fb89ede' IN v_expr) = 0
     OR v_expr NOT LIKE '%''all''%'
     OR v_expr ~* 'wassell_can_view_jsonb' THEN
    RAISE EXCEPTION 'POST: market_listings_view_fast predicate is not the fast branch only (need wassell_view_scope_class + model id + ''all'', never the per-row wassell_can_view_jsonb path): %', v_expr;
  END IF;

  -- 4.2b Deny-none policy: exact shape, not just the name. It MUST be
  --      restrictive — a permissive version would BROADEN access.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_expr
    FROM pg_policy p
   WHERE p.polrelid = 'public.market_listings'::regclass
     AND p.polname = 'market_listings_view_deny_none'
     AND p.polcmd = 'r' AND NOT p.polpermissive
     AND p.polroles::regrole[] = ARRAY['authenticated'::regrole];
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'POST: market_listings_view_deny_none missing or not a RESTRICTIVE SELECT to exactly {authenticated} — if it were created permissive it would BROADEN access';
  END IF;
  IF v_expr NOT LIKE '%wassell_view_scope_class%'
     OR position('8f06bc39-4bee-42e9-9fab-77023fb89ede' IN v_expr) = 0
     OR v_expr NOT LIKE '%<>%'
     OR v_expr NOT LIKE '%''none''%'
     OR v_expr ~* 'wassell_can_view_jsonb' THEN
    RAISE EXCEPTION 'POST: market_listings_view_deny_none predicate is not the scope-class guard only (need wassell_view_scope_class + model id + <> ''none'', never the per-row wassell_can_view_jsonb path): %', v_expr;
  END IF;

  -- 4.3 frozen_view untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.market_listings'::regclass
       AND p.polname = 'frozen_view'
       AND p.polcmd = 'r' AND p.polpermissive
       AND p.polroles::regrole[] = ARRAY['authenticated'::regrole]
       AND md5(pg_get_expr(p.polqual, p.polrelid)) = '6087e8fdcfcb9f3df3da7898c1163c18'
  ) THEN
    RAISE EXCEPTION 'POST: frozen_view changed — it must remain a permissive SELECT to exactly {authenticated} with predicate md5 6087e8fdcfcb9f3df3da7898c1163c18';
  END IF;

  -- 4.4 The other frozen_* policies still present.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_insert')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_update')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_delete') THEN
    RAISE EXCEPTION 'POST: a frozen_insert/frozen_update/frozen_delete policy disappeared';
  END IF;

  -- 4.5 RLS still on.
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.market_listings'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POST: market_listings lost relrowsecurity';
  END IF;

  -- 4.6 All three views security_invoker=true.
  SELECT count(*) INTO v_views FROM pg_class
   WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
     AND relnamespace = 'public'::regnamespace
     AND reloptions @> ARRAY['security_invoker=true'];
  IF v_views <> 3 THEN RAISE EXCEPTION 'POST: security_invoker!=true on % of 3 views', 3-v_views; END IF;

  -- 4.7 View bodies unchanged (only reloptions were meant to change).
  IF md5(pg_get_viewdef('public.market_listings_summary'::regclass)) <> '0ddd7ab480fcf167ca9d684d9c1f2db6'
     OR md5(pg_get_viewdef('public.v_market_listings'::regclass)) <> '3675d4c9bab1019312eae01035ab18ba'
     OR md5(pg_get_viewdef('public.v_market_properties'::regclass)) <> '416a3eaac713f2eaf27d46f8867c5d4a' THEN
    RAISE EXCEPTION 'POST: a view body changed (pg_get_viewdef md5 mismatch) — only reloptions were meant to change';
  END IF;

  -- 4.8 anon has no SELECT anywhere.
  IF has_table_privilege('anon','public.market_listings_summary','SELECT')
     OR has_table_privilege('anon','public.v_market_listings','SELECT')
     OR has_table_privilege('anon','public.v_market_properties','SELECT') THEN
    RAISE EXCEPTION 'POST: anon can still SELECT a target view';
  END IF;

  -- 4.9 authenticated has no SELECT on the full-data views.
  IF has_table_privilege('authenticated','public.v_market_listings','SELECT')
     OR has_table_privilege('authenticated','public.v_market_properties','SELECT') THEN
    RAISE EXCEPTION 'POST: authenticated can still SELECT a full-data view';
  END IF;

  -- 4.10 authenticated keeps SELECT on the summary (the SPA depends on it).
  IF NOT has_table_privilege('authenticated','public.market_listings_summary','SELECT') THEN
    RAISE EXCEPTION 'POST: authenticated lost SELECT on market_listings_summary (SPA would break)';
  END IF;

  -- 4.11 authenticated has NO write privilege on the summary.
  IF has_table_privilege('authenticated','public.market_listings_summary','INSERT')
     OR has_table_privilege('authenticated','public.market_listings_summary','UPDATE')
     OR has_table_privilege('authenticated','public.market_listings_summary','DELETE')
     OR has_table_privilege('authenticated','public.market_listings_summary','TRUNCATE') THEN
    RAISE EXCEPTION 'POST: authenticated retains a write privilege on market_listings_summary — the auto-updatable write path must stay closed';
  END IF;

  -- 4.12 service_role keeps SELECT on all three.
  IF NOT (has_table_privilege('service_role','public.market_listings_summary','SELECT')
      AND has_table_privilege('service_role','public.v_market_listings','SELECT')
      AND has_table_privilege('service_role','public.v_market_properties','SELECT')) THEN
    RAISE EXCEPTION 'POST: service_role lost SELECT on a target view';
  END IF;

  -- 4.13 No PUBLIC grant remains (grantee 0 = PUBLIC).
  SELECT count(*) INTO v_public FROM (
    SELECT (aclexplode(relacl)).grantee AS g FROM pg_class
     WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
       AND relnamespace = 'public'::regnamespace
  ) a WHERE a.g = 0;
  IF v_public <> 0 THEN RAISE EXCEPTION 'POST: a PUBLIC grant remains on a target view'; END IF;

  -- 4.14 Summary still does not expose source_payload.
  IF pg_get_viewdef('public.market_listings_summary'::regclass) ~* 'source_payload' THEN
    RAISE EXCEPTION 'POST: market_listings_summary exposes source_payload';
  END IF;
END $post$;

COMMIT;

-- Rollback (manual; restores the exact verified starting state):
--   docs/market-ingest/reconciliation-rollback.sql
