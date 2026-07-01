-- ============================================================
-- Wassell CRM — Supabase Schema
-- ============================================================
-- Run this in the Supabase SQL Editor on every new project, and re-run it
-- after any schema change. Every statement below is IDEMPOTENT: re-running
-- is safe and never destroys data.
--
-- v1 release scope (staff-only launch):
--   • Tables for every entity the app persists (models, records, workflows,
--     dashboards, users, profiles, roles, views, workflow_runs, field_templates).
--   • RLS enabled on everything, with two simple policies:
--       - `authenticated` users get full access (shared CRM for the team).
--       - `anon` users can read a dashboard row ONLY if is_public = true.
--   • Supabase Auth email provider handles sign-in. First-ever sign-in adopts
--     the seeded admin row so the admin has a working profile immediately.
--
-- v2 (out of scope for now — planned when external clients are onboarded):
--   • Add `owner_user_id` columns where needed.
--   • Split RLS into role-scoped policies (admin/staff = full, client = own-row).
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS model_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  "order" INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'database',
  color TEXT NOT NULL DEFAULT '#B8734F',
  schema JSONB NOT NULL DEFAULT '{"sections":[]}'::jsonb,
  card_config JSONB NOT NULL DEFAULT '{"title_field_id":null,"shown_field_ids":[]}'::jsonb,
  maps_config JSONB NOT NULL DEFAULT '{"location_url_field_id":null,"manual_lat_field_id":null,"manual_lng_field_id":null,"pin_color_field_id":null,"pin_label_field_id":null,"click_action":"popup","popup_title_field_id":null,"popup_subtitle_field_id":null,"popup_badge_field_id":null,"popup_shown_field_ids":[],"map_style_json":null,"default_center_lat":null,"default_center_lng":null,"default_zoom":null}'::jsonb,
  group_id UUID REFERENCES model_groups(id) ON DELETE SET NULL,
  "order" INT NOT NULL DEFAULT 0,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Set on first save when a user is signed in; null for legacy rows + records
  -- created without an active session. Read by per-profile view/edit scopes that
  -- reference the synthetic `created_by` target. Nullable + ON DELETE SET NULL
  -- so deleting a user does not cascade-delete every record they ever touched
  -- (the records belong to the workspace, not the user).
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing installs: backfill the column. The FK is intentionally added in
-- the same statement so re-running this script is idempotent. Old rows
-- stay null and are treated as "no known creator" by scope filters.
ALTER TABLE records
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Folders for organizing workflows in the editor list. Mirrors model_groups.
CREATE TABLE IF NOT EXISTS workflow_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  "order" INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  -- Nullable: webhook-triggered workflows have no single source model.
  -- Record-triggered workflows (create/update/delete) still need a model set,
  -- but that's enforced in the app, not at the DB level.
  trigger_model_id UUID REFERENCES models(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN ('create', 'update', 'delete', 'webhook')),
  -- Folder this workflow belongs to (null = ungrouped). Group delete
  -- nulls this out so workflows survive folder removal.
  group_id UUID REFERENCES workflow_groups(id) ON DELETE SET NULL,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For existing installs: backfill the workflow_groups table + group_id
-- column on workflows. Both are idempotent.
ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES workflow_groups(id) ON DELETE SET NULL;

-- For existing installs: relax trigger_model_id to allow webhook-triggered
-- workflows (no model) and widen the trigger_event CHECK to accept 'webhook'.
-- Both idempotent.
ALTER TABLE workflows ALTER COLUMN trigger_model_id DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'workflows' AND constraint_name = 'workflows_trigger_event_check'
  ) THEN
    ALTER TABLE workflows DROP CONSTRAINT workflows_trigger_event_check;
  END IF;
  ALTER TABLE workflows ADD CONSTRAINT workflows_trigger_event_check
    CHECK (trigger_event IN ('create', 'update', 'delete', 'webhook'));
END $$;

-- Workflow execution log — audit trail of every workflow run.
-- The row snapshot keeps the entry readable even if the workflow is later edited.
-- Columns mirror the `WorkflowRun` type in src/types/index.ts. The branched
-- engine added conditions_trace / actions_trace / branches_trace etc; keeping
-- them in sync with the type is load-bearing because supabaseUpsert sends all
-- keys verbatim — any missing column makes the whole insert fail silently.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL,
  workflow_label_ar TEXT NOT NULL,
  workflow_label_en TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  trigger_model_id UUID,
  trigger_model_label_ar TEXT,
  trigger_model_label_en TEXT,
  trigger_record_id TEXT,
  trigger_record_snapshot JSONB,
  previous_record_snapshot JSONB,
  triggered_by_user_id UUID,
  depth INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  status TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  conditions_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions_passed BOOLEAN NOT NULL DEFAULT true,
  actions_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  branches_trace JSONB,
  selected_branch_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For existing installs: bring the old workflow_runs table up to the branched-
-- engine shape. Writes on stale schemas fail silently (unknown columns), which
-- leaves the logs page showing 0 even though the engine is firing runs.
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS previous_record_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS triggered_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_ms INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conditions_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS conditions_passed BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS actions_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS branches_trace JSONB,
  ADD COLUMN IF NOT EXISTS selected_branch_id TEXT,
  ADD COLUMN IF NOT EXISTS error TEXT;

-- Rename the legacy error_message column into `error` (matching the TS type).
-- Idempotent: only runs when the old column still exists AND the new one is
-- empty / freshly-added, and carries any existing data across before the
-- redundant column is dropped further below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workflow_runs' AND column_name = 'error_message'
  ) THEN
    UPDATE workflow_runs SET error = COALESCE(error, error_message) WHERE error_message IS NOT NULL;
    ALTER TABLE workflow_runs DROP COLUMN error_message;
  END IF;
END $$;

-- The pre-branch engine wrote a single `actions` JSONB; the new engine splits
-- it into actions_trace / branches_trace. Drop the dead column so upserts that
-- don't include it don't carry stale data forward. Safe no-op on fresh installs.
ALTER TABLE workflow_runs DROP COLUMN IF EXISTS actions;

CREATE TABLE IF NOT EXISTS dashboards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  description TEXT,
  widgets JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Dashboard-level global filter controls (Phase A analytics builder). The SPA
  -- writes the whole Dashboard object via saveDashboard, so these columns must
  -- exist or the upsert fails. See docs/prd/dashboards.md.
  filters JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Owner whose RLS scope public snapshots are computed with (reserved; snapshots
  -- are currently computed with the refreshing user's scope).
  owner_user_id UUID,
  is_public BOOLEAN NOT NULL DEFAULT false,
  public_token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Semantic metrics — named, reusable measures stored as a value-only
-- AnalyticsQuery. Admin-RLS + updated_at trigger, mirroring dashboards. See
-- supabase/migrations/2026-06-16_metric_definitions.sql + docs/prd/dashboards.md.
CREATE TABLE IF NOT EXISTS metric_definitions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar      TEXT NOT NULL,
  label_en      TEXT NOT NULL,
  description   TEXT,
  query         JSONB NOT NULL DEFAULT '{}'::jsonb,
  formula       TEXT,
  inputs        JSONB,
  format        JSONB,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  owner_user_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved table views (per-model, per-user, optionally shared)
CREATE TABLE IF NOT EXISTS model_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  field_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_field_id TEXT,
  sort_direction TEXT CHECK (sort_direction IN ('asc', 'desc')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Research-comparison scoping: when the view targets a `section_mirror` container
  -- with a multi-select sibling, project_ids picks the rows (target record ids) and
  -- research_container_field_id pins the view to one container. Null/unused otherwise.
  project_ids JSONB DEFAULT NULL,
  research_container_field_id TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For existing installs, add the new columns idempotently.
ALTER TABLE model_views
  ADD COLUMN IF NOT EXISTS project_ids JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS research_container_field_id TEXT DEFAULT NULL;

-- maps_config: JSONB column added for the Maps view (third view type alongside
-- Table and Cards). Default object matches MAPS_CONFIG_DEFAULT in src/types/index.ts.
-- "order": integer column for sidebar ordering. Was added to the CREATE TABLE
-- block above but never to an ALTER for existing installs — without this line,
-- re-running schema.sql against an older DB leaves the column missing and every
-- model save errors out. Mirrors the maps_config pattern.
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS maps_config JSONB NOT NULL DEFAULT '{"location_url_field_id":null,"manual_lat_field_id":null,"manual_lng_field_id":null,"pin_color_field_id":null,"pin_label_field_id":null,"click_action":"popup","popup_title_field_id":null,"popup_subtitle_field_id":null,"popup_badge_field_id":null,"popup_shown_field_ids":[],"map_style_json":null,"default_center_lat":null,"default_center_lng":null,"default_zoom":null}'::jsonb,
  ADD COLUMN IF NOT EXISTS "order" INT NOT NULL DEFAULT 0;

-- Users / profiles / roles — the app's own role-and-permission model. These
-- live alongside Supabase Auth's built-in `auth.users`; the app matches them
-- by email (see store's `bindAuth` flow).
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  model_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  -- Deny-lists for per-profile saved-view + custom-button visibility. Default
  -- empty so existing profiles (and freshly-created ones) see everything until
  -- an admin explicitly hides entries. See docs/prd/access-control.md.
  hidden_view_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  hidden_button_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Per-profile access to the custom (non-model) Sales Operations pages
  -- (Sales Tasks / Sales Process / Sales Manager — see src/lib/customPages.ts).
  -- Map of { "<page_id>": true|false } where an explicit value overrides the
  -- page's default_access; a page id absent from the map falls back to that
  -- default, so existing profiles keep prior behavior. Default '{}' = no
  -- overrides. See docs/prd/access-control.md.
  page_access JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Read-only access to the workflow subsystem (workflows / workflow_groups /
  -- workflow_runs). Default false = non-admins load no workflow rows (the
  -- hardened default). When true the profile can SEE workflows (Sales Process
  -- Studio shows linked workflows; run-history pages viewable). Editing stays
  -- admin-only. Enforced at the DB via wassell_can_view_workflows. See
  -- docs/prd/access-control.md.
  can_view_workflows BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing installs: idempotent backfill so the saveProfile path doesn't fail
-- with "Could not find the column in schema cache" on workspaces that
-- predate the view/button/page-permission rollout.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS hidden_view_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hidden_button_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS page_access JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS can_view_workflows BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  schema JSONB NOT NULL DEFAULT '{"sections":[]}'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  -- Foreign key into Supabase Auth's `auth.users.id`. Set on first sign-in
  -- via the email-binding shim in `appStore.initialize()`. Nullable + UNIQUE
  -- so legacy rows don't fail the NOT NULL check; once bound, every RLS
  -- policy keys off this column instead of doing a JSONB walk per query.
  auth_uid UUID UNIQUE,
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  role_assignments JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing installs: idempotent backfill so the auth-binding upgrade path
-- doesn't fail on workspaces that predate the RLS migration.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_uid UUID;
DO $$ BEGIN
  -- Add the unique constraint separately so it's safe to re-run; CREATE
  -- UNIQUE INDEX IF NOT EXISTS is the idempotent equivalent of UNIQUE
  -- constraints in idempotent scripts.
  CREATE UNIQUE INDEX IF NOT EXISTS users_auth_uid_key ON users(auth_uid);
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Field templates — user-saved reusable field snapshots from the Builder.
CREATE TABLE IF NOT EXISTS field_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  field JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_records_model_id ON records(model_id);
CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
CREATE INDEX IF NOT EXISTS idx_dashboards_public_token ON dashboards(public_token);
CREATE INDEX IF NOT EXISTS idx_model_views_model_id ON model_views(model_id);
CREATE INDEX IF NOT EXISTS idx_model_views_user_id ON model_views(user_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
-- At most one default view per (model, user)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_model_views_default
  ON model_views(model_id, user_id) WHERE is_default = true;

-- ── Phase A.2 (2026-05-06): covering indexes for unindexed FKs ────
-- Without these, parent-row DELETE/UPDATE forces a full sequential
-- scan of the child table to verify orphans. Trivially fast at
-- current scale; essential at any meaningful row count.
CREATE INDEX IF NOT EXISTS idx_competitors_created_by              ON public.competitors(created_by);
CREATE INDEX IF NOT EXISTS idx_marketing_operations_created_by_user_id ON public.marketing_operations(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_models_group_id                     ON public.models(group_id);
CREATE INDEX IF NOT EXISTS idx_records_created_by_user_id          ON public.records(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_research_questions_answered_by      ON public.research_questions(answered_by);
CREATE INDEX IF NOT EXISTS idx_users_profile_id                    ON public.users(profile_id);
CREATE INDEX IF NOT EXISTS idx_webhook_payloads_consumed_by        ON public.webhook_payloads(consumed_by);
CREATE INDEX IF NOT EXISTS idx_webhook_payloads_slug_id            ON public.webhook_payloads(slug_id);
CREATE INDEX IF NOT EXISTS idx_webhook_slugs_created_by            ON public.webhook_slugs(created_by);
CREATE INDEX IF NOT EXISTS idx_workflows_group_id                  ON public.workflows(group_id);
CREATE INDEX IF NOT EXISTS idx_workflows_trigger_model_id          ON public.workflows(trigger_model_id);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers — drop + recreate so re-running the script doesn't error.
DROP TRIGGER IF EXISTS set_updated_at_models ON models;
CREATE TRIGGER set_updated_at_models BEFORE UPDATE ON models
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_records ON records;
CREATE TRIGGER set_updated_at_records BEFORE UPDATE ON records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_workflows ON workflows;
CREATE TRIGGER set_updated_at_workflows BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_dashboards ON dashboards;
CREATE TRIGGER set_updated_at_dashboards BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_metric_definitions ON metric_definitions;
CREATE TRIGGER set_updated_at_metric_definitions BEFORE UPDATE ON metric_definitions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_model_views ON model_views;
CREATE TRIGGER set_updated_at_model_views BEFORE UPDATE ON model_views
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_users ON users;
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_profiles ON profiles;
CREATE TRIGGER set_updated_at_profiles BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_roles ON roles;
CREATE TRIGGER set_updated_at_roles BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_field_templates ON field_templates;
CREATE TRIGGER set_updated_at_field_templates BEFORE UPDATE ON field_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
-- v2 policy: real per-profile enforcement.
--
-- Records are gated per-row by `wassell_can_*_record(auth.uid(), record)`,
-- which composes the model-level action perm (view/create/edit/delete)
-- with the active profile's view_scope and edit_scope. Admin profiles
-- (`is_admin: true`) bypass automatically because every helper short-
-- circuits when the resolved profile is admin. The same condition
-- shape is evaluated identically in JS (src/lib/scopeFilters.ts) and
-- SQL (wassell_record_passes_scope) so behaviour is consistent
-- regardless of which path serves the data.
--
-- Read-side surfaces (sidebar, user pickers, role badges) need
-- broader read access on `models`, `users`, `profiles`, `roles`,
-- `model_groups`, `field_templates` so the UI can render — these
-- stay readable by every authenticated user, but writes are admin
-- only. The builder-area tables (workflows*, dashboards) are admin
-- only end-to-end since non-admins have no UI for them.
--
-- The helper functions and policies below are also installed via
-- supabase MCP migrations (rls_real_enforcement_v1 and
-- replace_using_true_with_real_policies). Keeping them in this
-- script too so a fresh `psql -f schema.sql` produces the same DB.
-- Public dashboards keep the existing anon-SELECT policy.
--
-- Policies are dropped and recreated so re-running is safe.
-- ============================================================

ALTER TABLE models          ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_groups    ENABLE ROW LEVEL SECURITY;
ALTER TABLE records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_views     ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_templates ENABLE ROW LEVEL SECURITY;

-- Drop-then-create keeps re-runs idempotent.
DROP POLICY IF EXISTS "Authenticated full access" ON models;
DROP POLICY IF EXISTS "Authenticated full access" ON model_groups;
DROP POLICY IF EXISTS "Authenticated full access" ON records;
DROP POLICY IF EXISTS "Authenticated full access" ON workflows;
DROP POLICY IF EXISTS "Authenticated full access" ON workflow_groups;
DROP POLICY IF EXISTS "Authenticated full access" ON workflow_runs;
DROP POLICY IF EXISTS "Authenticated full access" ON dashboards;
DROP POLICY IF EXISTS "Authenticated full access" ON model_views;
DROP POLICY IF EXISTS "Authenticated full access" ON users;
DROP POLICY IF EXISTS "Authenticated full access" ON profiles;
DROP POLICY IF EXISTS "Authenticated full access" ON roles;
DROP POLICY IF EXISTS "Authenticated full access" ON field_templates;
DROP POLICY IF EXISTS "Public dashboard read" ON dashboards;

-- ── Helper functions (also installed via the rls_real_enforcement_v1
-- migration). Pasted here so a fresh `psql -f schema.sql` against an
-- empty DB produces an identical setup. Functions are SECURITY DEFINER
-- so they read profiles/users from inside an RLS-restricted session.

-- bind_my_auth_uid — closes the chicken-and-egg in the user-binding
-- flow. Every newly-invited user has users.auth_uid = NULL until first
-- sign-in. The client cannot UPDATE its own auth_uid because the
-- users_write policy (USING wassell_is_admin OR users.auth_uid =
-- auth.uid()) evaluates the OLD row's NULL — both legs fail and the
-- UPDATE is silently filtered to zero rows. SECURITY DEFINER bypasses
-- that check by running as the function owner. Guards: caller must
-- have a session + email claim; we only fill NULL slots (never
-- overwrite an existing binding, which would allow account hijack via
-- a recycled email); target row must be active. Idempotent — a re-bind
-- of an already-bound caller returns the existing id without writing.
-- Mirrored from supabase/migrations/2026-05-24_bind_my_auth_uid.sql.
CREATE OR REPLACE FUNCTION public.bind_my_auth_uid()
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  caller_uid uuid := auth.uid();
  caller_email text := lower(coalesce((auth.jwt() ->> 'email'), ''));
  bound_user_id uuid;
BEGIN
  IF caller_uid IS NULL THEN
    RAISE EXCEPTION 'no_session' USING ERRCODE = '28000';
  END IF;
  IF caller_email = '' THEN
    RAISE EXCEPTION 'no_email_claim' USING ERRCODE = '28000';
  END IF;

  SELECT id INTO bound_user_id FROM public.users
   WHERE auth_uid = caller_uid AND is_active = true LIMIT 1;
  IF bound_user_id IS NOT NULL THEN RETURN bound_user_id; END IF;

  UPDATE public.users
     SET auth_uid = caller_uid, updated_at = now()
   WHERE auth_uid IS NULL
     AND lower(email) = caller_email
     AND is_active = true
   RETURNING id INTO bound_user_id;

  RETURN bound_user_id;
END $$;
REVOKE ALL ON FUNCTION public.bind_my_auth_uid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_my_auth_uid() FROM anon;
GRANT  EXECUTE ON FUNCTION public.bind_my_auth_uid() TO authenticated;

CREATE OR REPLACE FUNCTION wassell_app_user_id(auth_user_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM users WHERE auth_uid = auth_user_id AND is_active = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION wassell_is_admin(auth_user_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT p.is_admin FROM profiles p
      JOIN users u ON u.profile_id = p.id
     WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1
  ), false);
$$;

-- True when the user may READ the workflow subsystem (workflows /
-- workflow_groups / workflow_runs). Admins always can; non-admins only when
-- their profile has `can_view_workflows = true`. Editing stays admin-only —
-- this gates SELECT, not writes. Mirrors wassell_is_admin's shape.
CREATE OR REPLACE FUNCTION wassell_can_view_workflows(auth_user_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT p.is_admin OR COALESCE(p.can_view_workflows, false) FROM profiles p
      JOIN users u ON u.profile_id = p.id
     WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1
  ), false);
$$;

CREATE OR REPLACE FUNCTION wassell_user_has_action(
  auth_user_id UUID, the_model_id UUID, action TEXT
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prof profiles%ROWTYPE;
  model_perm jsonb;
BEGIN
  IF auth_user_id IS NULL THEN RETURN false; END IF;
  SELECT p.* INTO prof FROM profiles p
    JOIN users u ON u.profile_id = p.id
   WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  IF prof.is_admin THEN RETURN true; END IF;
  SELECT mp INTO model_perm FROM jsonb_array_elements(prof.model_permissions) mp
    WHERE (mp->>'model_id')::uuid = the_model_id LIMIT 1;
  IF model_perm IS NULL THEN RETURN false; END IF;
  RETURN (model_perm->'permissions') @> to_jsonb(action);
END $$;

-- Walks the active profile's view_/edit_scope conditions for a record.
-- Mirrors the JS evaluator in src/lib/scopeFilters.ts; behaviour is
-- intentionally identical so the app and the DB agree.
CREATE OR REPLACE FUNCTION wassell_record_passes_scope(
  rec records, auth_user_id UUID, scope_kind TEXT
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prof profiles%ROWTYPE;
  app_uid UUID;
  user_assignments jsonb;
  user_assignment jsonb;
  model_perm jsonb;
  rule jsonb;
  cond jsonb;
  field_kind TEXT;
  field_slug TEXT;
  rec_value jsonb;
  rec_value_text TEXT;
  source_kind TEXT;
  rhs_text TEXT;
  operator TEXT;
  pass boolean;
BEGIN
  IF auth_user_id IS NULL THEN RETURN false; END IF;
  SELECT u.id, u.role_assignments INTO app_uid, user_assignments
    FROM users u WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT p.* INTO prof FROM profiles p
    JOIN users u ON u.profile_id = p.id WHERE u.id = app_uid LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  IF prof.is_admin THEN RETURN true; END IF;

  SELECT mp INTO model_perm FROM jsonb_array_elements(prof.model_permissions) mp
    WHERE (mp->>'model_id')::uuid = rec.model_id LIMIT 1;
  IF model_perm IS NULL THEN RETURN false; END IF;

  rule := model_perm -> (scope_kind || '_scope');
  IF rule IS NULL THEN RETURN true; END IF;
  IF rule->>'mode' = 'all' THEN RETURN true; END IF;
  IF rule->>'mode' <> 'filtered' THEN RETURN true; END IF;
  IF jsonb_array_length(rule->'conditions') = 0 THEN RETURN true; END IF;

  FOR cond IN SELECT * FROM jsonb_array_elements(rule->'conditions')
  LOOP
    field_kind := cond->'field'->>'kind';
    operator := cond->>'operator';
    IF field_kind = 'created_by' THEN
      rec_value := to_jsonb(rec.created_by_user_id);
      rec_value_text := rec.created_by_user_id::text;
    ELSE
      field_slug := cond->'field'->>'field_slug';
      IF field_slug IS NULL THEN
        SELECT (f->>'name') INTO field_slug FROM models m,
          jsonb_array_elements(m.schema->'sections') s,
          jsonb_array_elements(s->'fields') f
         WHERE m.id = rec.model_id AND f->>'id' = cond->'field'->>'field_id' LIMIT 1;
      END IF;
      IF field_slug IS NULL THEN RETURN false; END IF;
      rec_value := rec.data -> field_slug;
      rec_value_text := rec.data ->> field_slug;
    END IF;

    IF operator = 'is_empty' THEN
      pass := rec_value IS NULL OR rec_value = 'null'::jsonb
              OR COALESCE(rec_value_text,'') = ''
              OR (jsonb_typeof(rec_value)='array' AND jsonb_array_length(rec_value)=0);
      IF NOT pass THEN RETURN false; END IF; CONTINUE;
    ELSIF operator = 'is_not_empty' THEN
      pass := rec_value IS NOT NULL AND rec_value <> 'null'::jsonb
              AND COALESCE(rec_value_text,'') <> ''
              AND (jsonb_typeof(rec_value)<>'array' OR jsonb_array_length(rec_value)>0);
      IF NOT pass THEN RETURN false; END IF; CONTINUE;
    END IF;

    source_kind := cond->'source'->>'kind';
    IF source_kind = 'literal' THEN
      rhs_text := cond->'source'->>'value';
    ELSIF source_kind = 'current_user' THEN
      rhs_text := app_uid::text;
    ELSIF source_kind = 'role_field' THEN
      SELECT a INTO user_assignment FROM jsonb_array_elements(COALESCE(user_assignments,'[]'::jsonb)) a
        WHERE a->>'role_id' = cond->'source'->>'role_id' LIMIT 1;
      IF user_assignment IS NULL THEN RETURN false; END IF;
      rhs_text := user_assignment->'field_values'->>(cond->'source'->>'field_slug');
      IF rhs_text IS NULL THEN RETURN false; END IF;
    ELSE RETURN false; END IF;

    IF operator = 'equals' THEN
      IF jsonb_typeof(rec_value)='array' THEN
        pass := EXISTS(SELECT 1 FROM jsonb_array_elements_text(rec_value) v WHERE v = rhs_text);
      ELSE pass := COALESCE(rec_value_text,'') = COALESCE(rhs_text,''); END IF;
    ELSIF operator = 'not_equals' THEN
      IF jsonb_typeof(rec_value)='array' THEN
        pass := NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(rec_value) v WHERE v = rhs_text);
      ELSE pass := rec_value_text IS DISTINCT FROM rhs_text; END IF;
    ELSIF operator = 'contains' THEN
      IF jsonb_typeof(rec_value)='array' THEN
        pass := EXISTS(SELECT 1 FROM jsonb_array_elements_text(rec_value) v
                        WHERE position(lower(rhs_text) IN lower(v)) > 0);
      ELSE pass := position(lower(COALESCE(rhs_text,'')) IN lower(COALESCE(rec_value_text,''))) > 0; END IF;
    ELSIF operator = 'greater_than' THEN
      BEGIN pass := rec_value_text::numeric > rhs_text::numeric; EXCEPTION WHEN OTHERS THEN pass := false; END;
    ELSIF operator = 'less_than' THEN
      BEGIN pass := rec_value_text::numeric < rhs_text::numeric; EXCEPTION WHEN OTHERS THEN pass := false; END;
    ELSE pass := false; END IF;
    IF NOT pass THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION wassell_can_view_record(auth_user_id UUID, rec records)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT wassell_user_has_action(auth_user_id, rec.model_id, 'view')
    AND wassell_record_passes_scope(rec, auth_user_id, 'view');
$$;
CREATE OR REPLACE FUNCTION wassell_can_edit_record(auth_user_id UUID, rec records)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT wassell_user_has_action(auth_user_id, rec.model_id, 'edit')
    AND wassell_record_passes_scope(rec, auth_user_id, 'view')
    AND wassell_record_passes_scope(rec, auth_user_id, 'edit');
$$;
CREATE OR REPLACE FUNCTION wassell_can_create_record(auth_user_id UUID, rec records)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT wassell_user_has_action(auth_user_id, rec.model_id, 'create');
$$;
CREATE OR REPLACE FUNCTION wassell_can_delete_record(auth_user_id UUID, rec records)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT wassell_user_has_action(auth_user_id, rec.model_id, 'delete')
    AND wassell_record_passes_scope(rec, auth_user_id, 'view')
    AND wassell_record_passes_scope(rec, auth_user_id, 'edit');
$$;

-- Drop-then-create so re-running schema.sql is idempotent. Matches the
-- pattern the older RLS sections (wa_*, chat_messages, call_logs, etc.)
-- already use. Without these DROPs the script fails on re-run with
-- `policy "records_view" for table "records" already exists`.
DROP POLICY IF EXISTS "records_view"           ON records;
DROP POLICY IF EXISTS "records_insert"         ON records;
DROP POLICY IF EXISTS "records_update"         ON records;
DROP POLICY IF EXISTS "records_delete"         ON records;
DROP POLICY IF EXISTS "models_read"            ON models;
DROP POLICY IF EXISTS "models_write"           ON models;
DROP POLICY IF EXISTS "model_groups_read"      ON model_groups;
DROP POLICY IF EXISTS "model_groups_write"     ON model_groups;
DROP POLICY IF EXISTS "profiles_read"          ON profiles;
DROP POLICY IF EXISTS "profiles_write"         ON profiles;
DROP POLICY IF EXISTS "roles_read"             ON roles;
DROP POLICY IF EXISTS "roles_write"            ON roles;
DROP POLICY IF EXISTS "users_read"             ON users;
DROP POLICY IF EXISTS "users_write"            ON users;
DROP POLICY IF EXISTS "model_views_read"       ON model_views;
DROP POLICY IF EXISTS "model_views_write"      ON model_views;
DROP POLICY IF EXISTS "field_templates_read"   ON field_templates;
DROP POLICY IF EXISTS "field_templates_write"  ON field_templates;
DROP POLICY IF EXISTS "workflows_admin"        ON workflows;
DROP POLICY IF EXISTS "workflows_select"       ON workflows;
DROP POLICY IF EXISTS "workflows_insert"       ON workflows;
DROP POLICY IF EXISTS "workflows_update"       ON workflows;
DROP POLICY IF EXISTS "workflows_delete"       ON workflows;
DROP POLICY IF EXISTS "workflow_groups_admin"  ON workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_select" ON workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_insert" ON workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_update" ON workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_delete" ON workflow_groups;
DROP POLICY IF EXISTS "workflow_runs_read"     ON workflow_runs;
DROP POLICY IF EXISTS "workflow_runs_insert"   ON workflow_runs;
DROP POLICY IF EXISTS "workflow_runs_modify"   ON workflow_runs;
DROP POLICY IF EXISTS "workflow_runs_delete"   ON workflow_runs;
DROP POLICY IF EXISTS "dashboards_admin"       ON dashboards;

-- Records: per-row gating. Admin profiles bypass via the helpers.
CREATE POLICY "records_view"   ON records FOR SELECT TO authenticated USING (wassell_can_view_record((SELECT auth.uid()), records.*));
CREATE POLICY "records_insert" ON records FOR INSERT TO authenticated WITH CHECK (wassell_can_create_record((SELECT auth.uid()), records.*));
CREATE POLICY "records_update" ON records FOR UPDATE TO authenticated USING (wassell_can_edit_record((SELECT auth.uid()), records.*)) WITH CHECK (wassell_can_edit_record((SELECT auth.uid()), records.*));
CREATE POLICY "records_delete" ON records FOR DELETE TO authenticated USING (wassell_can_delete_record((SELECT auth.uid()), records.*));

-- Models / model_groups: read for the UI, write for admins.
CREATE POLICY "models_read"        ON models       FOR SELECT TO authenticated USING (true);
CREATE POLICY "models_write"       ON models       FOR ALL    TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "model_groups_read"  ON model_groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "model_groups_write" ON model_groups FOR ALL    TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));

-- Profiles / roles: read for UI rendering, write for admins.
CREATE POLICY "profiles_read"  ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_write" ON profiles FOR ALL    TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "roles_read"     ON roles    FOR SELECT TO authenticated USING (true);
CREATE POLICY "roles_write"    ON roles    FOR ALL    TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));

-- Users: read for assignee/role pickers; write for admin OR self.
CREATE POLICY "users_read"  ON users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_write" ON users FOR ALL    TO authenticated
  USING (wassell_is_admin((SELECT auth.uid())) OR users.auth_uid = (SELECT auth.uid()))
  WITH CHECK (wassell_is_admin((SELECT auth.uid())) OR users.auth_uid = (SELECT auth.uid()));

-- Saved views: read own + shared, write own or admin.
CREATE POLICY "model_views_read" ON model_views FOR SELECT TO authenticated
  USING (is_shared = true OR user_id::text = wassell_app_user_id((SELECT auth.uid()))::text OR wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "model_views_write" ON model_views FOR ALL TO authenticated
  USING (user_id::text = wassell_app_user_id((SELECT auth.uid()))::text OR wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (user_id::text = wassell_app_user_id((SELECT auth.uid()))::text OR wassell_is_admin((SELECT auth.uid())));

-- Field templates: read everyone, write admin.
CREATE POLICY "field_templates_read"  ON field_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "field_templates_write" ON field_templates FOR ALL    TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));

-- Builder area: WRITES are admin-only end-to-end; SELECT additionally allows
-- profiles flagged `can_view_workflows` (read-only) so the Sales Process
-- Studio can show linked workflows + run history to granted non-admins. The
-- FOR ALL admin policy was split into per-command policies so SELECT carries
-- exactly one permissive policy (matches the 2026-05-07 B.4 posture).
CREATE POLICY "workflows_select"       ON workflows       FOR SELECT TO authenticated USING (wassell_can_view_workflows((SELECT auth.uid())));
CREATE POLICY "workflows_insert"       ON workflows       FOR INSERT TO authenticated WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflows_update"       ON workflows       FOR UPDATE TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflows_delete"       ON workflows       FOR DELETE TO authenticated USING (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflow_groups_select" ON workflow_groups FOR SELECT TO authenticated USING (wassell_can_view_workflows((SELECT auth.uid())));
CREATE POLICY "workflow_groups_insert" ON workflow_groups FOR INSERT TO authenticated WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflow_groups_update" ON workflow_groups FOR UPDATE TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflow_groups_delete" ON workflow_groups FOR DELETE TO authenticated USING (wassell_is_admin((SELECT auth.uid())));
-- workflow_runs: any authenticated user can append (their record save
-- might trigger a workflow whose run is logged client-side); reads are
-- admin OR can_view_workflows (read-only run history); updates / deletes
-- stay admin-only. Without the insert split, non-admin saves produce RLS
-- denial toasts on every triggered workflow.
CREATE POLICY "workflow_runs_read"   ON workflow_runs FOR SELECT TO authenticated USING (wassell_can_view_workflows((SELECT auth.uid())));
CREATE POLICY "workflow_runs_insert" ON workflow_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "workflow_runs_modify" ON workflow_runs FOR UPDATE TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflow_runs_delete" ON workflow_runs FOR DELETE TO authenticated USING (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "dashboards_admin"      ON dashboards      FOR ALL TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));
-- Metrics: any authenticated user may READ a metric definition (so metric-driven
-- widgets resolve for everyone who can see a dashboard; the VALUE is still scoped
-- per viewer). Only admins may write. See 2026-06-17_metric_definitions_read_policy.sql.
DROP POLICY IF EXISTS "metric_definitions_admin" ON metric_definitions;
DROP POLICY IF EXISTS "metric_definitions_read" ON metric_definitions;
DROP POLICY IF EXISTS "metric_definitions_write" ON metric_definitions;
CREATE POLICY "metric_definitions_read"  ON metric_definitions FOR SELECT TO authenticated USING (true);
CREATE POLICY "metric_definitions_write" ON metric_definitions FOR ALL TO authenticated USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));

-- Public dashboards: anon access goes through `get_public_dashboard`,
-- not a direct SELECT. The function checks BOTH is_public AND a token
-- match server-side; anon has no direct SELECT permission so the URL
-- token actually gates access (used to be routing-only).
CREATE OR REPLACE FUNCTION get_public_dashboard(p_token TEXT)
RETURNS dashboards
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM dashboards
   WHERE public_token = p_token
     AND is_public = true
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION get_public_dashboard(TEXT) TO anon, authenticated;

-- ── audit_log (Phase 3 — user-mgmt forensics) ────────────────────
-- Captures every mutation on users / profiles / roles. Record-level
-- audit is intentionally NOT here — different design + retention.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_auth_uid UUID,
  actor_email TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_label TEXT,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx     ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx  ON audit_log(actor_auth_uid);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_log_admin_read"   ON audit_log;
DROP POLICY IF EXISTS "audit_log_admin_insert" ON audit_log;
CREATE POLICY "audit_log_admin_read" ON audit_log FOR SELECT TO authenticated
  USING (wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "audit_log_admin_insert" ON audit_log FOR INSERT TO authenticated
  WITH CHECK (wassell_is_admin((SELECT auth.uid())) OR actor_auth_uid = (SELECT auth.uid()));

-- ============================================================
-- WHATSAPP AI AGENT (HaberChat webhook) — DEPRECATED
-- ============================================================
-- Scaffolded for a never-shipped autonomous AI replier (the supabase/functions/
-- haberchat-webhook/ Edge Function directory does not exist in the repo).
-- SUPERSEDED by the Chats module — see `chat_messages` / `whatsapp_numbers`
-- below and docs/prd/chats.md. Do NOT write to `wa_conversations` / `wa_leads`
-- / `wa_errors`. Left in place so any historical rows are not lost; a future
-- migration can drop them once confirmed empty.

CREATE TABLE IF NOT EXISTS wa_conversations (
  phone TEXT PRIMARY KEY,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,       -- Anthropic {role, content} array
  lead_summary JSONB NOT NULL DEFAULT '{}'::jsonb,   -- compact prefs, survives trimming
  contact_name TEXT,
  language TEXT NOT NULL DEFAULT 'ar',               -- 'ar' (Najdi) | 'en'
  last_chat_id TEXT,
  turn_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_leads (
  phone TEXT PRIMARY KEY,
  name TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  matched_project_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_errors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone TEXT,
  stage TEXT,
  payload JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_conversations_updated ON wa_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_leads_last_contact   ON wa_leads(last_contact_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_errors_created       ON wa_errors(created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at_wa_conversations ON wa_conversations;
CREATE TRIGGER set_updated_at_wa_conversations BEFORE UPDATE ON wa_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_wa_leads ON wa_leads;
CREATE TRIGGER set_updated_at_wa_leads BEFORE UPDATE ON wa_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE wa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_leads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_errors        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON wa_conversations;
DROP POLICY IF EXISTS "Authenticated full access" ON wa_leads;
DROP POLICY IF EXISTS "Authenticated full access" ON wa_errors;

CREATE POLICY "Authenticated full access" ON wa_conversations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON wa_leads         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON wa_errors        FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- CHATS MODULE (WhatsApp via Haberchat)
-- ============================================================
-- Conversations surface as ordinary rows in `records` (model_id = chats model
-- id, id = uuidv5(chat_wid)) so the existing list/card/table UIs work as-is.
-- Messages live here in their own table with Realtime enabled so the detail
-- page streams updates. `whatsapp_numbers` tracks which Haberchat devices
-- (phone numbers) are connected and which is the default for new chats.
-- See docs/prd/chats.md for the full spec.

CREATE TABLE IF NOT EXISTS chat_messages (
  id                     TEXT PRIMARY KEY,                 -- Haberchat message wid
  chat_wid               TEXT NOT NULL,                    -- conversation wid on Haberchat
  conversation_record_id UUID NOT NULL,                    -- uuidv5(chat_wid); matches records.id
  device_id              TEXT NOT NULL,                    -- Haberchat device id (24-hex)
  flow                   TEXT NOT NULL CHECK (flow IN ('in', 'out')),
  kind                   TEXT NOT NULL,                    -- text | image | video | audio | document | sticker | location | template | interactive | notification_template | call_log | ...
  subtype                TEXT,                             -- Haberchat message subtype; discriminates system events (e.g. biz_privacy_mode_init_fb on notification_template)
  body                   TEXT,                             -- text body or caption
  from_phone             TEXT,
  to_phone               TEXT,
  ack                    TEXT,                             -- failed | pending | sent | delivered | read | played
  date                   TIMESTAMPTZ NOT NULL,             -- message timestamp from Haberchat
  media_file_id          TEXT,                             -- Haberchat file id; render via /api/haberchat/files/:id proxy
  media_mime             TEXT,
  media_size             INT,
  media_caption          TEXT,
  reference              TEXT,                             -- outbound idempotency key — match optimistic send to webhook ack
  quoted                 JSONB,                            -- { wid, body, kind } for replies
  meta                   JSONB NOT NULL DEFAULT '{}'::jsonb, -- room for buttons / list responses / template payloads
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_date     ON chat_messages(chat_wid, date DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation  ON chat_messages(conversation_record_id);
-- Partial index for the dashboard "in-flight deliveries" query — skips the
-- overwhelmingly common 'read' state.
CREATE INDEX IF NOT EXISTS idx_chat_messages_ack_inflight  ON chat_messages(ack, date)
  WHERE ack IN ('pending', 'sent', 'delivered');

-- Connected WhatsApp numbers (Haberchat devices). The row is a local overlay
-- on top of what Haberchat already knows — friendly names + default flag are
-- ours; the Haberchat device + phone are the authoritative reference. Admin
-- manages via /settings/whatsapp-numbers.
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  device_id        TEXT PRIMARY KEY,                       -- Haberchat device id
  phone            TEXT NOT NULL,                          -- E.164 display (e.g. +9665...)
  friendly_name_ar TEXT,
  friendly_name_en TEXT,
  is_default       BOOLEAN NOT NULL DEFAULT false,
  is_active        BOOLEAN NOT NULL DEFAULT true,          -- admin can hide a number without removing it from Haberchat
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one default number at a time. Partial unique index means rows with
-- is_default=false are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS one_default_whatsapp_number
  ON whatsapp_numbers ((is_default)) WHERE is_default = true;

-- updated_at triggers — reuse existing update_updated_at_column function
DROP TRIGGER IF EXISTS set_updated_at_chat_messages ON chat_messages;
CREATE TRIGGER set_updated_at_chat_messages BEFORE UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_whatsapp_numbers ON whatsapp_numbers;
CREATE TRIGGER set_updated_at_whatsapp_numbers BEFORE UPDATE ON whatsapp_numbers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE chat_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON chat_messages;
DROP POLICY IF EXISTS "Authenticated full access" ON whatsapp_numbers;

CREATE POLICY "Authenticated full access" ON chat_messages    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON whatsapp_numbers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Enable Realtime for chat_messages so the detail page streams new messages.
-- `records` is intentionally NOT added to realtime here — that would impact
-- every model in the app. Webhook handler bumps parent conversation records
-- via normal writes; list-page updates come from on-mount refresh, not from
-- a live stream.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;
END $$;

-- ============================================================
-- MARKETING OPERATIONS (reels + posts content pipeline)
-- ============================================================
-- PRESENTATIONS — REMOVED
-- ============================================================
-- The Presentations feature (templates + brands + jobs + cloud worker +
-- legacy daemon) was removed. If you're applying this schema against a
-- DB that still has the tables, run once to clean up:
--
--   DROP TABLE IF EXISTS presentation_jobs CASCADE;
--   DROP TABLE IF EXISTS presentation_templates CASCADE;
--   DROP TABLE IF EXISTS presentation_brands CASCADE;
--   DROP TABLE IF EXISTS daemon_status CASCADE;
--   DROP FUNCTION IF EXISTS claim_next_presentation_job(text) CASCADE;
-- ============================================================


-- ============================================================
-- CALLS MODULE (Hatif webhook)
-- ============================================================
-- Every call event Hatif's platform sees (inbound, outbound-IVR, and calls
-- agents place from Hatif's own mobile/desktop app on a channel we own) is
-- POSTed to /api/webhook/hatif-call and upserted here.
--
-- Linking to clients: Hatif gives us `contactNumber`; we normalize to E.164
-- and store it as `contact_phone`. The UI queries this table by the client's
-- phone field at render time, so records remain loosely coupled — a call logs
-- correctly even if the client record is created AFTER the call, and moving a
-- call between clients is just a phone-number edit.
--
-- See docs/prd/calling.md for the full spec.

CREATE TABLE IF NOT EXISTS call_logs (
  id                         UUID PRIMARY KEY,                 -- Hatif callId (already UUID)
  workspace_id               UUID,                             -- Hatif workspace
  channel_id                 UUID NOT NULL,                    -- Hatif channel
  direction                  TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status                     TEXT NOT NULL,                    -- completed | missed | rejected_by_caller | rejected_by_callee | no_answer | cancelled | failed | ringing | active
  caller_number              TEXT,                             -- raw from Hatif
  callee_number              TEXT,                             -- raw from Hatif
  contact_phone              TEXT,                             -- normalized E.164 of the customer side — used for client matching
  contact_id                 UUID,                             -- Hatif contactId (NOT our records.id)
  agent_user_id              UUID,                             -- Hatif userId of the agent who handled the call
  agent_name                 TEXT,                             -- denormalized for list display
  ai_agent_id                UUID,                             -- non-null if an AI agent handled the call
  pickup_time                TIMESTAMPTZ,
  hangup_time                TIMESTAMPTZ,
  duration_seconds           INT,                              -- parsed from Hatif's HH:MM:SS callLength string
  recording_url              TEXT,
  summary                    TEXT,                             -- AI-generated call summary
  sentiment                  TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed', 'unknown')),
  transcription              JSONB,                            -- { text, words: [{ text, start, end, type, speaker }] }
  evaluation_criteria_result JSONB,                            -- [{ id, dataType, description, value, rationale }]
  -- Raw webhook payload kept for forensics / schema drift / replay
  raw_event                  JSONB NOT NULL,
  creation_time              TIMESTAMPTZ NOT NULL,             -- Hatif event creationTime
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DTMF result columns — populated by the IVR-result webhook when an
-- `outbound_ivr` workflow action was the trigger for the call. Always null
-- for inbound or manual outbound calls.
ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS dtmf_digit TEXT,
  ADD COLUMN IF NOT EXISTS dtmf_label TEXT;

CREATE INDEX IF NOT EXISTS idx_call_logs_contact_phone ON call_logs(contact_phone);
CREATE INDEX IF NOT EXISTS idx_call_logs_channel       ON call_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_creation      ON call_logs(creation_time DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_agent         ON call_logs(agent_user_id);

-- updated_at trigger — reuse existing update_updated_at_column function
DROP TRIGGER IF EXISTS set_updated_at_call_logs ON call_logs;
CREATE TRIGGER set_updated_at_call_logs BEFORE UPDATE ON call_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON call_logs;
CREATE POLICY "Authenticated full access" ON call_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Realtime so the CallHistoryPanel on a client record streams live updates
-- when a webhook arrives while the user is on that record.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'call_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE call_logs;
  END IF;
END $$;

-- ============================================================
-- WHITEBOARD
-- ============================================================
-- Freeform drawing canvases (tldraw). Boards live in optional flat folders
-- and are shared across every authenticated user — no owner column because
-- we treat the workspace as a team library (same as dashboards).
-- See docs/prd/whiteboard.md.

CREATE TABLE IF NOT EXISTS whiteboard_folders (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  "order"     INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whiteboards (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folder_id   UUID REFERENCES whiteboard_folders(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  -- tldraw store snapshot — `editor.getSnapshot()`. Null until first save.
  snapshot    JSONB,
  "order"     INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whiteboards_folder ON whiteboards(folder_id);
CREATE INDEX IF NOT EXISTS idx_whiteboards_updated ON whiteboards(updated_at DESC);

DROP TRIGGER IF EXISTS set_updated_at_whiteboard_folders ON whiteboard_folders;
CREATE TRIGGER set_updated_at_whiteboard_folders BEFORE UPDATE ON whiteboard_folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_whiteboards ON whiteboards;
CREATE TRIGGER set_updated_at_whiteboards BEFORE UPDATE ON whiteboards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE whiteboard_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE whiteboards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON whiteboard_folders;
CREATE POLICY "Authenticated full access" ON whiteboard_folders FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated full access" ON whiteboards;
CREATE POLICY "Authenticated full access" ON whiteboards FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- ACTIVITY LOG — unified audit trail for everything in the app
-- ============================================================
-- Aggregates: auth events, record CRUD, record opens, workflow run summaries,
-- AI agent turns + tool calls (full payload), API hits, webhook receipts.
-- The /logs page reads this table; rich workflow detail still lives in
-- `workflow_runs` and is linked via `workflow_run_id`.
--
-- target_record_id is intentionally NOT a foreign key — the whole point of an
-- audit trail is "what was there before it got deleted".
-- See docs/prd/logs.md for the full spec.

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  category TEXT NOT NULL CHECK (category IN ('auth','record','workflow','ai_agent','api','webhook','system')),
  -- Sub-type within the category — free-form so new subtypes don't need a migration.
  --   auth:     sign_in | sign_out
  --   record:   create | update | delete | open
  --   workflow: run
  --   ai_agent: turn | tool_call
  --   api:      request
  --   webhook:  receipt
  --   system:   initialize | migration | error
  event_type TEXT NOT NULL,
  -- Actor — who caused the event. Both nullable for webhook/system events.
  actor_user_id UUID,
  actor_email TEXT,
  -- Target — what the event acted on. Not a real FK so deletes don't erase the trail.
  target_model_id UUID,
  target_record_id UUID,
  target_label TEXT,
  -- Bilingual one-line summary shown in the timeline list view.
  summary_ar TEXT NOT NULL,
  summary_en TEXT NOT NULL,
  -- Full detail payload — shape depends on category/event_type. UI pretty-prints.
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms INT,
  status TEXT, -- success | error | warning | info
  error TEXT,
  -- Deep-link to the rich workflow_runs row when category='workflow'.
  workflow_run_id UUID
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_category ON activity_log(category);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor ON activity_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_target ON activity_log(target_model_id, target_record_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_event_type ON activity_log(event_type);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON activity_log;
CREATE POLICY "Authenticated full access" ON activity_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- Auto-generated per-model views (added 2026-04-26)
-- ============================================================
-- Each model in the `models` table gets a `v_<name>` view that materializes
-- its schema fields as proper columns over the unified `records` JSONB. The
-- AFTER INSERT/UPDATE/DELETE trigger keeps views in sync — saving a model
-- in the Builder regenerates its view atomically. Views are read-only by
-- design; the app keeps writing to `records`.
--
-- Why: makes `records` browsable in the Supabase Table Editor like a normal
-- per-model table, lets external BI tools (Metabase, etc.) connect without
-- learning JSONB tricks, and makes ad-hoc SQL reports human-readable. No
-- schema migration, no app changes — JSONB stays the source of truth.

-- Safe-cast helpers — return NULL on parse failure rather than erroring out
-- the whole view when one row has bad data.
CREATE OR REPLACE FUNCTION public.try_numeric(t text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
  RETURN t::numeric;
EXCEPTION WHEN others THEN RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.try_timestamptz(t text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
  RETURN t::timestamptz;
EXCEPTION WHEN others THEN RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.try_boolean(t text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
  RETURN t::boolean;
EXCEPTION WHEN others THEN RETURN NULL;
END;
$fn$;

-- Build + execute "CREATE OR REPLACE VIEW v_<model>" from a single model's schema.
-- WITH (security_invoker = true) so the view honors the caller's RLS, not the
-- function-owner's privileges — necessary for future per-tenant isolation.
CREATE OR REPLACE FUNCTION public.regenerate_model_view(p_model_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model       record;
  v_view_name   text;
  v_field       jsonb;
  v_fname       text;
  v_ftype       text;
  v_parts       text[] := ARRAY['id', 'created_at', 'updated_at', 'model_id'];
  v_sql         text;
BEGIN
  SELECT id, name, schema INTO v_model FROM public.models WHERE id = p_model_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_view_name := 'v_' || v_model.name;
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    -- Virtual / derived field types: no stored value, skip in views.
    IF v_ftype IN ('whatsapp_history', 'call_history') THEN CONTINUE; END IF;
    IF v_ftype = 'range' THEN
      v_parts := v_parts || format('public.try_numeric(data->%L->>''min'') AS %I', v_fname, v_fname || '_min');
      v_parts := v_parts || format('public.try_numeric(data->%L->>''max'') AS %I', v_fname, v_fname || '_max');
    ELSIF v_ftype IN ('number', 'currency', 'formula') THEN
      v_parts := v_parts || format('public.try_numeric(data->>%L) AS %I', v_fname, v_fname);
    ELSIF v_ftype IN ('date', 'datetime') THEN
      v_parts := v_parts || format('public.try_timestamptz(data->>%L) AS %I', v_fname, v_fname);
    ELSIF v_ftype = 'checkbox' THEN
      v_parts := v_parts || format('public.try_boolean(data->>%L) AS %I', v_fname, v_fname);
    ELSIF v_ftype IN ('multiselect', 'table', 'notes') THEN
      v_parts := v_parts || format('(data->%L) AS %I', v_fname, v_fname);
    ELSE
      v_parts := v_parts || format('(data->>%L) AS %I', v_fname, v_fname);
    END IF;
  END LOOP;
  -- DROP first because CREATE OR REPLACE VIEW only allows ADDING columns
  -- at the end. When a model's schema changes (a field is renamed,
  -- removed, or its type changes the column-list shape), the new view
  -- has a different column list and the replace fails with
  -- `cannot drop columns from view`.
  v_sql := format(
    'DROP VIEW IF EXISTS public.%I; CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT %s FROM public.records WHERE model_id = %L',
    v_view_name, v_view_name, array_to_string(v_parts, ', '), v_model.id
  );
  EXECUTE v_sql;
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon, service_role', v_view_name);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.drop_model_view(p_model_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_view_name text;
BEGIN
  IF p_model_name IS NULL OR p_model_name = '' THEN RETURN; END IF;
  v_view_name := 'v_' || p_model_name;
  EXECUTE format('DROP VIEW IF EXISTS public.%I', v_view_name);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.regenerate_all_model_views()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count integer := 0; v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.models LOOP
    PERFORM public.regenerate_model_view(v_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$fn$;

-- Trigger: keeps views in sync with model edits. Wraps in EXCEPTION so a
-- view-sync failure never breaks the underlying model save.
CREATE OR REPLACE FUNCTION public.models_view_sync_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.drop_model_view(OLD.name);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name THEN
    PERFORM public.drop_model_view(OLD.name);
  END IF;
  PERFORM public.regenerate_model_view(NEW.id);
  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING '[models_view_sync] % on model %: %', TG_OP, COALESCE(NEW.id, OLD.id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS models_view_sync ON public.models;
CREATE TRIGGER models_view_sync
AFTER INSERT OR UPDATE OF name, schema OR DELETE
ON public.models
FOR EACH ROW
EXECUTE FUNCTION public.models_view_sync_trigger();

-- One-time seed for fresh installs: regenerate every view from current models.
-- Idempotent — running on an existing install is a no-op via CREATE OR REPLACE.
SELECT public.regenerate_all_model_views();

-- ============================================================
-- FREEZE INFRASTRUCTURE (added 2026-05-05)
-- ============================================================
-- "Freezing" a model promotes it from a JSONB row in the unified `records`
-- table to a real Postgres table with proper typed columns, junction tables
-- for multi-value fields (multiselect, multi-lookup), and subtables for
-- `table` fields. After freeze, the app reads/writes the frozen model
-- through dedicated paths; the old JSONB row is deleted from `records`.
--
-- One-way, per-model. User clicks "Freeze" in the Builder once they're done
-- iterating on a model's schema; future schema changes happen via Claude
-- writing a migration. Custom-UI models (`chats`, `ai_chats`) are excluded.
--
-- Field-type → physical mapping:
--   text/textarea/email/phone/url/dropdown/auto_id/lookup(single)  → text
--   number/currency/formula                                         → numeric
--   date/datetime                                                   → timestamptz
--   checkbox                                                        → boolean
--   range                                                           → <name>_min, <name>_max numeric
--   notes/section_mirror/section_selector/assignee                  → jsonb
--   multiselect                                                     → junction <model>__<field> (record_id, value)
--   lookup is_multi=true                                            → junction <model>__<field> (record_id, target_record_id)
--   table                                                           → subtable <model>__<field> with row columns
--   mirror                                                          → SKIPPED (computed at runtime from sibling lookup)
--   whatsapp_history / call_history                                 → SKIPPED (derived from chat_messages / call_logs at render)
--
-- Coercion failures abort the freeze and are reported back to the caller —
-- never silently NULL'd. Auto-IDs switch from JSONB-counter to a Postgres
-- sequence per (model, field), eliminating the read-modify-write race.

-- ────────────────────────────────────────────────────────────────────
-- Schema columns + index
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE models
  ADD COLUMN IF NOT EXISTS is_hardcoded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS table_name text;

CREATE INDEX IF NOT EXISTS idx_models_is_hardcoded ON models(is_hardcoded) WHERE is_hardcoded = true;

-- ────────────────────────────────────────────────────────────────────
-- Helpers
-- ────────────────────────────────────────────────────────────────────

-- Defensive identifier sanitizer — slugs from the app are already
-- snake_case but verifying here means a malicious schema row can't
-- inject SQL via dynamic table/column names.
CREATE OR REPLACE FUNCTION public.freeze_safe_ident(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
  IF p IS NULL OR p = '' THEN
    RAISE EXCEPTION 'identifier may not be empty';
  END IF;
  IF p !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid identifier: %', p;
  END IF;
  IF length(p) > 50 THEN
    RAISE EXCEPTION 'identifier too long (>50 chars): %', p;
  END IF;
  RETURN p;
END;
$fn$;

-- Models excluded from freeze because they have custom UIs that don't fit
-- the generic record/form pattern.
CREATE OR REPLACE FUNCTION public.is_freezable_model(p_model_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT p_model_name IS NOT NULL
     AND p_model_name NOT IN ('chats', 'ai_chats');
$fn$;

-- Multi-value field types that need junction/subtables.
CREATE OR REPLACE FUNCTION public.freeze_is_multi_value(p_ftype text, p_is_multi boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT p_ftype = 'multiselect'
      OR p_ftype = 'table'
      OR (p_ftype = 'lookup' AND COALESCE(p_is_multi, false));
$fn$;

-- Field types that get NO physical column (computed at runtime).
-- `mirror` resolves through a sibling lookup at read time.
-- `whatsapp_history` / `call_history` render derived data (chat messages,
-- Hatif call logs) keyed off the parent record's id and phone fields —
-- they store nothing on the record itself.
CREATE OR REPLACE FUNCTION public.freeze_is_virtual(p_ftype text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT p_ftype IN ('mirror', 'whatsapp_history', 'call_history');
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- Coercion check
-- ────────────────────────────────────────────────────────────────────
-- Walks every record for the model and every typed field; reports rows
-- that fail to coerce so the user can fix them before freezing. Returns
-- empty when the model is freezable as-is.

CREATE OR REPLACE FUNCTION public.freeze_check_coercion(p_model_id uuid)
RETURNS TABLE (
  record_id uuid,
  field_name text,
  field_type text,
  raw_value text,
  reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_field jsonb;
  v_fname text;
  v_ftype text;
  v_schema jsonb;
BEGIN
  SELECT schema INTO v_schema FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found', p_model_id;
  END IF;

  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;

    -- numeric types
    IF v_ftype IN ('number', 'currency', 'formula') THEN
      RETURN QUERY
        SELECT r.id, v_fname, v_ftype, r.data->>v_fname,
               'cannot coerce to numeric'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->>v_fname IS NOT NULL
          AND r.data->>v_fname <> ''
          AND public.try_numeric(r.data->>v_fname) IS NULL;

    -- timestamptz
    ELSIF v_ftype IN ('date', 'datetime') THEN
      RETURN QUERY
        SELECT r.id, v_fname, v_ftype, r.data->>v_fname,
               'cannot coerce to timestamptz'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->>v_fname IS NOT NULL
          AND r.data->>v_fname <> ''
          AND public.try_timestamptz(r.data->>v_fname) IS NULL;

    -- boolean
    ELSIF v_ftype = 'checkbox' THEN
      RETURN QUERY
        SELECT r.id, v_fname, v_ftype, r.data->>v_fname,
               'cannot coerce to boolean'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->>v_fname IS NOT NULL
          AND r.data->>v_fname <> ''
          AND public.try_boolean(r.data->>v_fname) IS NULL;

    -- range — both halves
    ELSIF v_ftype = 'range' THEN
      RETURN QUERY
        SELECT r.id, v_fname || '.min', v_ftype, r.data->v_fname->>'min',
               'cannot coerce range min to numeric'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->v_fname->>'min' IS NOT NULL
          AND r.data->v_fname->>'min' <> ''
          AND public.try_numeric(r.data->v_fname->>'min') IS NULL;
      RETURN QUERY
        SELECT r.id, v_fname || '.max', v_ftype, r.data->v_fname->>'max',
               'cannot coerce range max to numeric'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->v_fname->>'max' IS NOT NULL
          AND r.data->v_fname->>'max' <> ''
          AND public.try_numeric(r.data->v_fname->>'max') IS NULL;

    -- multiselect must be a JSON array (or scalar/null which we tolerate)
    ELSIF v_ftype = 'multiselect' THEN
      RETURN QUERY
        SELECT r.id, v_fname, v_ftype, r.data->>v_fname,
               'multiselect value must be a JSON array'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->v_fname IS NOT NULL
          AND jsonb_typeof(r.data->v_fname) NOT IN ('array', 'null');

    -- multi-lookup must be array; single lookup must be scalar
    ELSIF v_ftype = 'lookup' THEN
      IF COALESCE((v_field->>'is_multi')::boolean, false) THEN
        RETURN QUERY
          SELECT r.id, v_fname, v_ftype, r.data->>v_fname,
                 'multi-lookup value must be a JSON array'::text
          FROM records r
          WHERE r.model_id = p_model_id
            AND r.data ? v_fname
            AND r.data->v_fname IS NOT NULL
            AND jsonb_typeof(r.data->v_fname) NOT IN ('array', 'null');
      END IF;

    -- table fields must be array of row objects
    ELSIF v_ftype = 'table' THEN
      RETURN QUERY
        SELECT r.id, v_fname, v_ftype, r.data->>v_fname,
               'table value must be a JSON array of rows'::text
        FROM records r
        WHERE r.model_id = p_model_id
          AND r.data ? v_fname
          AND r.data->v_fname IS NOT NULL
          AND jsonb_typeof(r.data->v_fname) NOT IN ('array', 'null');
    END IF;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.freeze_check_coercion(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- regenerate_frozen_model_artifacts: rebuild view + save RPC for one
-- frozen model, idempotent. Called by freeze_model on first run and by
-- future schema migrations after column DDL.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.regenerate_frozen_model_artifacts(p_model_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_model        record;
  v_table        text;
  v_view_name    text;
  v_field        jsonb;
  v_fname        text;
  v_ftype        text;
  v_is_multi     boolean;
  v_view_keys    text := '';
  v_data_json    text := '';   -- jsonb_build_object(...) expression for RLS policies
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND OR NOT v_model.is_hardcoded THEN RETURN; END IF;

  v_table     := public.freeze_safe_ident(v_model.name);
  v_view_name := v_table || '_v';

  -- Build the JSONB-shape view: re-emits each frozen row as a `data` jsonb
  -- in the same shape the app/store expects. Junction-backed fields are
  -- aggregated back into JSON arrays. Writes go through public.record_save
  -- which dispatches to public.freeze_apply_row — no per-model save RPC,
  -- since freeze_apply_row already handles every field type generically.
  --
  -- We also accumulate a `jsonb_build_object(...)` expression that the
  -- RLS policies below use to re-build the same JSONB shape inline from
  -- the frozen-table columns, so `wassell_record_passes_scope` can
  -- evaluate field-based scope rules against frozen rows. Multi-value
  -- fields (junctions / subtables) are intentionally OMITTED from the
  -- policy expression — including them would join per-row in the policy
  -- and tank performance, and scope rules typically address scalar
  -- fields anyway. Scope conditions referencing multi-value fields fail
  -- closed on frozen tables in v1; this is documented in CLAUDE.md.
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;

    IF v_view_keys <> '' THEN v_view_keys := v_view_keys || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_view_keys := v_view_keys || format(
        '%L, jsonb_build_object(''min'', t.%I, ''max'', t.%I)',
        v_fname, v_fname || '_min', v_fname || '_max'
      );
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format(
        '%L, jsonb_build_object(''min'', %I, ''max'', %I)',
        v_fname, v_fname || '_min', v_fname || '_max'
      );
    ELSIF v_ftype = 'multiselect' THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname
      );
      -- Skip in policy expression (multi-value, see comment above).
    ELSIF v_ftype = 'lookup' AND v_is_multi THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(target_record_id ORDER BY target_record_id) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname
      );
      -- Skip in policy expression.
    ELSIF v_ftype = 'table' THEN
      -- Subtable: re-aggregate row objects in row_index order.
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(to_jsonb(s) - ''id'' - ''record_id'' - ''row_index'' ORDER BY row_index) FROM public.%I s WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname
      );
      -- Skip in policy expression.
    ELSE
      v_view_keys := v_view_keys || format('%L, t.%I', v_fname, v_fname);
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format('%L, %I::text', v_fname, v_fname);
    END IF;
  END LOOP;

  -- Empty-fields edge case: jsonb_build_object() with no args is invalid;
  -- emit an empty-object literal so the policy still parses.
  IF v_data_json = '' THEN v_data_json := '''{}''::jsonb'; ELSE v_data_json := 'jsonb_build_object(' || v_data_json || ')'; END IF;

  -- (Re)build the JSONB-shape view. `created_by_user_id` is surfaced as
  -- a top-level column so server-side reads from `unified_records`
  -- (which UNIONs the records table with each <name>_v) see the creator
  -- stamp and `wassell_record_passes_scope` can read it via rec.created_by_user_id.
  EXECUTE format('DROP VIEW IF EXISTS public.%I', v_view_name);
  EXECUTE format(
    'CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT t.id, %L::uuid AS model_id, jsonb_strip_nulls(jsonb_build_object(%s)) AS data, t.created_by_user_id, t.created_at, t.updated_at FROM public.%I t',
    v_view_name, p_model_id, v_view_keys, v_table
  );
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon, service_role', v_view_name);

  -- (Re)generate per-table RLS policies. Drop any prior versions so
  -- this function is idempotent across schema edits.
  EXECUTE format('DROP POLICY IF EXISTS "frozen_view"   ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_insert" ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_update" ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_delete" ON public.%I', v_table);

  EXECUTE format(
    $pol$CREATE POLICY "frozen_view" ON public.%I FOR SELECT TO authenticated USING (
      public.wassell_can_view_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s)
    )$pol$,
    v_table, p_model_id, v_data_json
  );
  EXECUTE format(
    $pol$CREATE POLICY "frozen_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (
      public.wassell_user_has_action((SELECT auth.uid()), %L::uuid, 'create')
    )$pol$,
    v_table, p_model_id
  );
  EXECUTE format(
    $pol$CREATE POLICY "frozen_update" ON public.%I FOR UPDATE TO authenticated
      USING (public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s))
      WITH CHECK (public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s))$pol$,
    v_table, p_model_id, v_data_json, p_model_id, v_data_json
  );
  EXECUTE format(
    $pol$CREATE POLICY "frozen_delete" ON public.%I FOR DELETE TO authenticated USING (
      public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s)
      AND public.wassell_user_has_action((SELECT auth.uid()), %L::uuid, 'delete')
    )$pol$,
    v_table, p_model_id, v_data_json, p_model_id
  );
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- freeze_apply_row: shared body for save RPCs. Reads the model schema
-- from `models.schema` JSONB at call-time and dispatches scalar UPDATE,
-- range-pair UPDATE, multiselect/multi-lookup junction replace, and
-- table subtable replace — all using dynamic SQL keyed on the model's
-- physical table name.
--
-- Why dynamic-from-schema instead of code-generating per-model bodies:
-- adding/removing a field becomes a regenerate_frozen_model_artifacts()
-- + ALTER TABLE call — no save-RPC body needs to be regenerated. Slightly
-- slower per call (one schema lookup) but vastly simpler to maintain.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.freeze_apply_row(
  p_model_id   uuid,
  p_id         uuid,
  p_data       jsonb,
  p_created_by uuid DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model       record;
  v_table       text;
  v_field       jsonb;
  v_fname       text;
  v_ftype       text;
  v_is_multi    boolean;
  v_assignments text := '';
  v_value       jsonb;
  v_arr         jsonb;
  v_row         jsonb;
  v_row_index   int;
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found in freeze_apply_row', p_model_id;
  END IF;
  v_table := public.freeze_safe_ident(v_model.name);

  -- 0. Stamp `created_by_user_id` on first save. COALESCE preserves
  --    any existing value on subsequent saves so the creator stamp
  --    survives later edits — same posture as the records-table flow
  --    in src/stores/appStore.ts saveRecord.
  IF p_created_by IS NOT NULL THEN
    EXECUTE format(
      'UPDATE public.%I SET created_by_user_id = COALESCE(created_by_user_id, $1) WHERE id = $2',
      v_table
    ) USING p_created_by, p_id;
  END IF;

  -- 1. Build a single UPDATE for all scalar/range columns.
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;

    IF v_assignments <> '' THEN v_assignments := v_assignments || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_assignments := v_assignments || format(
        '%I = public.try_numeric(($1->%L)->>''min''), %I = public.try_numeric(($1->%L)->>''max'')',
        v_fname || '_min', v_fname, v_fname || '_max', v_fname
      );
    ELSIF v_ftype IN ('number', 'currency', 'formula') THEN
      v_assignments := v_assignments || format(
        '%I = public.try_numeric($1->>%L)', v_fname, v_fname
      );
    ELSIF v_ftype IN ('date', 'datetime') THEN
      v_assignments := v_assignments || format(
        '%I = public.try_timestamptz($1->>%L)', v_fname, v_fname
      );
    ELSIF v_ftype = 'checkbox' THEN
      v_assignments := v_assignments || format(
        '%I = public.try_boolean($1->>%L)', v_fname, v_fname
      );
    ELSIF v_ftype IN ('notes', 'section_mirror', 'section_selector', 'assignee') THEN
      v_assignments := v_assignments || format(
        '%I = $1->%L', v_fname, v_fname
      );
    ELSE
      -- text-shaped: text, textarea, email, phone, url, dropdown, auto_id, lookup-single
      v_assignments := v_assignments || format(
        '%I = $1->>%L', v_fname, v_fname
      );
    END IF;
  END LOOP;

  IF v_assignments <> '' THEN
    EXECUTE format(
      'UPDATE public.%I SET %s, updated_at = now() WHERE id = $2',
      v_table, v_assignments
    ) USING p_data, p_id;
  END IF;

  -- 2. Replace junction/subtable rows for each multi-value field.
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF NOT public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;

    -- Wipe existing junction/subtable rows for this record.
    EXECUTE format('DELETE FROM public.%I WHERE record_id = $1',
                   v_table || '__' || v_fname) USING p_id;

    v_arr := p_data->v_fname;
    IF v_arr IS NULL OR jsonb_typeof(v_arr) <> 'array' THEN CONTINUE; END IF;

    IF v_ftype = 'multiselect' THEN
      EXECUTE format(
        'INSERT INTO public.%I (record_id, value) SELECT $1, value::text FROM jsonb_array_elements_text($2)',
        v_table || '__' || v_fname
      ) USING p_id, v_arr;
    ELSIF v_ftype = 'lookup' THEN
      EXECUTE format(
        'INSERT INTO public.%I (record_id, target_record_id) SELECT $1, value::uuid FROM jsonb_array_elements_text($2) WHERE value <> ''''',
        v_table || '__' || v_fname
      ) USING p_id, v_arr;
    ELSIF v_ftype = 'table' THEN
      v_row_index := 0;
      FOR v_row IN SELECT * FROM jsonb_array_elements(v_arr) LOOP
        EXECUTE format(
          'INSERT INTO public.%I (record_id, row_index, %s) VALUES ($1, $2, %s)',
          v_table || '__' || v_fname,
          public.freeze_table_columns_dml(v_field->'table_columns', false),
          public.freeze_table_columns_dml(v_field->'table_columns', true)
        ) USING p_id, v_row_index, v_row;
        v_row_index := v_row_index + 1;
      END LOOP;
    END IF;
  END LOOP;
END;
$fn$;

-- Helper for table-field DML: returns either the column-list or the
-- VALUES expression (referencing $3 = the row jsonb).
CREATE OR REPLACE FUNCTION public.freeze_table_columns_dml(p_columns jsonb, p_values boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  v_col   jsonb;
  v_name  text;
  v_type  text;
  v_out   text := '';
BEGIN
  IF p_columns IS NULL OR jsonb_typeof(p_columns) <> 'array' THEN
    RETURN '';
  END IF;
  FOR v_col IN SELECT * FROM jsonb_array_elements(p_columns) LOOP
    v_name := v_col->>'name';
    v_type := v_col->>'type';
    IF v_name IS NULL OR v_name = '' THEN CONTINUE; END IF;
    IF v_out <> '' THEN v_out := v_out || ', '; END IF;
    IF p_values THEN
      IF v_type IN ('number', 'currency', 'formula') THEN
        v_out := v_out || format('public.try_numeric($3->>%L)', v_name);
      ELSIF v_type = 'date' THEN
        v_out := v_out || format('public.try_timestamptz($3->>%L)', v_name);
      ELSE
        v_out := v_out || format('$3->>%L', v_name);
      END IF;
    ELSE
      v_out := v_out || format('%I', v_name);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- freeze_model: the orchestrator. Runs as a single transaction (the
-- function itself is invoked via Supabase RPC, which auto-wraps in a
-- transaction). Aborts on any coercion failure or DDL error so the
-- model stays in its pre-freeze state.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.freeze_model(p_model_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model       record;
  v_table       text;
  v_columns     text := '';
  v_field       jsonb;
  v_fname       text;
  v_ftype       text;
  v_is_multi    boolean;
  v_failures    int;
  v_record_count int;
  v_seq_name    text;
  v_max_num     bigint;
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found', p_model_id;
  END IF;
  IF v_model.is_hardcoded THEN
    RAISE EXCEPTION 'model "%" is already frozen', v_model.name;
  END IF;
  IF NOT public.is_freezable_model(v_model.name) THEN
    RAISE EXCEPTION 'model "%" is not freezable (custom-UI model)', v_model.name;
  END IF;

  v_table := public.freeze_safe_ident(v_model.name);

  -- Fail loudly if a table by this name already exists from a prior
  -- aborted freeze — the user needs to drop it manually before retrying.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = v_table
  ) THEN
    RAISE EXCEPTION 'table public.% already exists — drop it before re-freezing', v_table;
  END IF;

  -- Coercion check — abort with details if any rows fail.
  SELECT count(*) INTO v_failures FROM public.freeze_check_coercion(p_model_id);
  IF v_failures > 0 THEN
    RAISE EXCEPTION 'freeze aborted: % records have coercion failures (call freeze_check_coercion to see them)', v_failures;
  END IF;

  -- Build CREATE TABLE column list from the schema.
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    PERFORM public.freeze_safe_ident(v_fname);

    IF v_columns <> '' THEN v_columns := v_columns || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_columns := v_columns || format(
        '%I numeric, %I numeric',
        v_fname || '_min', v_fname || '_max'
      );
    ELSIF v_ftype IN ('number', 'currency', 'formula') THEN
      v_columns := v_columns || format('%I numeric', v_fname);
    ELSIF v_ftype IN ('date', 'datetime') THEN
      v_columns := v_columns || format('%I timestamptz', v_fname);
    ELSIF v_ftype = 'checkbox' THEN
      v_columns := v_columns || format('%I boolean', v_fname);
    ELSIF v_ftype IN ('notes', 'section_mirror', 'section_selector', 'assignee') THEN
      v_columns := v_columns || format('%I jsonb', v_fname);
    ELSE
      v_columns := v_columns || format('%I text', v_fname);
    END IF;
  END LOOP;

  -- CREATE TABLE. `created_by_user_id` is the same column the records
  -- table grew in Phase 1 RLS — frozen tables carry it forward so the
  -- `created_by` scope target keeps working after a model is frozen.
  --
  -- gen_random_uuid() is built into Postgres core (PG 13+); we use it
  -- instead of the uuid-ossp `uuid_generate_v4()` because this function
  -- has `SET search_path = public` and uuid-ossp lives in `extensions`,
  -- which would otherwise be unreachable inside dynamic SQL.
  EXECUTE format(
    'CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), %s, created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())',
    v_table,
    CASE WHEN v_columns = '' THEN 'placeholder_unused boolean' ELSE v_columns END
  );

  -- updated_at trigger
  EXECUTE format(
    'CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
    v_table, v_table
  );

  -- RLS — mirror the records-table policies so the per-model + scope
  -- access controls survive freezing. The actual policy bodies live on
  -- a per-table SELECT/INSERT/UPDATE/DELETE policy and call the shared
  -- `wassell_can_*_jsonb` helpers, which build a synthetic `records`
  -- row from the frozen-table columns and delegate to the existing
  -- `wassell_record_passes_scope` evaluator.
  --
  -- The policies are (re)generated inside `regenerate_frozen_model_artifacts`
  -- so they refresh whenever the schema changes. Here we only enable RLS
  -- + grant base privileges; policies land further down via the regen call.
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_table);

  -- Junction + subtables for multi-value fields.
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF NOT public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    PERFORM public.freeze_safe_ident(v_fname);

    IF v_ftype = 'multiselect' THEN
      EXECUTE format(
        'CREATE TABLE public.%I (record_id uuid NOT NULL REFERENCES public.%I(id) ON DELETE CASCADE, value text NOT NULL, PRIMARY KEY (record_id, value))',
        v_table || '__' || v_fname, v_table
      );
    ELSIF v_ftype = 'lookup' THEN
      EXECUTE format(
        'CREATE TABLE public.%I (record_id uuid NOT NULL REFERENCES public.%I(id) ON DELETE CASCADE, target_record_id uuid NOT NULL, PRIMARY KEY (record_id, target_record_id))',
        v_table || '__' || v_fname, v_table
      );
    ELSIF v_ftype = 'table' THEN
      -- Subtable: row_index for ordering, plus one column per table-column.
      -- gen_random_uuid() (built-in) instead of uuid_generate_v4() because
      -- this function's search_path doesn't include extensions schema.
      EXECUTE format(
        'CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES public.%I(id) ON DELETE CASCADE, row_index int NOT NULL, %s, created_at timestamptz NOT NULL DEFAULT now())',
        v_table || '__' || v_fname,
        v_table,
        public.freeze_build_table_subtable_columns(v_field->'table_columns')
      );
      EXECUTE format(
        'CREATE INDEX %I ON public.%I (record_id, row_index)',
        'idx_' || v_table || '__' || v_fname || '_record', v_table || '__' || v_fname
      );
    END IF;

    -- RLS on the junction/subtable: a row is reachable iff the parent
    -- record is reachable. We enforce this by joining back to the parent
    -- and reusing its policy via `EXISTS (SELECT FROM <parent> WHERE id = record_id)`.
    -- The parent table's policy already calls wassell_can_*_jsonb, so
    -- the per-model + scope checks compose. Without this guard a non-
    -- admin with view perm on the model could read multiselect values
    -- for records the parent policy excludes.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table || '__' || v_fname);
    EXECUTE format(
      'CREATE POLICY "frozen_junction_view" ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.%I p WHERE p.id = record_id))',
      v_table || '__' || v_fname, v_table
    );
    EXECUTE format(
      'CREATE POLICY "frozen_junction_write" ON public.%I FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.%I p WHERE p.id = record_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.%I p WHERE p.id = record_id))',
      v_table || '__' || v_fname, v_table, v_table
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_table || '__' || v_fname);
  END LOOP;

  -- Sequences for each auto_id field. Set the next value above any
  -- existing numeric portion so future inserts don't collide.
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
    WHERE field->>'type' = 'auto_id'
  LOOP
    v_fname    := v_field->>'name';
    v_seq_name := v_table || '__' || v_fname || '_seq';

    -- Pluck the trailing integer out of any existing auto_id values
    -- like "CLT-0042" → 42 to seed the sequence above the high water mark.
    EXECUTE format(
      $q$SELECT COALESCE(max((regexp_replace(data->>%L, '^.*?(\d+)$', '\1'))::bigint), 0)
         FROM records WHERE model_id = $1
           AND data->>%L ~ '\d+'$q$,
      v_fname, v_fname
    ) USING p_model_id INTO v_max_num;

    EXECUTE format('CREATE SEQUENCE public.%I START WITH %s', v_seq_name, GREATEST(v_max_num + 1, 1));
    EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO authenticated', v_seq_name);
  END LOOP;

  -- Mark the model frozen FIRST so the records-guard trigger picks it up,
  -- then copy data, then drop the legacy v_<name> view, then regen artifacts.
  UPDATE models SET is_hardcoded = true, table_name = v_table WHERE id = p_model_id;

  -- Copy data: parent table first, then junctions/subtables.
  PERFORM public.freeze_copy_records(p_model_id);

  -- Drop the legacy records-based view (replaced by <name>_v).
  EXECUTE format('DROP VIEW IF EXISTS public.%I', 'v_' || v_table);

  -- Generate the JSONB-shape view + per-model save RPC.
  PERFORM public.regenerate_frozen_model_artifacts(p_model_id);

  -- Delete the original JSONB rows from records — they're now in the
  -- frozen table.
  SELECT count(*) INTO v_record_count FROM records WHERE model_id = p_model_id;
  DELETE FROM records WHERE model_id = p_model_id;

  -- Rebuild the unified_records UNION view.
  PERFORM public.rebuild_unified_records();

  RETURN jsonb_build_object(
    'model_id',     p_model_id,
    'model_name',   v_model.name,
    'table_name',   v_table,
    'rows_copied',  v_record_count,
    'frozen_at',    now()
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.freeze_model(uuid) TO authenticated;

-- Subtable column-list builder for the CREATE TABLE in freeze_model.
CREATE OR REPLACE FUNCTION public.freeze_build_table_subtable_columns(p_columns jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  v_col  jsonb;
  v_name text;
  v_type text;
  v_out  text := '';
BEGIN
  IF p_columns IS NULL OR jsonb_typeof(p_columns) <> 'array' THEN
    RETURN 'placeholder_unused boolean';
  END IF;
  FOR v_col IN SELECT * FROM jsonb_array_elements(p_columns) LOOP
    v_name := v_col->>'name';
    v_type := v_col->>'type';
    IF v_name IS NULL OR v_name = '' THEN CONTINUE; END IF;
    PERFORM public.freeze_safe_ident(v_name);
    IF v_out <> '' THEN v_out := v_out || ', '; END IF;
    IF v_type IN ('number', 'currency', 'formula') THEN
      v_out := v_out || format('%I numeric', v_name);
    ELSIF v_type = 'date' THEN
      v_out := v_out || format('%I timestamptz', v_name);
    ELSE
      v_out := v_out || format('%I text', v_name);
    END IF;
  END LOOP;
  IF v_out = '' THEN v_out := 'placeholder_unused boolean'; END IF;
  RETURN v_out;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- freeze_copy_records: pulls every records.data row for this model and
-- writes it into the new frozen table (parent + junctions + subtables).
-- Called from freeze_model AFTER the table exists and the model is
-- flagged frozen (so the records-guard trigger doesn't block the
-- intermediate INSERTs we're about to do here).
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.freeze_copy_records(p_model_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model record;
  v_table text;
  v_rec   record;
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND OR NOT v_model.is_hardcoded THEN RETURN; END IF;
  v_table := public.freeze_safe_ident(v_model.name);

  FOR v_rec IN
    SELECT id, data, created_by_user_id, created_at, updated_at
      FROM records WHERE model_id = p_model_id
  LOOP
    -- Insert the parent row with timestamps + creator stamp preserved.
    EXECUTE format(
      'INSERT INTO public.%I (id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4)',
      v_table
    ) USING v_rec.id, v_rec.created_by_user_id, v_rec.created_at, v_rec.updated_at;

    -- Apply the JSONB payload (scalar columns + junctions + subtables).
    -- We pass NULL for p_created_by because the parent INSERT above
    -- already set the column; freeze_apply_row's COALESCE keeps it.
    PERFORM public.freeze_apply_row(p_model_id, v_rec.id, v_rec.data, NULL);
  END LOOP;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- rebuild_unified_records: a UNION ALL view of the unified records
-- table with each frozen model's JSONB-shape view. Every server-side
-- caller that previously read from `records` reads from this instead;
-- the shape is identical (id, model_id, data, created_at, updated_at).
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_unified_records()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_sql       text := 'SELECT id, model_id, data, created_by_user_id, created_at, updated_at FROM public.records';
  v_model     record;
  v_view_name text;
BEGIN
  FOR v_model IN SELECT name FROM models WHERE is_hardcoded = true ORDER BY name LOOP
    v_view_name := public.freeze_safe_ident(v_model.name) || '_v';
    -- Defensive: the view may not exist if a manual cleanup is in progress.
    IF EXISTS (
      SELECT 1 FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = v_view_name
    ) THEN
      v_sql := v_sql || format(' UNION ALL SELECT id, model_id, data, created_by_user_id, created_at, updated_at FROM public.%I', v_view_name);
    END IF;
  END LOOP;

  -- DROP first because we widened the column list (added created_by_user_id);
  -- CREATE OR REPLACE VIEW refuses column changes.
  EXECUTE 'DROP VIEW IF EXISTS public.unified_records';
  EXECUTE 'CREATE VIEW public.unified_records WITH (security_invoker = true) AS ' || v_sql;
  EXECUTE 'GRANT SELECT ON public.unified_records TO authenticated, anon, service_role';
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- Frozen-table RLS helpers — accept a JSONB payload so per-frozen-table
-- policies can build a synthetic `records` row from columns and reuse
-- the existing scope evaluator.
-- ────────────────────────────────────────────────────────────────────

-- The two helpers below need to construct a synthetic `records` row to
-- pass into `wassell_record_passes_scope`. We CANNOT use ROW(...)::records
-- because that's POSITIONAL — and the actual column order in production
-- depends on whether `created_by_user_id` was added via the CREATE TABLE
-- (column 4) or via the `ADD COLUMN IF NOT EXISTS` ALTER (appended to the
-- end). On installs where the column was ALTER-added, position 4 is
-- `created_at` (timestamptz) and our positional UUID would fail to cast.
--
-- `jsonb_populate_record` matches columns BY NAME, so it works regardless
-- of physical column order. Timestamps default to NULL — the scope
-- evaluator only reads model_id, data, and created_by_user_id off the row.

CREATE OR REPLACE FUNCTION public.wassell_can_view_jsonb(
  auth_user_id   UUID,
  the_model_id   UUID,
  the_id         UUID,
  the_created_by UUID,
  the_data       JSONB
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.wassell_user_has_action(auth_user_id, the_model_id, 'view')
    AND public.wassell_record_passes_scope(
          jsonb_populate_record(NULL::records, jsonb_build_object(
            'id',                 the_id,
            'model_id',           the_model_id,
            'data',               the_data,
            'created_by_user_id', the_created_by
          )),
          auth_user_id, 'view'
        );
$$;

CREATE OR REPLACE FUNCTION public.wassell_can_edit_jsonb(
  auth_user_id   UUID,
  the_model_id   UUID,
  the_id         UUID,
  the_created_by UUID,
  the_data       JSONB
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.wassell_user_has_action(auth_user_id, the_model_id, 'edit')
    AND public.wassell_record_passes_scope(
          jsonb_populate_record(NULL::records, jsonb_build_object(
            'id',                 the_id,
            'model_id',           the_model_id,
            'data',               the_data,
            'created_by_user_id', the_created_by
          )),
          auth_user_id, 'view'
        )
    AND public.wassell_record_passes_scope(
          jsonb_populate_record(NULL::records, jsonb_build_object(
            'id',                 the_id,
            'model_id',           the_model_id,
            'data',               the_data,
            'created_by_user_id', the_created_by
          )),
          auth_user_id, 'edit'
        );
$$;

GRANT EXECUTE ON FUNCTION public.wassell_can_view_jsonb(UUID, UUID, UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_edit_jsonb(UUID, UUID, UUID, UUID, JSONB) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- record_save / record_delete: dispatchers used by server-side endpoints
-- and the app store. Branch on is_hardcoded so callers don't need to
-- know whether a model is frozen. For unfrozen models, fall through to
-- the records JSONB table; for frozen, dispatch to the per-model save.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id   uuid,
  p_id         uuid,
  p_data       jsonb,
  p_created_by uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model record;
  v_table text;
BEGIN
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found', p_model_id;
  END IF;

  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    -- Ensure parent row exists, then apply scalar columns + junctions.
    EXECUTE format(
      'INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      v_table
    ) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by);
  ELSE
    -- Phase-1 RLS column on records: stamp creator on first save,
    -- preserve on subsequent updates. Same COALESCE posture as
    -- freeze_apply_row above and saveRecord in the frontend store.
    INSERT INTO records (id, model_id, data, created_by_user_id)
    VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id),
      updated_at = now();
  END IF;
  RETURN p_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_delete(p_model_id uuid, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model record;
BEGIN
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found', p_model_id;
  END IF;

  IF v_model.is_hardcoded THEN
    EXECUTE format(
      'DELETE FROM public.%I WHERE id = $1',
      public.freeze_safe_ident(v_model.name)
    ) USING p_id;
  ELSE
    DELETE FROM records WHERE id = p_id AND model_id = p_model_id;
  END IF;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.record_delete(uuid, uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- Guard trigger on `records`: prevents accidental writes targeting a
-- frozen model. The dispatcher RPCs route correctly; this catches any
-- forgotten direct .from('records').upsert() in legacy code paths so
-- they fail loudly instead of silently writing to a table the app no
-- longer reads.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.records_block_frozen_writes()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_frozen boolean;
  v_name   text;
BEGIN
  SELECT is_hardcoded, name INTO v_frozen, v_name FROM models WHERE id = NEW.model_id;
  IF v_frozen THEN
    RAISE EXCEPTION 'model "%" is frozen — write via record_save() RPC, not records table directly', v_name
      USING HINT = 'Frozen models live in their own table. The dispatcher RPC handles routing.';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_block_frozen_writes ON public.records;
CREATE TRIGGER records_block_frozen_writes
BEFORE INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.records_block_frozen_writes();

-- ────────────────────────────────────────────────────────────────────
-- View-sync trigger: skip frozen models so the legacy v_<name> view
-- isn't recreated over an empty records slice after a freeze.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.regenerate_model_view(p_model_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_model       record;
  v_view_name   text;
  v_field       jsonb;
  v_fname       text;
  v_ftype       text;
  v_parts       text[] := ARRAY['id', 'created_at', 'updated_at', 'model_id'];
  v_sql         text;
BEGIN
  SELECT id, name, schema, is_hardcoded INTO v_model FROM public.models WHERE id = p_model_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- Frozen models have their own <name>_v JSONB-shape view; skip the
  -- legacy records-based v_<name>.
  IF v_model.is_hardcoded THEN RETURN; END IF;
  v_view_name := 'v_' || v_model.name;
  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    -- Virtual / derived field types: no stored value, skip in views.
    IF v_ftype IN ('whatsapp_history', 'call_history') THEN CONTINUE; END IF;
    IF v_ftype = 'range' THEN
      v_parts := v_parts || format('public.try_numeric(data->%L->>''min'') AS %I', v_fname, v_fname || '_min');
      v_parts := v_parts || format('public.try_numeric(data->%L->>''max'') AS %I', v_fname, v_fname || '_max');
    ELSIF v_ftype IN ('number', 'currency', 'formula') THEN
      v_parts := v_parts || format('public.try_numeric(data->>%L) AS %I', v_fname, v_fname);
    ELSIF v_ftype IN ('date', 'datetime') THEN
      v_parts := v_parts || format('public.try_timestamptz(data->>%L) AS %I', v_fname, v_fname);
    ELSIF v_ftype = 'checkbox' THEN
      v_parts := v_parts || format('public.try_boolean(data->>%L) AS %I', v_fname, v_fname);
    ELSIF v_ftype IN ('multiselect', 'table', 'notes') THEN
      v_parts := v_parts || format('(data->%L) AS %I', v_fname, v_fname);
    ELSE
      v_parts := v_parts || format('(data->>%L) AS %I', v_fname, v_fname);
    END IF;
  END LOOP;
  -- DROP first because CREATE OR REPLACE VIEW only allows ADDING columns
  -- at the end. When a model's schema changes (a field is renamed,
  -- removed, or its type changes the column-list shape), the new view
  -- has a different column list and the replace fails with
  -- `cannot drop columns from view`.
  v_sql := format(
    'DROP VIEW IF EXISTS public.%I; CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT %s FROM public.records WHERE model_id = %L',
    v_view_name, v_view_name, array_to_string(v_parts, ', '), v_model.id
  );
  EXECUTE v_sql;
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon, service_role', v_view_name);
END;
$fn$;

-- Initial unified_records view — empty UNION on fresh installs is just
-- `SELECT FROM records`. Re-run is idempotent.
SELECT public.rebuild_unified_records();

-- ============================================================
-- POST-2026-05-06 — PHASES A–G architecture refactor
-- ============================================================
-- Source-of-truth snapshot for the migrations under
-- supabase/migrations/2026-05-06_a* through 2026-05-07_*. Re-runnable
-- and idempotent. Safe to apply against any state of the DB; effects
-- match the migrations applied in order.
--
-- Phase A — DB hygiene (indexes, init-plan wraps, search_path,
--   replica identity)
-- Phase B — Function-execute revokes + RLS policy split + always-true
--   tightening
-- Phase C — Realtime publication expansion
-- Phase E — record_search RPC for cursor pagination
-- Phase F — auto_id_counters + records.version optimistic concurrency
-- Phase G — Slow-query telemetry
--
-- A.1 init-plan wraps and A.2 FK indexes are already inlined above
-- (they updated existing CREATE POLICY / CREATE INDEX sites in place).
-- ============================================================

-- ── A.3 — records query indexes ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_records_model_id_created_at
  ON public.records (model_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_records_updated_at
  ON public.records (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_data_gin
  ON public.records USING gin (data jsonb_path_ops);

-- ── A.5 + C.2 — REPLICA IDENTITY for realtime tables ─────────
ALTER TABLE public.chat_messages       REPLICA IDENTITY FULL;
ALTER TABLE public.call_logs           REPLICA IDENTITY FULL;
ALTER TABLE public.models              REPLICA IDENTITY FULL;
ALTER TABLE public.model_groups        REPLICA IDENTITY FULL;
ALTER TABLE public.workflows           REPLICA IDENTITY FULL;
ALTER TABLE public.workflow_groups     REPLICA IDENTITY FULL;
ALTER TABLE public.dashboards          REPLICA IDENTITY FULL;
ALTER TABLE public.model_views         REPLICA IDENTITY FULL;
ALTER TABLE public.profiles            REPLICA IDENTITY FULL;
ALTER TABLE public.roles               REPLICA IDENTITY FULL;
ALTER TABLE public.users               REPLICA IDENTITY FULL;
-- High-volume tables (records, workflow_runs) keep DEFAULT (PK-only):
-- whole-row WAL on every UPDATE would be punishing at scale; merge
-- handlers refetch by id when needed.

-- ── C.1 — supabase_realtime publication membership ───────────
DO $$
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'records', 'models', 'model_groups', 'workflows', 'workflow_groups',
      'workflow_runs', 'dashboards', 'model_views', 'profiles', 'roles', 'users'
    ]) AS name
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t.name);
    EXCEPTION WHEN duplicate_object THEN
      -- Already in the publication — re-run is fine.
      NULL;
    END;
  END LOOP;
END$$;

-- ── B.1 + B.2 — REVOKE EXECUTE FROM PUBLIC, re-grant explicitly ──
-- See migrations/2026-05-06_b1_b2_revoke_definer_execute.sql header
-- for the rationale. Postgres grants EXECUTE to PUBLIC by default for
-- every new function; we strip it and re-grant only what should be
-- callable by authenticated/anon.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_public_dashboard(text) TO anon;
GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_delete(uuid, uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_dashboard(text)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_app_user_id(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_is_admin(uuid)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_view_workflows(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_user_has_action(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_record_passes_scope(records, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_view_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_edit_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_create_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_delete_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_view_jsonb(uuid, uuid, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_edit_jsonb(uuid, uuid, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_boolean(text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_numeric(text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_timestamptz(text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_all_projects(uuid, numeric, numeric, text, text, text, text, numeric, numeric, text, integer) TO authenticated;

-- ── B.3 — Tighten activity_log RLS ────────────────────────────
DROP POLICY IF EXISTS "Authenticated full access" ON public.activity_log;
DROP POLICY IF EXISTS activity_log_select ON public.activity_log;
DROP POLICY IF EXISTS activity_log_insert ON public.activity_log;
DROP POLICY IF EXISTS activity_log_delete ON public.activity_log;
CREATE POLICY activity_log_select ON public.activity_log FOR SELECT TO authenticated
  USING (
    public.wassell_is_admin((SELECT auth.uid()))
    OR actor_user_id = public.wassell_app_user_id((SELECT auth.uid()))
  );
CREATE POLICY activity_log_insert ON public.activity_log FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_is_admin((SELECT auth.uid()))
    OR actor_user_id = public.wassell_app_user_id((SELECT auth.uid()))
  );
-- No UPDATE policy: audit log entries are immutable.
CREATE POLICY activity_log_delete ON public.activity_log FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── B.4 — Split *_write FOR ALL into INSERT / UPDATE / DELETE ─
-- Dedupes "multiple permissive policies" perf-lint hits.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['field_templates','model_groups','models','profiles','roles']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))',
      t, t);
    EXECUTE format(
      'CREATE POLICY %I_update ON public.%I FOR UPDATE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid()))) WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))',
      t, t);
    EXECUTE format(
      'CREATE POLICY %I_delete ON public.%I FOR DELETE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))',
      t, t);
  END LOOP;
END$$;

DROP POLICY IF EXISTS users_write ON public.users;
DROP POLICY IF EXISTS users_insert ON public.users;
DROP POLICY IF EXISTS users_update ON public.users;
DROP POLICY IF EXISTS users_delete ON public.users;
CREATE POLICY users_insert ON public.users FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()));
CREATE POLICY users_update ON public.users FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()));
CREATE POLICY users_delete ON public.users FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS model_views_write ON public.model_views;
DROP POLICY IF EXISTS model_views_insert ON public.model_views;
DROP POLICY IF EXISTS model_views_update ON public.model_views;
DROP POLICY IF EXISTS model_views_delete ON public.model_views;
CREATE POLICY model_views_insert ON public.model_views FOR INSERT TO authenticated
  WITH CHECK (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
CREATE POLICY model_views_update ON public.model_views FOR UPDATE TO authenticated
  USING (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  )
  WITH CHECK (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
CREATE POLICY model_views_delete ON public.model_views FOR DELETE TO authenticated
  USING (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );

-- Frozen-model junction tables created prior to B.4 use the unified
-- frozen_junction_write FOR ALL pattern. Split that on the two known
-- junctions; future freezes will still emit the older pattern until
-- regenerate_frozen_model_artifacts is updated.
DO $$
DECLARE jn text;
BEGIN
  FOREACH jn IN ARRAY ARRAY['marketing_operations__facts','marketing_operations__sources']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS frozen_junction_write ON public.%I', jn);
    EXECUTE format(
      'CREATE POLICY frozen_junction_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id))',
      jn);
    EXECUTE format(
      'CREATE POLICY frozen_junction_update ON public.%I FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id))',
      jn);
    EXECUTE format(
      'CREATE POLICY frozen_junction_delete ON public.%I FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id))',
      jn);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  -- Either junction may not exist in fresh installs without the
  -- frozen marketing_operations model yet — fine.
  NULL;
END$$;

-- ── B follow-up — Tighten 11 always-true policies ─────────────
-- chat_messages, call_logs, webhook_payloads: SELECT-for-authenticated
-- only. Webhooks write via service_role bypassing RLS.
DROP POLICY IF EXISTS "Authenticated full access" ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_select ON public.chat_messages;
CREATE POLICY chat_messages_select ON public.chat_messages FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated full access" ON public.call_logs;
DROP POLICY IF EXISTS call_logs_select ON public.call_logs;
CREATE POLICY call_logs_select ON public.call_logs FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated full access" ON public.webhook_payloads;
DROP POLICY IF EXISTS webhook_payloads_select ON public.webhook_payloads;
DROP POLICY IF EXISTS webhook_payloads_consume_update ON public.webhook_payloads;
CREATE POLICY webhook_payloads_select ON public.webhook_payloads FOR SELECT TO authenticated USING (true);
CREATE POLICY webhook_payloads_consume_update ON public.webhook_payloads FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- competitors / posts / reels / research_questions — admin write,
-- authenticated read.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['competitors','posts','reels']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated full access" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))', t, t);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid()))) WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))', t, t);
    EXECUTE format('CREATE POLICY %I_delete ON public.%I FOR DELETE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t, t);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END$$;

DROP POLICY IF EXISTS "Authenticated full access" ON public.research_questions;
DROP POLICY IF EXISTS research_questions_select ON public.research_questions;
DROP POLICY IF EXISTS research_questions_insert ON public.research_questions;
DROP POLICY IF EXISTS research_questions_update ON public.research_questions;
DROP POLICY IF EXISTS research_questions_delete ON public.research_questions;
CREATE POLICY research_questions_select ON public.research_questions FOR SELECT TO authenticated USING (true);
CREATE POLICY research_questions_insert ON public.research_questions FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY research_questions_update ON public.research_questions FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR answered_by = public.wassell_app_user_id((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR answered_by = public.wassell_app_user_id((SELECT auth.uid())));
CREATE POLICY research_questions_delete ON public.research_questions FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- Settings: webhook_slugs, whatsapp_numbers — admin write,
-- authenticated read.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_slugs','whatsapp_numbers']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated full access" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))', t, t);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid()))) WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))', t, t);
    EXECUTE format('CREATE POLICY %I_delete ON public.%I FOR DELETE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t, t);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END$$;

-- Per-user notifications.
DROP POLICY IF EXISTS "Authenticated full access" ON public.marketing_notifications;
DROP POLICY IF EXISTS marketing_notifications_select ON public.marketing_notifications;
DROP POLICY IF EXISTS marketing_notifications_insert ON public.marketing_notifications;
DROP POLICY IF EXISTS marketing_notifications_update ON public.marketing_notifications;
DROP POLICY IF EXISTS marketing_notifications_delete ON public.marketing_notifications;
CREATE POLICY marketing_notifications_select ON public.marketing_notifications FOR SELECT TO authenticated
  USING (user_id = public.wassell_app_user_id((SELECT auth.uid())) OR public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY marketing_notifications_insert ON public.marketing_notifications FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY marketing_notifications_update ON public.marketing_notifications FOR UPDATE TO authenticated
  USING (user_id = public.wassell_app_user_id((SELECT auth.uid())) OR public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (user_id = public.wassell_app_user_id((SELECT auth.uid())) OR public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY marketing_notifications_delete ON public.marketing_notifications FOR DELETE TO authenticated
  USING (user_id = public.wassell_app_user_id((SELECT auth.uid())) OR public.wassell_is_admin((SELECT auth.uid())));

-- Deprecated WA tables — admin-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wa_conversations','wa_errors','wa_leads']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated full access" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_admin ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_admin ON public.%I FOR ALL TO authenticated USING (public.wassell_is_admin((SELECT auth.uid()))) WITH CHECK (public.wassell_is_admin((SELECT auth.uid())))', t, t);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END$$;

-- ── E.1 — record_search RPC (cursor pagination, RLS-aware) ────
-- SECURITY INVOKER so RLS applies. Returns a page with has_more flag.
CREATE OR REPLACE FUNCTION public.record_search(
  p_model_id   uuid,
  p_filters    jsonb DEFAULT '{}'::jsonb,
  p_cursor     jsonb DEFAULT NULL,
  p_limit      int   DEFAULT 50,
  p_search_text text DEFAULT NULL
)
RETURNS TABLE (
  id           uuid,
  model_id     uuid,
  data         jsonb,
  created_by_user_id uuid,
  created_at   timestamptz,
  updated_at   timestamptz,
  has_more     boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cursor_created_at timestamptz;
  v_cursor_id         uuid;
  v_limit             int := GREATEST(1, LEAST(COALESCE(p_limit, 50), 500));
  v_fetched           int;
BEGIN
  IF p_cursor IS NOT NULL THEN
    v_cursor_created_at := (p_cursor->>'created_at')::timestamptz;
    v_cursor_id         := (p_cursor->>'id')::uuid;
  END IF;

  RETURN QUERY
  WITH page AS (
    SELECT u.id, u.model_id, u.data, u.created_by_user_id, u.created_at, u.updated_at
    FROM public.unified_records u
    WHERE u.model_id = p_model_id
      AND (p_filters = '{}'::jsonb OR u.data @> p_filters)
      AND (
        p_search_text IS NULL OR p_search_text = ''
        OR u.data::text ILIKE '%' || p_search_text || '%'
      )
      AND (
        v_cursor_created_at IS NULL
        OR (u.created_at, u.id) < (v_cursor_created_at, v_cursor_id)
      )
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT v_limit + 1
  ),
  counted AS (
    SELECT *, COUNT(*) OVER () AS total FROM page
  )
  SELECT
    c.id,
    c.model_id,
    c.data,
    c.created_by_user_id,
    c.created_at,
    c.updated_at,
    (c.total > v_limit) AS has_more
  FROM counted c
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT v_limit;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) TO service_role;

-- ── F.1 — auto_id_counters table + RPC ────────────────────────
-- Atomic INSERT…ON CONFLICT DO UPDATE…RETURNING avoids the read-modify-
-- write race that produced duplicate IDs in the client-side counter.
CREATE TABLE IF NOT EXISTS public.auto_id_counters (
  model_id    uuid    NOT NULL,
  field_id    uuid    NOT NULL,
  scope_key   text    NOT NULL DEFAULT '',
  current_value bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, field_id, scope_key)
);

ALTER TABLE public.auto_id_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auto_id_counters_admin ON public.auto_id_counters;
CREATE POLICY auto_id_counters_admin ON public.auto_id_counters FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

REVOKE ALL ON TABLE public.auto_id_counters FROM anon, PUBLIC;
GRANT SELECT ON TABLE public.auto_id_counters TO authenticated;

-- record_assign_auto_id signature is `int`, NOT bigint. The H-audit
-- migration (2026-05-07_h_audit_followups.sql) wraps this with a
-- permission check at the same int signature — they MUST match or
-- Postgres treats them as separate overloads and PostgREST's "Could
-- not choose the best candidate function" error blocks every save
-- with an auto_id field. The 2026-05-09_drop_auto_id_bigint_overload
-- migration drops the legacy bigint overload on existing installs.
-- Body reflects the deployed function: M13 permission gate
-- (2026-05-07_h_audit_followups.sql) + the 2026-06-01 self-heal
-- (2026-06-01_auto_id_selfheal_rpc.sql).
CREATE OR REPLACE FUNCTION public.record_assign_auto_id(
  p_model_id  uuid,
  p_field_id  uuid,
  p_scope_key text,
  p_start     int DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_value        int;
  v_field_name   text;
  v_max_existing bigint;
BEGIN
  -- M13: gate behind the same model-level 'create' permission that gates
  -- record creation, so a low-privilege user can't inflate counters.
  IF NOT public.wassell_user_has_action((SELECT auth.uid()), p_model_id, 'create') THEN
    RAISE EXCEPTION 'record_assign_auto_id: caller lacks create permission on model %', p_model_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Atomic increment: Postgres serializes the row-level op so two concurrent
  -- callers can never read the same value.
  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (p_model_id, p_field_id, COALESCE(p_scope_key, ''), GREATEST(p_start, 1))
  ON CONFLICT (model_id, field_id, scope_key) DO UPDATE
    SET current_value = public.auto_id_counters.current_value + 1,
        updated_at = now()
  RETURNING current_value INTO v_value;

  -- Self-heal: the atomic counter only stops two SIMULTANEOUS saves from
  -- colliding with each other; it does NOT stop the counter from drifting
  -- below ids already in use (import / duplicate / pre-filled saves never
  -- call this RPC). For the GLOBAL scope, never return a value at or below
  -- the highest numeric id already present in the model's records. Scoped
  -- counters are skipped (deriving per-row scope in SQL would duplicate the
  -- client slugify; every auto_id field today is global scope).
  IF COALESCE(p_scope_key, '') IN ('', '__global__') THEN
    SELECT (f->>'name') INTO v_field_name
    FROM public.models m
    CROSS JOIN LATERAL jsonb_array_elements(m.schema->'sections') s
    CROSS JOIN LATERAL jsonb_array_elements(s->'fields') f
    WHERE m.id = p_model_id AND (f->>'id') = p_field_id::text
    LIMIT 1;

    IF v_field_name IS NOT NULL THEN
      SELECT MAX(NULLIF(regexp_replace(ur.data->>v_field_name, '\D', '', 'g'), '')::bigint)
        INTO v_max_existing
      FROM public.unified_records ur
      WHERE ur.model_id = p_model_id;

      IF v_max_existing IS NOT NULL AND v_max_existing >= v_value THEN
        v_value := (v_max_existing + 1)::int;
        UPDATE public.auto_id_counters
           SET current_value = v_value, updated_at = now()
         WHERE model_id = p_model_id
           AND field_id = p_field_id
           AND scope_key = COALESCE(p_scope_key, '');
      END IF;
    END IF;
  END IF;

  RETURN v_value;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) TO service_role;

-- ── F.2 — records.version + bump trigger + record_save check ──
ALTER TABLE public.records ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.records_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.version = NEW.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_bump_version_trigger ON public.records;
CREATE TRIGGER records_bump_version_trigger
  BEFORE UPDATE ON public.records
  FOR EACH ROW
  EXECUTE FUNCTION public.records_bump_version();

-- New 5-arg record_save signature with optional version check. The
-- previous 4-arg signature is dropped to avoid overload ambiguity.
DROP FUNCTION IF EXISTS public.record_save(uuid, uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id        uuid,
  p_id              uuid,
  p_data            jsonb,
  p_created_by      uuid DEFAULT NULL,
  p_expected_version int DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_model record;
  v_table text;
  v_existing_version int;
BEGIN
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found', p_model_id;
  END IF;

  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format(
      'INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      v_table
    ) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by);
  ELSE
    IF p_expected_version IS NOT NULL THEN
      SELECT version INTO v_existing_version FROM records WHERE id = p_id;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        RAISE EXCEPTION
          'version_mismatch: record was edited by another user (loaded v%, current v%)',
          p_expected_version, v_existing_version
          USING ERRCODE = 'serialization_failure',
                HINT = 'reload the record to see latest changes';
      END IF;
    END IF;

    INSERT INTO records (id, model_id, data, created_by_user_id)
    VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id),
      updated_at = now();
  END IF;
  RETURN p_id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) TO service_role;

-- ── G.1 — Slow-query telemetry (admin-only) ───────────────────
CREATE OR REPLACE FUNCTION public.slow_query_log(
  p_threshold_ms numeric DEFAULT 1000,
  p_limit        int     DEFAULT 50
)
RETURNS TABLE(
  query    text,
  calls    bigint,
  total_ms numeric,
  mean_ms  numeric,
  max_ms   numeric,
  rows_returned bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NOT public.wassell_is_admin((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    s.query,
    s.calls,
    round(s.total_exec_time::numeric, 2) AS total_ms,
    round(s.mean_exec_time::numeric, 2)  AS mean_ms,
    round(s.max_exec_time::numeric, 2)   AS max_ms,
    s.rows AS rows_returned
  FROM pg_stat_statements s
  WHERE s.mean_exec_time > p_threshold_ms
  ORDER BY s.total_exec_time DESC
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.slow_query_log(numeric, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.slow_query_log(numeric, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.slow_query_log(numeric, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slow_query_log(numeric, int) TO service_role;

CREATE TABLE IF NOT EXISTS public.query_perf_snapshot (
  id          bigserial PRIMARY KEY,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  threshold_ms numeric NOT NULL,
  rows        jsonb   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_query_perf_snapshot_taken_at
  ON public.query_perf_snapshot(taken_at DESC);

ALTER TABLE public.query_perf_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS query_perf_snapshot_admin ON public.query_perf_snapshot;
CREATE POLICY query_perf_snapshot_admin ON public.query_perf_snapshot FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

REVOKE ALL ON TABLE public.query_perf_snapshot FROM anon;
GRANT SELECT, INSERT, DELETE ON TABLE public.query_perf_snapshot TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.query_perf_snapshot_id_seq TO authenticated;

CREATE OR REPLACE FUNCTION public.snapshot_slow_queries(
  p_threshold_ms numeric DEFAULT 1000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog, pg_temp
AS $fn$
DECLARE
  v_id   bigint;
  v_rows jsonb;
BEGIN
  IF NOT public.wassell_is_admin((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'query', query,
    'calls', calls,
    'total_ms', total_ms,
    'mean_ms', mean_ms,
    'max_ms', max_ms,
    'rows', rows_returned
  )), '[]'::jsonb)
  INTO v_rows
  FROM public.slow_query_log(p_threshold_ms, 100);

  INSERT INTO public.query_perf_snapshot (threshold_ms, rows)
  VALUES (p_threshold_ms, v_rows)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) TO service_role;
