-- ============================================================================
-- Phase 1 · Gate A · 07 · ACL hardening — revoke inherited default privileges
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- ROOT CAUSE. Supabase ships ALTER DEFAULT PRIVILEGES on schema `public` that
-- grant arwdDxtm (ALL) on every NEW table to anon, authenticated AND
-- service_role — from TWO grantors, `postgres` and `supabase_admin`:
--
--   pg_default_acl (schema public, objtype 'r'):
--     postgres       -> {postgres=arwdDxtm/postgres,       anon=arwdDxtm/postgres,
--                        authenticated=arwdDxtm/postgres,  service_role=arwdDxtm/postgres}
--     supabase_admin -> {postgres=arwdDxtm/supabase_admin, anon=arwdDxtm/supabase_admin,
--                        authenticated=arwdDxtm/supabase_admin, service_role=arwdDxtm/supabase_admin}
--
-- Gate A migrations 2026-09-05_01.._04 and _06 each did
-- `REVOKE ALL ... FROM PUBLIC, anon` then `GRANT SELECT ... TO authenticated,
-- service_role`. That correctly stripped anon, but nothing ever revoked the
-- inherited default from authenticated or service_role, so both ended up
-- holding all eight privileges instead of SELECT.
--
-- WHY THIS IS URGENT, NOT COSMETIC. For `authenticated` the excess privileges
-- are unreachable: RLS is enabled on every Gate A table with a SELECT-only
-- admin policy and no write policy, so INSERT is refused with SQLSTATE 42501.
-- For `service_role` they are NOT unreachable — service_role holds BYPASSRLS,
-- so RLS never evaluates for it and its INSERT / UPDATE / DELETE / TRUNCATE /
-- REFERENCES / TRIGGER / MAINTAIN privileges on the raw-evidence, governance
-- and audit tables are DIRECTLY EXERCISABLE. Append-only triggers still block
-- UPDATE/DELETE on the evidence tables, but TRUNCATE bypasses triggers
-- entirely and nothing at all guarded the governance tables.
--
-- WHAT THIS MIGRATION DOES. Revokes every non-SELECT relation privilege from
-- authenticated and service_role on exactly the fourteen Gate A tables and
-- v_source_field_status, leaving SELECT only. Nothing else.
--
-- WHAT IT DELIBERATELY DOES NOT DO. It does NOT touch pg_default_acl. Changing
-- the global default would silently alter the grant posture of every future
-- object in `public` across the entire application and needs its own
-- repository-wide impact assessment. It also does not touch owners, RLS
-- policies, market_listings, or any object outside the Gate A set.
--
-- FUTURE GATE A MIGRATIONS MUST REVOKE EXPLICITLY. `REVOKE ALL FROM PUBLIC,
-- anon` is not sufficient on this platform. Any new Gate A table must also
-- revoke the non-SELECT privileges from authenticated and service_role, or it
-- will inherit the same broad default. See docs/market-ingest/gate-a.md.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(n, ', ' ORDER BY n) INTO v_missing
    FROM unnest(ARRAY[
      'listing_sources','raw_blobs','raw_snapshots','raw_snapshot_artifacts','page_capture_manifest',
      'source_field_catalog','source_field_mappings','schema_gap_events','ingestion_runs',
      'ingestion_items','listing_change_events','listing_change_review',
      'listing_field_provenance','mirror_outbox','v_source_field_status']) AS n
   WHERE to_regclass('public.'||n) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: Gate A object(s) absent: %. Apply 2026-09-05_01..04 and _06 (and, on a fresh database, 2026-09-03_02) first.', v_missing;
  END IF;
END $preflight$;

-- Revoke the inherited defaults. SELECT is re-granted explicitly so the
-- statement is safe to run against an object that somehow lacks it, and so the
-- intended end state is stated in the migration rather than merely implied.
DO $harden$
DECLARE
  v_objects text[] := ARRAY[
    'listing_sources',
    'raw_blobs','raw_snapshots','raw_snapshot_artifacts','page_capture_manifest',
    'source_field_catalog','source_field_mappings','schema_gap_events',
    'ingestion_runs','ingestion_items','listing_change_events','listing_change_review',
    'listing_field_provenance','mirror_outbox',
    'v_source_field_status'];
  v_o text;
BEGIN
  FOREACH v_o IN ARRAY v_objects LOOP
    -- PUBLIC and anon must hold nothing at all.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', v_o);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v_o);
    -- authenticated and service_role: strip every non-SELECT privilege, keep SELECT.
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM authenticated, service_role',
      v_o);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', v_o);
  END LOOP;
END $harden$;

-- ---------------------------------------------------------------------------
-- Assert the exact final ACL matrix. Grantability-aware: a privilege held WITH
-- GRANT OPTION renders as `SELECT*` and therefore fails the equality below.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_objects text[] := ARRAY[
    'listing_sources',
    'raw_blobs','raw_snapshots','raw_snapshot_artifacts','page_capture_manifest',
    'source_field_catalog','source_field_mappings','schema_gap_events',
    'ingestion_runs','ingestion_items','listing_change_events','listing_change_review',
    'listing_field_provenance','mirror_outbox',
    'v_source_field_status'];
  v_o     text;
  v_grantee text;
  v_acl   text;
  v_want  text;
BEGIN
  FOREACH v_o IN ARRAY v_objects LOOP
    FOREACH v_grantee IN ARRAY ARRAY['PUBLIC','anon','authenticated','service_role'] LOOP
      SELECT coalesce(string_agg(DISTINCT
               a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
               ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END),
             '(none)')
        INTO v_acl
        FROM pg_class c
             CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.oid = format('public.%I', v_o)::regclass
         AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END = v_grantee;

      v_want := CASE WHEN v_grantee IN ('PUBLIC','anon') THEN '(none)' ELSE 'SELECT' END;
      IF v_acl <> v_want THEN
        RAISE EXCEPTION 'ASSERT: % on public.% must be %, found: %', v_grantee, v_o, v_want, v_acl;
      END IF;
    END LOOP;

    -- Owner must be unchanged.
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = format('public.%I', v_o)::regclass) <> 'postgres' THEN
      RAISE EXCEPTION 'ASSERT: owner of public.% changed', v_o;
    END IF;
  END LOOP;

  -- RLS must still be enabled on all fourteen tables, with exactly one policy each.
  IF EXISTS (
    SELECT 1 FROM unnest(v_objects) o
      JOIN pg_class c ON c.relname = o AND c.relnamespace = 'public'::regnamespace
     WHERE c.relkind = 'r'
       AND (NOT c.relrowsecurity
            OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) <> 1)
  ) THEN
    RAISE EXCEPTION 'ASSERT: RLS disabled or policy count changed on a Gate A table';
  END IF;
END $assert$;

COMMIT;
