-- CI fixture: production SHAPES (not bytes) for market_listings.
-- Runnable by psql -v ON_ERROR_STOP=1 on a blank Postgres 17 database as superuser.
-- Idempotent where practical.

-- ---------------------------------------------------------------------------
-- 1. Supabase roles (NOLOGIN stand-ins; created if absent, attribute-pinned
--    either way). Role attributes mirror verified production: service_role has
--    rolbypassrls=true, anon and authenticated have rolbypassrls=false, all
--    three are NOLOGIN. The BYPASSRLS pin on service_role is LOAD-BEARING for
--    the assertions: it is why service_role skips RLS and sees ALL rows while
--    authenticated subjects are row-filtered by the frozen_* / view policies.
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
-- 2. auth schema + auth.uid() reading the request JWT claims GUC.
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
-- 3. models table + the market_listings model row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.models (
  id   uuid PRIMARY KEY,
  name text UNIQUE
);

INSERT INTO public.models (id, name)
VALUES ('8f06bc39-4bee-42e9-9fab-77023fb89ede', 'market_listings')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Fixture-only scope/allowlist tables driving the helper functions below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.test_scope_class (
  auth_uid uuid PRIMARY KEY,
  class    text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.test_allowed_source (
  auth_uid uuid,
  source   text
);

-- ---------------------------------------------------------------------------
-- 5. wassell_view_scope_class — fixture implementation.
--    Mirrors the verified production NULL-caller branch: service_role resolves
--    to 'all' (intended infra bypass), every other NULL caller including anon
--    fails closed to 'none'. current_user cannot be used here because the
--    function is SECURITY DEFINER, so current_user is the owner, not the
--    caller; current_setting('role') reflects the caller's SET ROLE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_view_scope_class(
  auth_user_id uuid,
  the_model_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth_user_id IS NULL THEN
    IF (NULLIF(current_setting('request.jwt.claims', true), ''))::jsonb->>'role' = 'service_role'
       OR current_setting('role', true) = 'service_role' THEN
      RETURN 'all';
    END IF;
    RETURN 'none';
  END IF;
  RETURN coalesce((SELECT class FROM public.test_scope_class WHERE auth_uid = auth_user_id), 'none');
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. wassell_can_view_jsonb — fixture implementation: the record's source
--    must be in the caller's allowlist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_can_view_jsonb(
  auth_user_id uuid,
  the_model_id uuid,
  the_id uuid,
  the_created_by uuid,
  the_data jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.test_allowed_source s
    WHERE s.auth_uid = auth_user_id
      AND s.source = the_data ->> 'source'
  )
$$;

-- ---------------------------------------------------------------------------
-- 7. market_listings table (frozen-model shape) + RLS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_listings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id  uuid,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  source              text,
  external_id         text,
  is_active           boolean DEFAULT true,
  advertiser_phone    text,
  source_payload      jsonb,
  custom_data         jsonb
);

ALTER TABLE public.market_listings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 8. Four policies TO authenticated — mirrors the pre-migration production
--    state: frozen_view/frozen_update/frozen_delete call wassell_can_view_jsonb
--    directly with NO scope-class guard.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS frozen_view   ON public.market_listings;
DROP POLICY IF EXISTS frozen_insert ON public.market_listings;
DROP POLICY IF EXISTS frozen_update ON public.market_listings;
DROP POLICY IF EXISTS frozen_delete ON public.market_listings;

CREATE POLICY frozen_view ON public.market_listings
  FOR SELECT TO authenticated
  USING (
    public.wassell_can_view_jsonb(
      (SELECT auth.uid()),
      '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid,
      id,
      created_by_user_id,
      jsonb_build_object(
        'source', source,
        'is_active', is_active,
        'created_by_user_id', created_by_user_id,
        'external_id', external_id
      )
    )
  );

CREATE POLICY frozen_insert ON public.market_listings
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY frozen_update ON public.market_listings
  FOR UPDATE TO authenticated
  USING (
    public.wassell_can_view_jsonb(
      (SELECT auth.uid()),
      '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid,
      id,
      created_by_user_id,
      jsonb_build_object(
        'source', source,
        'is_active', is_active,
        'created_by_user_id', created_by_user_id,
        'external_id', external_id
      )
    )
  );

CREATE POLICY frozen_delete ON public.market_listings
  FOR DELETE TO authenticated
  USING (
    public.wassell_can_view_jsonb(
      (SELECT auth.uid()),
      '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid,
      id,
      created_by_user_id,
      jsonb_build_object(
        'source', source,
        'is_active', is_active,
        'created_by_user_id', created_by_user_id,
        'external_id', external_id
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 9. market_listings_summary — JSONB-shape view with scope-class fast path.
--    MUST NOT expose source_payload. security_invoker = false (definer view).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.market_listings_summary AS
SELECT
  t.id,
  '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid AS model_id,
  t.created_by_user_id,
  t.created_at,
  t.updated_at,
  jsonb_strip_nulls(
    jsonb_build_object(
      'external_id', t.external_id,
      'source', t.source,
      'is_active', t.is_active,
      'advertiser_phone', t.advertiser_phone
    )
  ) || COALESCE(t.custom_data, '{}'::jsonb) AS data
FROM public.market_listings t
WHERE CASE (
  SELECT public.wassell_view_scope_class(
    (SELECT auth.uid()),
    '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid
  )
)
  WHEN 'all'  THEN true
  WHEN 'none' THEN false
  ELSE public.wassell_can_view_jsonb(
    (SELECT auth.uid()),
    '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid,
    t.id,
    t.created_by_user_id,
    jsonb_build_object(
      'source', t.source,
      'is_active', t.is_active,
      'created_by_user_id', t.created_by_user_id,
      'external_id', t.external_id
    )
  )
END;

ALTER VIEW public.market_listings_summary SET (security_invoker = false);

-- ---------------------------------------------------------------------------
-- 10. v_market_listings — full-data view. reloptions left UNSET (the
--     production default: definer view).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_market_listings AS
SELECT
  id,
  created_by_user_id,
  created_at,
  updated_at,
  source,
  external_id,
  is_active,
  advertiser_phone,
  source_payload,
  custom_data
FROM public.market_listings;

-- ---------------------------------------------------------------------------
-- 11. v_market_properties — same shape, security_invoker = true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_market_properties AS
SELECT
  id,
  created_by_user_id,
  created_at,
  updated_at,
  source,
  external_id,
  is_active,
  advertiser_phone,
  source_payload,
  custom_data
FROM public.market_listings;

ALTER VIEW public.v_market_properties SET (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 12. Grants replicating the pre-migration production state:
--     - nothing for PUBLIC/anon on any view
--     - market_listings_summary: GRANT ALL TO authenticated (the write-path
--       state the migration closes)
--     - the two full-data views: NO authenticated grant
--     - service_role: ALL on all three
--     - the BASE TABLE market_listings: ALL to anon, authenticated AND
--       service_role — this mirrors production. RLS, not the grant, is what
--       gates access: all four frozen_* policies are TO authenticated, so anon
--       holds the grant but matches no permissive policy and reads zero rows.
--       Without this grant, once the migration flips the views to
--       security_invoker=true, callers get 'permission denied for table
--       market_listings'.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.market_listings_summary FROM PUBLIC, anon;
REVOKE ALL ON public.v_market_listings       FROM PUBLIC, anon;
REVOKE ALL ON public.v_market_properties     FROM PUBLIC, anon;

GRANT ALL ON public.market_listings_summary TO authenticated;

GRANT ALL ON public.market_listings_summary TO service_role;
GRANT ALL ON public.v_market_listings       TO service_role;
GRANT ALL ON public.v_market_properties     TO service_role;

GRANT ALL ON public.market_listings TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. Seed 200 rows: 120 'aqar' + 80 'bayut', all active; advertiser_phone
--     on every third row. Idempotent via reseed.
-- ---------------------------------------------------------------------------
DELETE FROM public.market_listings;

INSERT INTO public.market_listings (source, external_id, is_active, advertiser_phone, source_payload, custom_data)
SELECT
  'aqar',
  'aqar-' || g,
  true,
  CASE WHEN g % 3 = 0 THEN '9665' || lpad((50000000 + g)::text, 8, '0') ELSE NULL END,
  jsonb_build_object('listing', 'aqar-' || g, 'price', 100000 + g * 1000),
  NULL
FROM generate_series(1, 120) AS g;

INSERT INTO public.market_listings (source, external_id, is_active, advertiser_phone, source_payload, custom_data)
SELECT
  'bayut',
  'bayut-' || g,
  true,
  CASE WHEN g % 3 = 0 THEN '9665' || lpad((60000000 + g)::text, 8, '0') ELSE NULL END,
  jsonb_build_object('listing', 'bayut-' || g, 'price', 200000 + g * 1000),
  NULL
FROM generate_series(1, 80) AS g;

-- ---------------------------------------------------------------------------
-- 14. Seed subjects: 'all', 'filtered' (bayut only), 'none'.
-- ---------------------------------------------------------------------------
INSERT INTO public.test_scope_class (auth_uid, class)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'all'),
  ('22222222-2222-2222-2222-222222222222', 'filtered'),
  ('33333333-3333-3333-3333-333333333333', 'none')
ON CONFLICT (auth_uid) DO UPDATE SET class = EXCLUDED.class;

DELETE FROM public.test_allowed_source;

INSERT INTO public.test_allowed_source (auth_uid, source)
VALUES ('22222222-2222-2222-2222-222222222222', 'bayut');
