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
DECLARE v_acl text; v_colacl text;
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
  --      all privilege types, incl. REFERENCES, TRIGGER, and MAINTAIN).
  --      Asserted over pg_class.relacl + aclexplode (grantee resolved via
  --      pg_get_userbyid, grantee oid 0 = PUBLIC), NOT
  --      information_schema.role_table_grants: role_table_grants does NOT
  --      surface MAINTAIN (PostgreSQL 17 added it and folded it into
  --      GRANT ALL), so an exact-set assertion written against
  --      role_table_grants cannot see one privilege class and would give
  --      false assurance. GRANTABILITY-AWARE: each privilege is rendered as
  --      privilege_type || '*' when held WITH GRANT OPTION. REVOKE only
  --      removes grants issued by the REVOKING grantor, so a delegation
  --      granted to authenticated by ANY OTHER role holding the grant option
  --      survives this rollback's REVOKEs (verified empirically: a second
  --      grantor's GRANT SELECT ... WITH GRANT OPTION survives the owner's
  --      REVOKE ALL). A privilege-name-only aggregate would see just
  --      'SELECT' and PASS while authenticated retains the power to RE-GRANT
  --      access; the grantability-aware rendering sees 'SELECT,SELECT*' (or
  --      'SELECT*') and FAILS CLOSED, aborting the whole transaction so a
  --      human investigates.
  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.oid = 'public.market_listings_summary'::regclass
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'authenticated';
  IF v_acl <> 'SELECT' THEN
    RAISE EXCEPTION 'POST: authenticated privileges on market_listings_summary must be exactly SELECT after the rollback, found: %', v_acl;
  END IF;

  -- POST.5 anon still has no privileges on any of the three views (same
  --      aclexplode form as POST.4 — role_table_grants is blind to MAINTAIN;
  --      same grantability-aware rendering, so a surviving foreign-grantor
  --      WITH GRANT OPTION delegation fails closed here too).
  SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
    INTO v_acl
    FROM pg_class c
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE c.relname IN ('market_listings_summary','v_market_listings','v_market_properties')
     AND c.relnamespace = 'public'::regnamespace
     AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = 'anon';
  IF v_acl <> '(none)' THEN
    RAISE EXCEPTION 'POST: anon privileges on the target views must be exactly (none) after the rollback, found: %', v_acl;
  END IF;

  -- POST.6 No COLUMN-LEVEL grants on any of the three views. The relacl
  --      assertions above are blind to column privileges — those live in
  --      pg_attribute.attacl and never appear in pg_class.relacl. The
  --      pre-migration state this rollback restores had NONE, so the empty
  --      set is the correct end state here too. Detection, not repair, same
  --      as the migration's §4.9b: this script's table-level REVOKE ALL on the
  --      summary DOES remove same-grantor column grants automatically, so any
  --      survivor was issued by a DIFFERENT grantor and cannot be revoked by
  --      this script — a human must re-issue the REVOKE as that grantor. A
  --      surviving SELECT (source_payload) on v_market_listings would defeat
  --      the 2026-09-03_00 guarantee that source_payload is not exposed.
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
    RAISE EXCEPTION 'POST: column-level grants survive on the target views after the rollback: %. Column privileges live in pg_attribute.attacl and are invisible to pg_class.relacl, so the relacl exact-set assertions above cannot see them. This script''s table-level REVOKE ALL DOES remove same-grantor column grants, so any survivor was issued by a DIFFERENT grantor and cannot be revoked by this script — REVOKE must be re-issued AS THAT GRANTOR. A surviving SELECT (source_payload) would defeat the 2026-09-03_00 guarantee that the summary never exposes source_payload. Investigate and re-run.', v_colacl;
  END IF;
END $post$;

COMMIT;
