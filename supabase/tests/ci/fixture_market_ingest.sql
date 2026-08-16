-- CI fixture: the SUPPORTED PREDECESSOR STATE for the Gate A market-ingest
-- migrations (2026-09-05_01..04). Runnable by psql -v ON_ERROR_STOP=1 on a
-- blank Postgres 17 database as superuser. Idempotent where practical.

-- ============================================================================
-- SCOPE OF THIS FIXTURE — read before adding anything to it.
--
-- This fixture reproduces the SUPPORTED PREDECESSOR STATE for the four
-- 2026-09-05_* Gate A migrations, and nothing more. It is deliberately NOT a
-- whole-database bootstrap and does NOT prove fresh-database parity.
--
-- It contains exactly two categories of object:
--   (a) Supabase-MANAGED PLATFORM primitives that a real branch database already
--       has and that no repository file creates: the anon / authenticated /
--       service_role roles, the auth schema, and auth.uid().
--   (b) GENUINE repo-provided predecessors, shapes copied from the supported
--       bootstrap: public.aqar_listing_evidence (branch-bootstrap-02.sql) and
--       public.wassell_is_admin(uuid) (branch-bootstrap-05.sql).
--
-- IT MUST NEVER CREATE public.market_listings. That table is created by NO file
-- in this repository; it exists only on production via an out-of-repo ad-hoc
-- freeze (2026-08-06), and the supported bootstrap set was generated 2026-08-01,
-- before it. Adding a stub here would manufacture a passing test for a migration
-- order that does not actually hold. The Gate A migrations were SPLIT so that
-- none of them needs it; 2026-09-05_06 (deferred) owns everything that does.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Supabase roles (NOLOGIN stand-ins; created if absent, attribute-pinned
--    either way). Role attributes mirror verified production: service_role has
--    rolbypassrls=true, anon and authenticated have rolbypassrls=false, all
--    three are NOLOGIN. The BYPASSRLS pin on service_role is LOAD-BEARING for
--    the assertions: it is why service_role skips RLS and sees ALL rows while
--    authenticated subjects are row-filtered by the admin-only read policies.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE anon NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE authenticated NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE service_role BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. auth schema + auth.uid() reading the request JWT claims GUC. Tests
--    switch identity by setting that GUC (see the assertion file's helpers).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 3. public.wassell_is_admin(uuid) — fixture implementation with the SAME
--    signature and declaration flags as the bootstrap original
--    (supabase/branch-bootstrap-05.sql:72 — RETURNS boolean, LANGUAGE sql,
--    STABLE, SECURITY DEFINER, SET search_path TO 'public','pg_temp').
--    Only the signature and definer-ness are load-bearing here: every Gate A
--    read policy calls wassell_is_admin((SELECT auth.uid())), and the
--    migrations preflight on to_regprocedure('public.wassell_is_admin(uuid)').
--    The real body reads profiles/roles; the fixture body reads the
--    fixture-only test_admin table so assertions can pin admin/non-admin
--    identities without the whole access-control schema.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.test_admin (
  user_id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION public.wassell_is_admin(auth_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.test_admin WHERE user_id = $1)
$$;

-- ---------------------------------------------------------------------------
-- 4. public.aqar_listing_evidence — GENUINE repo-provided predecessor, shape
--    copied verbatim from supabase/branch-bootstrap-02.sql:1338 (the rendered
--    form of migrations/2026-07-29_aqar_listing_extract_lane.sql). Load-bearing
--    because raw_blobs.aqar_evidence_listing_id carries a REAL foreign key to
--    it, and 2026-09-05_02 preflights on its presence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.aqar_listing_evidence (
  listing_id text NOT NULL,
  url text NOT NULL,
  bundle text NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqar_listing_evidence_pkey PRIMARY KEY (listing_id)
);

-- ---------------------------------------------------------------------------
-- 5. Test identities. Two are declared; only the ADMIN is seeded into
--    test_admin (the non-admin's absence from test_admin IS its non-admin-ness).
--      admin     11111111-1111-1111-1111-111111111111
--      non-admin 22222222-2222-2222-2222-222222222222
-- ---------------------------------------------------------------------------
INSERT INTO public.test_admin (user_id)
VALUES ('11111111-1111-1111-1111-111111111111')
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. One seed row in aqar_listing_evidence so FK-bearing raw_blobs inserts in
--    the assertions have a target.
-- ---------------------------------------------------------------------------
INSERT INTO public.aqar_listing_evidence (listing_id, url, bundle)
VALUES ('fixture-evidence-1', 'https://sa.aqar.fm/fixture-evidence-1', '{}')
ON CONFLICT (listing_id) DO NOTHING;

-- Create NO Gate A table here — the migrations under test create those, and
-- pre-creating one would hide a broken migration.
