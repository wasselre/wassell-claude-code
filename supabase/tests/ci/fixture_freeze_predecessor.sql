-- ============================================================================
-- CI fixture: the SUPPORTED PRE-FREEZE PREDECESSOR state.
--
-- This is the database as it stands BEFORE 2026-09-03_02_market_listings_
-- freeze_baseline.sql: the frozen geography models already exist (cities,
-- districts, regions) and unified_records is the THREE-way union over them.
-- market_listings is NOT yet frozen and public.market_listings does NOT exist.
--
-- It deliberately reproduces two SECURITY DEFINER function bodies BYTE-EXACTLY,
-- because 2026-09-04_00 pins their pg_get_functiondef md5s:
--   wassell_view_scope_class  -> 0bcfabe9df9da91ea4d874104fec65d6   (LF body)
--   wassell_can_view_jsonb    -> c9a781616085d3b06eec12d68238b502   (CRLF body)
--
-- THE CRLF TRAP: wassell_can_view_jsonb's stored body uses \r\n. .gitattributes
-- normalizes this file to LF, so the CRs cannot be written literally — the body
-- is assembled with LF and converted at execution time. Do NOT apply the same
-- conversion to wassell_view_scope_class: its body is genuinely LF and would
-- then miss its own pin.
--
-- Runnable by psql -v ON_ERROR_STOP=1 on a blank Postgres 17 as superuser.
-- ============================================================================

SET check_function_bodies = off;

-- 1. Supabase-managed platform roles ----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOBYPASSRLS; ELSE ALTER ROLE anon NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOBYPASSRLS; ELSE ALTER ROLE authenticated NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; ELSE ALTER ROLE service_role BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;

-- 2. Core tables the authorization functions close over ----------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  is_admin boolean NOT NULL DEFAULT false,
  model_permissions jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid uuid,
  profile_id uuid REFERENCES public.profiles(id),
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  schema jsonb NOT NULL DEFAULT '{"sections":[]}'::jsonb,
  is_hardcoded boolean NOT NULL DEFAULT false,
  table_name text
);
CREATE TABLE IF NOT EXISTS public.records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

-- 3. Safe-cast helpers (v_market_properties uses both) -----------------------
CREATE OR REPLACE FUNCTION public.try_numeric(t text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN t::numeric; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION public.try_boolean(t text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN t::boolean; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;

-- 4. Authorization surface ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.test_admin (user_id uuid PRIMARY KEY);

CREATE OR REPLACE FUNCTION public.wassell_is_admin(auth_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT EXISTS (SELECT 1 FROM public.test_admin WHERE user_id = $1) $$;

CREATE OR REPLACE FUNCTION public.wassell_user_has_action(auth_user_id uuid, the_model_id uuid, the_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT public.wassell_is_admin(auth_user_id) $$;

CREATE OR REPLACE FUNCTION public.wassell_record_passes_scope(rec public.records, auth_user_id uuid, the_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT public.wassell_is_admin(auth_user_id) $$;

CREATE OR REPLACE FUNCTION public.wassell_can_edit_jsonb(auth_user_id uuid, the_model_id uuid, the_id uuid, the_created_by uuid, the_data jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT public.wassell_is_admin(auth_user_id) $$;

-- 4.1 wassell_view_scope_class — BYTE-EXACT, LF body, pinned 0bcfabe9…
CREATE OR REPLACE FUNCTION public.wassell_view_scope_class(auth_user_id uuid, the_model_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  prof profiles%ROWTYPE;
  model_perm jsonb;
  rule jsonb;
BEGIN
  IF auth_user_id IS NULL THEN
    IF (NULLIF(current_setting('request.jwt.claims', true), ''))::jsonb->>'role' = 'service_role'
       OR current_setting('role', true) = 'service_role' THEN
      RETURN 'all';
    END IF;
    RETURN 'none';
  END IF;
  SELECT p.* INTO prof FROM profiles p
    JOIN users u ON u.profile_id = p.id
   WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF prof.is_admin THEN RETURN 'all'; END IF;
  SELECT mp INTO model_perm FROM jsonb_array_elements(prof.model_permissions) mp
    WHERE (mp->>'model_id')::uuid = the_model_id LIMIT 1;
  IF model_perm IS NULL THEN RETURN 'none'; END IF;
  IF NOT ((model_perm->'permissions') @> to_jsonb('view'::text)) THEN RETURN 'none'; END IF;
  rule := model_perm -> 'view_scope';
  IF rule IS NULL THEN RETURN 'all'; END IF;
  IF rule->>'mode' = 'all' THEN RETURN 'all'; END IF;
  IF rule->>'mode' <> 'filtered' THEN RETURN 'all'; END IF;
  IF jsonb_array_length(COALESCE(rule->'conditions', '[]'::jsonb)) = 0 THEN RETURN 'all'; END IF;
  RETURN 'filtered';
END $function$;

-- 4.2 wassell_can_view_jsonb — CRLF body, reassembled at execution time so the
--     LF-normalized repo file can still land the pinned c9a78161… functiondef.
DO $crlf$
DECLARE
  v_body_lf text := E'\n'
    || '  SELECT public.wassell_user_has_action(auth_user_id, the_model_id, ''view'')' || E'\n'
    || '    AND public.wassell_record_passes_scope(' || E'\n'
    || '          jsonb_populate_record(NULL::records, jsonb_build_object(' || E'\n'
    || '            ''id'',                 the_id,' || E'\n'
    || '            ''model_id'',           the_model_id,' || E'\n'
    || '            ''data'',               the_data,' || E'\n'
    || '            ''created_by_user_id'', the_created_by' || E'\n'
    || '          )),' || E'\n'
    || '          auth_user_id, ''view''' || E'\n'
    || '        );' || E'\n';
  v_body_crlf text := replace(v_body_lf, E'\n', E'\r\n');
BEGIN
  EXECUTE
    'CREATE OR REPLACE FUNCTION public.wassell_can_view_jsonb(auth_user_id uuid, the_model_id uuid, the_id uuid, the_created_by uuid, the_data jsonb)'
    || E'\n RETURNS boolean\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO ''public'', ''pg_temp''\nAS $function$'
    || v_body_crlf || '$function$';
END $crlf$;

-- 5. The frozen GEOGRAPHY models that already exist pre-freeze ---------------
--    Their internals do not affect unified_records' fingerprint (it references
--    them by name), but they must be real relations exposing the seven columns.
DO $geo$
DECLARE g text; v_id uuid;
BEGIN
  FOREACH g IN ARRAY ARRAY['cities','districts','regions'] LOOP
    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS public.%I (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text,
        custom_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1)$f$, g);
    INSERT INTO public.models (name, is_hardcoded, table_name)
    VALUES (g, true, g) ON CONFLICT (name) DO UPDATE SET is_hardcoded = true, table_name = EXCLUDED.table_name;
    SELECT id INTO v_id FROM public.models WHERE name = g;
    EXECUTE format($f$
      CREATE OR REPLACE VIEW public.%I AS
        SELECT id, %L::uuid AS model_id,
               (jsonb_strip_nulls(jsonb_build_object('name', name)) || COALESCE(custom_data,'{}'::jsonb)) AS data,
               created_by_user_id, created_at, updated_at, version
          FROM public.%I$f$, g || '_v', v_id, g);
  END LOOP;
END $geo$;

-- 6. market_listings model row — present but NOT yet frozen ------------------
INSERT INTO public.models (id, name, is_hardcoded, table_name)
VALUES ('8f06bc39-4bee-42e9-9fab-77023fb89ede', 'market_listings', false, NULL)
ON CONFLICT (id) DO NOTHING;

-- 7. The THREE-way pre-freeze union + its dependents -------------------------
CREATE OR REPLACE VIEW public.unified_records AS
 SELECT records.id, records.model_id, records.data, records.created_by_user_id,
        records.created_at, records.updated_at, records.version FROM records
UNION ALL
 SELECT cities_v.id, cities_v.model_id, cities_v.data, cities_v.created_by_user_id,
        cities_v.created_at, cities_v.updated_at, cities_v.version FROM cities_v
UNION ALL
 SELECT districts_v.id, districts_v.model_id, districts_v.data, districts_v.created_by_user_id,
        districts_v.created_at, districts_v.updated_at, districts_v.version FROM districts_v
UNION ALL
 SELECT regions_v.id, regions_v.model_id, regions_v.data, regions_v.created_by_user_id,
        regions_v.created_at, regions_v.updated_at, regions_v.version FROM regions_v;
ALTER VIEW public.unified_records SET (security_invoker = true);

-- Dependents of unified_records, so the baseline's view-chain unwind is
-- genuinely exercised. v_our_projects_scope is deliberately NOT
-- security_invoker (it matches production's definer posture) — the baseline
-- must preserve that across the drop/recreate.
CREATE OR REPLACE VIEW public.v_our_projects_scope AS
  SELECT id, model_id, data FROM public.unified_records WHERE data ? 'is_public';
CREATE OR REPLACE VIEW public.v_website_public AS
  SELECT id, model_id, data FROM public.unified_records WHERE COALESCE(try_boolean(data->>'is_public'), false);
ALTER VIEW public.v_website_public SET (security_invoker = true);
REVOKE ALL ON public.v_our_projects_scope FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_website_public TO anon;

-- 8. aqar_listing_evidence — genuine predecessor for 2026-09-05_02 -----------
--    Shape copied from supabase/branch-bootstrap-02.sql:1338.
CREATE TABLE IF NOT EXISTS public.aqar_listing_evidence (
  listing_id text NOT NULL,
  url text NOT NULL,
  bundle text NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqar_listing_evidence_pkey PRIMARY KEY (listing_id)
);
INSERT INTO public.aqar_listing_evidence (listing_id, url, bundle)
VALUES ('fixture-evidence-1', 'https://example.invalid/1', '{}')
ON CONFLICT (listing_id) DO NOTHING;

-- 9. Identities: admin 1111…, non-admin 2222… (absent from test_admin) -------
INSERT INTO public.test_admin (user_id) VALUES ('11111111-1111-1111-1111-111111111111')
ON CONFLICT (user_id) DO NOTHING;

-- 10. Prove the two pinned function bodies reproduced exactly -----------------
DO $verify$
DECLARE v text;
BEGIN
  v := md5(pg_get_functiondef(to_regprocedure('public.wassell_view_scope_class(uuid,uuid)')));
  IF v <> '0bcfabe9df9da91ea4d874104fec65d6' THEN
    RAISE EXCEPTION 'FIXTURE: wassell_view_scope_class functiondef md5 % <> 0bcfabe9df9da91ea4d874104fec65d6', v;
  END IF;
  v := md5(pg_get_functiondef(to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)')));
  IF v <> 'c9a781616085d3b06eec12d68238b502' THEN
    RAISE EXCEPTION 'FIXTURE: wassell_can_view_jsonb functiondef md5 % <> c9a781616085d3b06eec12d68238b502 (CRLF reassembly wrong)', v;
  END IF;
END $verify$;
