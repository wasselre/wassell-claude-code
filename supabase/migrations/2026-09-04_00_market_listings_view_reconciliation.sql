-- ============================================================================
-- RECONCILIATION · market_listings view security + authorization fast path
-- ----------------------------------------------------------------------------
-- WHAT THIS IS: a CONVERGENT reconciliation migration derived from the recovered
-- migrations 2026-09-03_00 (market_listings view exposure hotfix) and
-- 2026-09-03_01 (unrestricted view fast path) — recovery commit 01b47456,
-- PR #13 — plus live production state verified read-only on 2026-08-10. It is
-- NOT a claim that either historical migration was ever applied to production;
-- it drives the database to the intended end state from the verified live
-- starting state below.
--
-- REPLAY STRATEGY: this file is a ONE-SHOT reconciliation against the verified
-- live production state below. It is deliberately NOT replay-safe:
--   * It FAILS LOUDLY (RAISE EXCEPTION) rather than silently recording a no-op
--     as "applied" against a database that lacks the objects it pins — a
--     migration runner must never mark this file applied having created no
--     policy and hardened no view, because it would then never re-run.
--   * A FRESH database is served by 2026-09-03_00/_01/_02 instead; this file
--     must not run there (preflight aborts when public.market_listings is
--     absent — see §2).
--   * TRACKED FOLLOW-UP: when Gate A 2026-09-03_02 lands it must itself create
--     BOTH market_listings_view_fast AND market_listings_view_deny_none and
--     grant the summary SELECT-only to authenticated, so a fresh replay
--     converges to the same end state without this file.
--   * After any legitimate regenerate_frozen_model_artifacts() run the pinned
--     md5s below may legitimately differ — a human must re-verify the live
--     objects and update the pins first; this migration fails closed rather
--     than guessing.
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
--   fn wassell_view_scope_class(uuid,uuid)
--                                       owner postgres, SECURITY DEFINER,
--                                       stable, search_path=public, pg_temp,
--                                       md5(pg_get_functiondef(oid)) =
--                                       0bcfabe9df9da91ea4d874104fec65d6
--   fn wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)
--                                       owner postgres, SECURITY DEFINER,
--                                       stable, search_path=public, pg_temp,
--                                       md5(pg_get_functiondef(oid)) =
--                                       c9a781616085d3b06eec12d68238b502
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
-- ROLLBACK: docs/market-ingest/reconciliation-rollback.sql is the DEFAULT
-- OPERATIONAL rollback — it restores availability WITHOUT reopening the
-- auto-updatable definer-view write path (authenticated keeps SELECT-only on
-- the summary). docs/market-ingest/reconciliation-breakglass-restore-exact.sql
-- restores the EXACT pre-migration state including the known write-path
-- vulnerability — forensic reconstruction only, requires explicit human
-- authorization, never an operational rollback.
-- ============================================================================

BEGIN;

-- 1. Transaction safety: abort rather than block; no partial changes.
SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. Preflight (fail closed). Convergent: asserts the identity/shape of the
--    objects it touches, NOT the starting value of security_invoker or grants.
DO $preflight$
DECLARE v_views int; v_fn regprocedure;
BEGIN
  -- ONE-SHOT guard: fail closed when the target table is absent. A migration
  -- runner would otherwise record this file as APPLIED having created no
  -- policy and hardened no view — and it would never re-run.
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.market_listings is absent — this file is a one-shot production reconciliation and must NOT be recorded as applied against a database that lacks the table. Apply the freeze baseline (and 2026-09-03_00/_01/_02) first.';
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

  -- 2.3 Pin BOTH SECURITY DEFINER scope functions. Both new policies delegate
  --     their ENTIRE allow/deny decision to wassell_view_scope_class, and
  --     frozen_view's scoped per-row path delegates to wassell_can_view_jsonb.
  --     Both functions are SECURITY DEFINER, so their bodies ARE the trust
  --     boundary: an existence-only check would let owner / definer state /
  --     volatility / search_path / body drift while every other pin still
  --     passes. All six attributes are asserted per function.
  v_fn := to_regprocedure('public.wassell_view_scope_class(uuid,uuid)');
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_view_scope_class(uuid,uuid) missing — the fast-path predicate cannot be built';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_fn
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp'
       AND md5(pg_get_functiondef(p.oid)) = '0bcfabe9df9da91ea4d874104fec65d6'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_view_scope_class(uuid,uuid) does not match the pin (owner=postgres, SECURITY DEFINER, volatility=stable, search_path=public, pg_temp, body md5 0bcfabe9df9da91ea4d874104fec65d6). This is a SECURITY DEFINER function that makes the ENTIRE allow/deny decision for both new policies (market_listings_view_fast + market_listings_view_deny_none) — a drifted body could BROADEN the permissive fast path. A human must re-review the function and re-measure before updating the pin.';
  END IF;

  v_fn := to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)');
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb) missing — frozen_view''s scoped path depends on it';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_fn
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp'
       AND md5(pg_get_functiondef(p.oid)) = 'c9a781616085d3b06eec12d68238b502'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb) does not match the pin (owner=postgres, SECURITY DEFINER, volatility=stable, search_path=public, pg_temp, body md5 c9a781616085d3b06eec12d68238b502). This is a SECURITY DEFINER function whose per-row evaluation, together with wassell_view_scope_class, makes the ENTIRE allow/deny decision for both new policies — a drifted body could BROADEN the permissive fast path. A human must re-review the function and re-measure before updating the pin.';
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
DECLARE v_expr text; v_public int; v_views int; v_acl text; v_colacl text;
BEGIN
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

  -- 4.8 Scope-function pins RE-ASSERTED: proves nothing redefined either
  --     SECURITY DEFINER function mid-transaction. Same six-attribute pin as
  --     preflight §2.3 — see its comment for why the bodies are the trust
  --     boundary.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.wassell_view_scope_class(uuid,uuid)')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp'
       AND md5(pg_get_functiondef(p.oid)) = '0bcfabe9df9da91ea4d874104fec65d6'
  ) THEN
    RAISE EXCEPTION 'POST: public.wassell_view_scope_class(uuid,uuid) no longer matches the pin (owner=postgres, SECURITY DEFINER, volatility=stable, search_path=public, pg_temp, body md5 0bcfabe9df9da91ea4d874104fec65d6) — it was redefined mid-transaction. This is a SECURITY DEFINER function that makes the ENTIRE allow/deny decision for both new policies — a drifted body could BROADEN the permissive fast path. A human must re-review the function and re-measure before updating the pin.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp'
       AND md5(pg_get_functiondef(p.oid)) = 'c9a781616085d3b06eec12d68238b502'
  ) THEN
    RAISE EXCEPTION 'POST: public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb) no longer matches the pin (owner=postgres, SECURITY DEFINER, volatility=stable, search_path=public, pg_temp, body md5 c9a781616085d3b06eec12d68238b502) — it was redefined mid-transaction. This is a SECURITY DEFINER function whose per-row evaluation, together with wassell_view_scope_class, makes the ENTIRE allow/deny decision for both new policies — a drifted body could BROADEN the permissive fast path. A human must re-review the function and re-measure before updating the pin.';
  END IF;

  -- 4.9 ACL EXACT-SET assertions over pg_class.relacl + aclexplode (grantee
  --     resolved via pg_get_userbyid, grantee oid 0 = PUBLIC). aclexplode is
  --     used INSTEAD of information_schema.role_table_grants because
  --     role_table_grants does NOT surface MAINTAIN (PostgreSQL 17 added the
  --     MAINTAIN privilege and folded it into GRANT ALL): an exact-set
  --     assertion written against role_table_grants cannot see one privilege
  --     class and would give false assurance. These assertions cover ALL
  --     privilege types — including REFERENCES, TRIGGER, and MAINTAIN — and
  --     supersede the former per-privilege has_table_privilege checks:
  --       * 'anon has no SELECT anywhere'                 -> anon = (none) on all three
  --       * 'authenticated has no SELECT on full-data'    -> authenticated = (none) on both
  --       * 'authenticated keeps SELECT on the summary'   -> authenticated = exactly SELECT
  --       * 'authenticated has no write privilege on the summary' -> same exact-SELECT row.
  --     The write-privilege check existed because the summary is auto-updatable
  --     (information_schema.views.is_updatable='YES'): while it was
  --     security_invoker=false with authenticated holding ALL, the write
  --     grants were a path into the base table that bypassed the
  --     frozen_insert/frozen_update/frozen_delete policies. Application writes
  --     go through record_save / record_delete, never this view.
  --     GRANTABILITY-AWARE: every privilege is rendered as
  --     privilege_type || '*' when held WITH GRANT OPTION, and both the
  --     DISTINCT aggregate and its ORDER BY use that rendered form. REVOKE
  --     only removes grants issued by the REVOKING grantor, so a delegation
  --     granted to authenticated/anon by ANY OTHER role holding the grant
  --     option survives this migration's REVOKEs (verified empirically:
  --     GRANT SELECT ... WITH GRANT OPTION from a second grantor survives
  --     REVOKE ALL issued by the owner). A privilege-name-only aggregate
  --     would see just 'SELECT' and PASS while authenticated retains the
  --     power to RE-GRANT access; the grantability-aware rendering sees
  --     'SELECT,SELECT*' (or 'SELECT*') and FAILS CLOSED, aborting the whole
  --     transaction so a human investigates.
  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.market_listings_summary'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> 'SELECT' THEN
    RAISE EXCEPTION 'POST: authenticated privileges on market_listings_summary must be exactly SELECT, found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.v_market_listings'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: authenticated privileges on v_market_listings must be exactly (none), found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.v_market_properties'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: authenticated privileges on v_market_properties must be exactly (none), found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.market_listings_summary'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'anon';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: anon privileges on market_listings_summary must be exactly (none), found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.v_market_listings'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'anon';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: anon privileges on v_market_listings must be exactly (none), found: %', v_acl;
  END IF;

  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.v_market_properties'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'anon';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: anon privileges on v_market_properties must be exactly (none), found: %', v_acl;
  END IF;

  -- 4.9b COLUMN-LEVEL grants (pg_attribute.attacl): the relacl exact-set
  --      assertions above are BLIND to column privileges — a
  --      GRANT SELECT (col) ON <view> TO <role> is stored per-column in
  --      pg_attribute.attacl and never appears in pg_class.relacl, so every
  --      assertion in §4.9 reports (none) while it is in force. The fix here
  --      is DETECTION, not repair, for the same reason §4.9 is
  --      grantability-aware: a table-level REVOKE ALL DOES automatically
  --      remove same-grantor column grants (documented REVOKE behavior,
  --      verified empirically on PostgreSQL 16/17), so §3c's REVOKEs already
  --      clean up anything the view owner granted — per-column REVOKE
  --      statements would be pure redundancy and are deliberately NOT added.
  --      Any column grant that SURVIVES to this point was therefore issued by
  --      a DIFFERENT grantor holding the grant option, and this migration
  --      cannot remove it; the only correct response is to FAIL CLOSED so a
  --      human re-issues the REVOKE as that grantor. The stakes are concrete:
  --      a surviving SELECT (source_payload) on v_market_listings would leave
  --      the exact column 2026-09-03_00 guarantees is not exposed readable by
  --      its grantee while the relacl assertions report a clean ACL. The end
  --      state of this migration is NO column-level grants of any kind on any
  --      of the three views, so the assertion is against the empty set.
  --      aclexplode(NULL attacl) yields no rows, so un-granted views
  --      contribute nothing.
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
    RAISE EXCEPTION 'POST: column-level grants survive on the target views: %. Column privileges live in pg_attribute.attacl and are invisible to pg_class.relacl, so the relacl exact-set assertions above cannot see them. This migration''s table-level REVOKE ALL DOES remove same-grantor column grants, so any survivor was issued by a DIFFERENT grantor and cannot be revoked by this migration — REVOKE must be re-issued AS THAT GRANTOR. A surviving SELECT (source_payload) would defeat the 2026-09-03_00 guarantee that the summary never exposes source_payload. Investigate and re-run.', v_colacl;
  END IF;

  -- 4.10 service_role keeps SELECT on all three.
  IF NOT (has_table_privilege('service_role','public.market_listings_summary','SELECT')
      AND has_table_privilege('service_role','public.v_market_listings','SELECT')
      AND has_table_privilege('service_role','public.v_market_properties','SELECT')) THEN
    RAISE EXCEPTION 'POST: service_role lost SELECT on a target view';
  END IF;

  -- 4.11 Base-table SELECT is now load-bearing: with market_listings_summary at
  --     security_invoker=true the view executes with the CALLER's privileges, so
  --     authenticated's SELECT on public.market_listings is what lets the
  --     authenticated SPA read the summary. Revoking it would break the SPA
  --     with 'permission denied for table market_listings'. (anon is not
  --     asserted here — it is gated by RLS policy role-targeting, not grants.)
  IF NOT (has_table_privilege('authenticated','public.market_listings','SELECT')
      AND has_table_privilege('service_role','public.market_listings','SELECT')) THEN
    RAISE EXCEPTION 'POST: authenticated/service_role lost SELECT on the base table public.market_listings — security_invoker=true on market_listings_summary makes the caller''s base-table SELECT load-bearing, so revoking it would break the authenticated SPA';
  END IF;

  -- 4.12 No PUBLIC grant remains (grantee 0 = PUBLIC).
  SELECT count(*) INTO v_public FROM (
    SELECT (aclexplode(relacl)).grantee AS g FROM pg_class
     WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
       AND relnamespace = 'public'::regnamespace
  ) a WHERE a.g = 0;
  IF v_public <> 0 THEN RAISE EXCEPTION 'POST: a PUBLIC grant remains on a target view'; END IF;

  -- 4.13 Summary still does not expose source_payload.
  IF pg_get_viewdef('public.market_listings_summary'::regclass) ~* 'source_payload' THEN
    RAISE EXCEPTION 'POST: market_listings_summary exposes source_payload';
  END IF;
END $post$;

COMMIT;

-- Rollback (manual; DEFAULT OPERATIONAL — restores availability, SELECT-only):
--   docs/market-ingest/reconciliation-rollback.sql
-- Break-glass EXACT restore (forensic only — REOPENS the write-path gap):
--   docs/market-ingest/reconciliation-breakglass-restore-exact.sql
