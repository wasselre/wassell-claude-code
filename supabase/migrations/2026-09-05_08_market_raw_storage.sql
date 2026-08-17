-- ============================================================================
-- Phase 1 · Gate B · 08 · market-raw immutable evidence bucket
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- Creates the private `market-raw` bucket that holds immutable, content-addressed
-- raw extraction evidence, and the Storage RLS that makes it append-only for
-- every routine identity.
--
-- IDENTITY DESIGN — why there is no custom Postgres role here.
-- The original Gate A sketch wanted a NOLOGIN/NOBYPASSRLS `market_raw_uploader`
-- Postgres role reached by a scoped JWT. That was abandoned for two reasons:
-- minting such a JWT requires the project signing secret (which must not be
-- retrieved or stored), and Supabase Storage honouring a custom `role` claim was
-- never proven. Instead the worker is a DEDICATED SUPABASE AUTH USER using the
-- ordinary `authenticated` role, and every policy below is pinned to its exact
-- auth.uid(). It signs in normally and uses a short-lived (1 h) access token.
--
--   uploader auth.uid() = a994dfda-1723-481f-9bc7-701843b07d45
--
-- Its email/password live ONLY in the sealed secrets bundle
-- (home:.market-raw-uploader.env.local) — never in Git, logs, evidence, prompts
-- or command arguments. THE WORKER NEVER HOLDS service_role.
--
-- OBJECT KEYS are content-addressed: `<source>/<sha256>` where <source> matches
-- the listing_sources slug grammar and <sha256> is 64 lowercase hex characters.
-- The INSERT policy enforces that shape, so a non-content-addressed key cannot
-- be written at all. Combined with upsert=false, an existing hash is a no-op
-- rather than an overwrite.
--
-- WHAT IS DELIBERATELY ABSENT:
--   * No UPDATE policy  -> nobody under RLS can modify an object.
--   * No DELETE policy  -> nobody under RLS can remove one.
--   * No anon or PUBLIC policy of any kind.
--   * No uploader SELECT policy. It is NOT granted on assumption; if the Storage
--     API empirically requires SELECT to return the inserted object, a follow-up
--     migration adds the narrowest possible one, pinned to the same uid+bucket.
--
-- THREAT BOUNDARY — stated honestly.
--   Immutable to: the extraction worker, every ordinary `authenticated` user,
--   and `anon`. Enforced by RLS, not by convention.
--   NOT immutable to: `postgres` and `service_role`, which hold BYPASSRLS and
--   remain infrastructure authorities. That is unavoidable on this platform.
--   The guarantee that matters is that NEITHER credential is available to the
--   extraction worker or any runtime path — the worker authenticates as the
--   dedicated Auth user above and nothing else.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.wassell_is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_is_admin(uuid) is absent — the admin read policy calls it.';
  END IF;
  IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the storage schema is absent.';
  END IF;
END $preflight$;

-- 1. Private bucket. public=false so there is no unauthenticated object URL.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('market-raw', 'market-raw', false, 104857600)   -- 100 MiB ceiling per artifact
ON CONFLICT (id) DO UPDATE
   SET public = false                                    -- never let it drift public
     , file_size_limit = EXCLUDED.file_size_limit;

-- 2. INSERT — the dedicated uploader only, content-addressed keys only.
DROP POLICY IF EXISTS market_raw_uploader_insert ON storage.objects;
CREATE POLICY market_raw_uploader_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
        bucket_id = 'market-raw'
    AND (SELECT auth.uid()) = 'a994dfda-1723-481f-9bc7-701843b07d45'::uuid
    AND name ~ '^[a-z][a-z0-9_]{1,31}/[a-f0-9]{64}$'
  );

-- 3. SELECT — administrators only. Signed-URL creation goes through this.
DROP POLICY IF EXISTS market_raw_admin_read ON storage.objects;
CREATE POLICY market_raw_admin_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
        bucket_id = 'market-raw'
    AND public.wassell_is_admin((SELECT auth.uid()))
  );

-- 4. No UPDATE policy. No DELETE policy. No anon policy. Intentional — see header.

-- ---------------------------------------------------------------------------
-- Assertions: prove the intended policy surface, and prove the absence of the
-- ones that would break immutability.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='market-raw' AND public = false) THEN
    RAISE EXCEPTION 'ASSERT: market-raw bucket missing or public';
  END IF;

  -- Exactly two policies mention this bucket, and they are the two above.
  SELECT count(*) INTO v_n FROM pg_policy
   WHERE polrelid='storage.objects'::regclass
     AND polname IN ('market_raw_uploader_insert','market_raw_admin_read');
  IF v_n <> 2 THEN RAISE EXCEPTION 'ASSERT: expected exactly the 2 market-raw policies, found %', v_n; END IF;

  -- No UPDATE or DELETE policy may reference this bucket.
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid='storage.objects'::regclass
       AND polcmd IN ('w','d')
       AND (coalesce(pg_get_expr(polqual,polrelid),'') LIKE '%market-raw%'
         OR coalesce(pg_get_expr(polwithcheck,polrelid),'') LIKE '%market-raw%')
  ) THEN
    RAISE EXCEPTION 'ASSERT: an UPDATE/DELETE policy references market-raw — immutability broken';
  END IF;

  -- Neither policy may be reachable by anon.
  IF EXISTS (
    SELECT 1 FROM pg_policy p, unnest(p.polroles) r
     WHERE p.polrelid='storage.objects'::regclass
       AND p.polname IN ('market_raw_uploader_insert','market_raw_admin_read')
       AND r::regrole::text IN ('anon','public')
  ) THEN
    RAISE EXCEPTION 'ASSERT: a market-raw policy is reachable by anon/PUBLIC';
  END IF;

  -- The INSERT policy must pin the uploader uid AND the content-addressed shape.
  IF (SELECT coalesce(pg_get_expr(polwithcheck,polrelid),'') FROM pg_policy
       WHERE polrelid='storage.objects'::regclass AND polname='market_raw_uploader_insert')
     NOT LIKE '%a994dfda-1723-481f-9bc7-701843b07d45%' THEN
    RAISE EXCEPTION 'ASSERT: INSERT policy does not pin the uploader uid';
  END IF;
  IF (SELECT coalesce(pg_get_expr(polwithcheck,polrelid),'') FROM pg_policy
       WHERE polrelid='storage.objects'::regclass AND polname='market_raw_uploader_insert')
     NOT LIKE '%a-f0-9%' THEN
    RAISE EXCEPTION 'ASSERT: INSERT policy does not enforce the content-addressed key format';
  END IF;
END $assert$;

COMMIT;
