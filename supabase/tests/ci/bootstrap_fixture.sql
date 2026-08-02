-- CI ephemeral-DB bootstrap (bilingual W1): minimal stand-ins for the
-- pre-existing production objects the 2026-09-01_* migrations reference.
-- This is a FIXTURE for a blank postgres:17 container — never run anywhere else.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Supabase roles the migrations GRANT/REVOKE against.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

-- auth.uid() stub (JWT GUC-driven so tests can impersonate).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Core tables the migrations touch.
CREATE TABLE public.models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  schema jsonb NOT NULL DEFAULT '{"sections":[]}'::jsonb,
  is_hardcoded boolean NOT NULL DEFAULT false
);
CREATE TABLE public.records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE VIEW public.unified_records AS
  SELECT id, model_id, data, created_by_user_id, created_at, updated_at FROM public.records;

CREATE TABLE public.wassel_documents (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_json jsonb, content_html text
);

-- Legacy cache (seed-import source).
CREATE TABLE public.value_translations (
  source_hash text NOT NULL,
  target_lang text NOT NULL,
  source_text text NOT NULL,
  translated_text text NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  provider text, model_hint text, field_hint text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (target_lang, source_hash)
);

-- Workflow capture dependencies (the re-emitted fn in mig 03 references them).
CREATE TABLE public.workflow_capture_models (
  model_id uuid PRIMARY KEY, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE public.workflow_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid, record_id uuid, trigger_event text,
  previous_data jsonb, new_data jsonb, changed_fields text[],
  actor_user_id uuid, depth int DEFAULT 0, parent_job_id uuid, origin_run_id uuid,
  idempotency_key text, status text DEFAULT 'pending', skip_reason text,
  created_at timestamptz DEFAULT now()
);

-- ACL stubs mirroring the production signatures (GUC-driven so authz tests
-- can flip capabilities per session).
CREATE OR REPLACE FUNCTION public.wassell_is_admin(auth_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('test.is_admin', true), 'false')::boolean
         AND auth_user_id IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION public.wassell_user_has_action(auth_user_id uuid, the_model uuid, the_action text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth_user_id IS NOT NULL AND
         (COALESCE(current_setting('test.actions', true), '') LIKE '%' || the_action || '%');
$$;
CREATE OR REPLACE FUNCTION public.wassell_can_edit_jsonb(
  auth_user_id uuid, the_model_id uuid, the_id uuid, the_created_by uuid, the_data jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth_user_id IS NOT NULL AND
         COALESCE(current_setting('test.can_edit', true), 'false')::boolean;
$$;
