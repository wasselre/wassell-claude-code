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
  content_json jsonb, content_html text, settings jsonb
);

-- W4 server-language carriers (stand-ins for the 2026-06/07 production tables
-- the 2026-09-02 migration ALTERs; FKs dropped — irrelevant to what CI checks).
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid uuid, is_active boolean NOT NULL DEFAULT true,
  role_assignments jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL, model_id uuid NOT NULL,
  label_ar text NOT NULL DEFAULT '', label_en text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.document_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL,
  source_model_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_file_id uuid NOT NULL,
  target_folder_id uuid,
  owner_user_id uuid NOT NULL,
  owner_auth_uid uuid NOT NULL,
  client_record_id uuid, unit_record_id uuid, project_record_id uuid,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed')),
  attempts int NOT NULL DEFAULT 0,
  worker_id text, error text, result_file_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX document_jobs_one_active_idx
  ON public.document_jobs (source_record_id, template_id)
  WHERE status IN ('queued','running');
CREATE TABLE public.scheduled_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '', owner_auth_uid uuid,
  frequency text NOT NULL DEFAULT 'daily',
  hour_of_day int NOT NULL DEFAULT 8,
  day_of_week int, day_of_month int,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_type text NOT NULL DEFAULT 'custom',
  dashboard_id uuid, widget_id text, metric_id uuid, query jsonb,
  status text NOT NULL DEFAULT 'active'
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
