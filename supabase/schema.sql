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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  is_public BOOLEAN NOT NULL DEFAULT false,
  public_token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  role_assignments JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- v1 policy: every authenticated user (staff) has full access to every table.
-- Public dashboards are the one exception: anon can SELECT a dashboard when
-- is_public = true so the /public/dashboard/:token page works without login.
--
-- Policies are dropped and recreated so re-running the script is safe.
-- ============================================================

ALTER TABLE models          ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_groups    ENABLE ROW LEVEL SECURITY;
ALTER TABLE records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards      ENABLE ROW LEVEL SECURITY;
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

CREATE POLICY "Authenticated full access" ON models          FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON model_groups    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON records         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON workflows       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON workflow_groups FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON workflow_runs   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON dashboards      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON model_views     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON users           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON profiles        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON roles           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON field_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Public dashboards: anonymous read access when is_public = true.
CREATE POLICY "Public dashboard read" ON dashboards FOR SELECT TO anon USING (is_public = true);

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
  kind                   TEXT NOT NULL,                    -- text | image | video | audio | document | sticker | location | template | ...
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
-- Replaces the old OMA Google Sheets system. Every marketing operation is
-- a request to generate content (reels and/or posts) for a project. The
-- pipeline runs: research → contradictions handshake (if any) → reels and
-- posts in parallel → ready_for_review → human edits → approved.
--
-- Orchestration lives in Supabase Edge Functions (marketing-research,
-- marketing-research-resume, marketing-content, marketing-reels,
-- marketing-posts). Agents callback into these tables using the service-role
-- key and bypass RLS. RLS is still enabled so the SPA can read/write for
-- authenticated staff.

CREATE TABLE IF NOT EXISTS competitors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('reel_script', 'post_example')),
  content     TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_competitors_type ON competitors(type);

CREATE TABLE IF NOT EXISTS marketing_operations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_record_id UUID NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'research_pending' CHECK (status IN (
                      'research_pending',
                      'research_in_progress',
                      'research_waiting_answers',
                      'research_complete',
                      'content_generating',
                      'ready_for_review',
                      'approved',
                      'failed'
                    )),
  reels_settings    JSONB,
  posts_settings    JSONB,
  research_output   JSONB,
  research_error    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (reels_settings IS NOT NULL OR posts_settings IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_marketing_operations_project ON marketing_operations(project_record_id);
CREATE INDEX IF NOT EXISTS idx_marketing_operations_status ON marketing_operations(status);
CREATE INDEX IF NOT EXISTS idx_marketing_operations_created ON marketing_operations(created_at DESC);

CREATE TABLE IF NOT EXISTS research_questions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_id     UUID NOT NULL REFERENCES marketing_operations(id) ON DELETE CASCADE,
  question_number  INT NOT NULL,
  question         TEXT NOT NULL,
  source_conflict  TEXT,
  answer           TEXT,
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'answered')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at      TIMESTAMPTZ,
  answered_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (operation_id, question_number)
);

CREATE INDEX IF NOT EXISTS idx_research_questions_operation ON research_questions(operation_id);

CREATE TABLE IF NOT EXISTS reels (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_id       UUID NOT NULL REFERENCES marketing_operations(id) ON DELETE CASCADE,
  project_record_id  UUID NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
  reel_number        INT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'writing', 'draft_ready', 'approved', 'published', 'failed'
                     )),
  type               TEXT,
  duration           TEXT,
  platform           TEXT,
  voiceover          TEXT,
  goal               TEXT,
  scenes             JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_id, reel_number)
);

CREATE INDEX IF NOT EXISTS idx_reels_operation ON reels(operation_id);
CREATE INDEX IF NOT EXISTS idx_reels_project ON reels(project_record_id);
CREATE INDEX IF NOT EXISTS idx_reels_status ON reels(status);

CREATE TABLE IF NOT EXISTS posts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_id       UUID NOT NULL REFERENCES marketing_operations(id) ON DELETE CASCADE,
  project_record_id  UUID NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
  post_number        INT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'writing', 'draft_ready', 'approved', 'published', 'failed'
                     )),
  type               TEXT,
  components         TEXT,
  visual             TEXT,
  usage              TEXT,
  title              TEXT,
  design_text_1      TEXT,
  design_text_2      TEXT,
  design_text_3      TEXT,
  caption            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_id, post_number)
);

CREATE INDEX IF NOT EXISTS idx_posts_operation ON posts(operation_id);
CREATE INDEX IF NOT EXISTS idx_posts_project ON posts(project_record_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);

CREATE TABLE IF NOT EXISTS marketing_notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN (
                  'research_waiting_answers',
                  'research_complete',
                  'content_ready_reels',
                  'content_ready_posts',
                  'operation_ready',
                  'operation_failed'
                )),
  message_ar    TEXT NOT NULL,
  message_en    TEXT NOT NULL,
  operation_id  UUID REFERENCES marketing_operations(id) ON DELETE CASCADE,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_notifications_user_unread ON marketing_notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_marketing_notifications_created ON marketing_notifications(created_at DESC);

-- updated_at triggers
DROP TRIGGER IF EXISTS set_updated_at_competitors ON competitors;
CREATE TRIGGER set_updated_at_competitors BEFORE UPDATE ON competitors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_marketing_operations ON marketing_operations;
CREATE TRIGGER set_updated_at_marketing_operations BEFORE UPDATE ON marketing_operations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_reels ON reels;
CREATE TRIGGER set_updated_at_reels BEFORE UPDATE ON reels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_posts ON posts;
CREATE TRIGGER set_updated_at_posts BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS — authenticated users full access (matches v1 policy).
ALTER TABLE competitors             ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_operations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_questions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON competitors;
DROP POLICY IF EXISTS "Authenticated full access" ON marketing_operations;
DROP POLICY IF EXISTS "Authenticated full access" ON research_questions;
DROP POLICY IF EXISTS "Authenticated full access" ON reels;
DROP POLICY IF EXISTS "Authenticated full access" ON posts;
DROP POLICY IF EXISTS "Authenticated full access" ON marketing_notifications;

CREATE POLICY "Authenticated full access" ON competitors             FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON marketing_operations    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON research_questions      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON reels                   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON posts                   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON marketing_notifications FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- search_all_projects — RPC used by the edge function search_projects tool.
-- Notes on the JSONB value shape (see src/data/seedModels.ts):
--   • city      — stored as the Arabic label, e.g. 'الرياض', 'جدة'
--   • district  — stored as the Arabic label, e.g. 'الياسمين', 'العارض'
--   • status    — English slug: 'off_plan' | 'under_construction' | 'ready'
--   • unit_type — custom field api_name 'item_mo4kz61h' (confirmed by owner)
--   • min_price / max_price — JSON numbers; cast through text with ::numeric.
--
-- Budget-overlap logic: a project matches the customer's budget range when
-- project.min_price <= customer.max_price AND project.max_price >= customer.min_price.
-- Missing bounds on either side become no-ops.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_all_projects(
  p_model_id   UUID,
  p_min_price  NUMERIC DEFAULT NULL,
  p_max_price  NUMERIC DEFAULT NULL,
  p_city       TEXT    DEFAULT NULL,
  p_district   TEXT    DEFAULT NULL,
  p_status     TEXT    DEFAULT NULL,
  p_unit_type  TEXT    DEFAULT NULL,
  p_min_size   NUMERIC DEFAULT NULL,   -- reserved for Phase 3 (size field api_name TBD)
  p_max_size   NUMERIC DEFAULT NULL,   -- reserved for Phase 3
  p_text_query TEXT    DEFAULT NULL,
  p_limit      INT     DEFAULT 5
) RETURNS TABLE (id UUID, data JSONB, score INT) AS $$
  SELECT r.id, r.data,
    ( (p_city       IS NULL OR r.data->>'city'           = p_city)::int
    + (p_district   IS NULL OR r.data->>'district'       = p_district)::int
    + (p_status     IS NULL OR r.data->>'project_status' = p_status)::int
    + (p_unit_type  IS NULL OR r.data->>'item_mo4kz61h'  = p_unit_type)::int
    + (p_min_price  IS NULL OR NULLIF(r.data->>'max_price','')::numeric >= p_min_price)::int
    + (p_max_price  IS NULL OR NULLIF(r.data->>'min_price','')::numeric <= p_max_price)::int
    + (p_text_query IS NULL OR r.data::text ILIKE '%'||p_text_query||'%')::int
    ) AS score
  FROM records r
  WHERE r.model_id = p_model_id
    AND (p_city       IS NULL OR r.data->>'city'           = p_city)
    AND (p_district   IS NULL OR r.data->>'district'       = p_district)
    AND (p_status     IS NULL OR r.data->>'project_status' = p_status)
    AND (p_unit_type  IS NULL OR r.data->>'item_mo4kz61h'  = p_unit_type)
    AND (p_max_price  IS NULL OR NULLIF(r.data->>'min_price','')::numeric <= p_max_price)
    AND (p_min_price  IS NULL OR NULLIF(r.data->>'max_price','')::numeric >= p_min_price)
    AND (p_text_query IS NULL OR r.data::text ILIKE '%'||p_text_query||'%')
  ORDER BY score DESC, r.updated_at DESC
  LIMIT p_limit;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- PRESENTATIONS (decks built by Claude Code templates)
-- ============================================================
-- A "template" is authored by the user in Claude Code (skill + slash
-- command + manifest) and surfaced in the app as a picker option. The
-- user picks a template + fills inputs, a row lands in presentation_jobs
-- with status='queued', and a local daemon (Phase 2) picks it up, runs
-- the Claude command, and writes back a Drive link.
--
-- Phase 1 installs the tables only — no daemon runs yet. Jobs stay in
-- 'queued' until the daemon ships.
-- ============================================================

CREATE TABLE IF NOT EXISTS presentation_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT UNIQUE NOT NULL,
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  description_ar TEXT,
  description_en TEXT,
  command TEXT NOT NULL,                                    -- legacy: slash command for the local daemon. user-authored templates use 'cloud:agent'.
  icon TEXT NOT NULL DEFAULT 'file-text',
  input_schema JSONB NOT NULL DEFAULT '[]'::jsonb,          -- PresentationInput[]
  record_binding JSONB,                                     -- { model_slug, optional } or NULL
  estimated_duration_seconds INT,
  is_available BOOLEAN NOT NULL DEFAULT true,               -- daemon flips false when manifest deleted
  manifest_path TEXT,                                       -- legacy daemon: filesystem path on the daemon host. NULL for seed + user-authored templates.
  manifest_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Phase 2 (cloud worker era) — authored in-app via /presentations/templates.
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,                 -- string[] of tool names (web_search, web_fetch, code_execution, record_lookup, drive_upload)
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,                 -- TemplateStep[] — ordered pipeline (research → outline → build → review)
  is_user_authored BOOLEAN NOT NULL DEFAULT false,          -- true for templates created via the in-app builder; false for daemon-synced + seed
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- user who created the template (null for daemon-synced + seed)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent ALTER for existing prod DBs (Phase 2 columns added 2026-04-26).
-- Postgres 9.6+ supports ADD COLUMN IF NOT EXISTS.
ALTER TABLE presentation_templates
  ADD COLUMN IF NOT EXISTS tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_user_authored BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS presentation_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES presentation_templates(id) ON DELETE RESTRICT,
  template_slug TEXT NOT NULL,                              -- denormalized for reads after template deletion
  template_snapshot JSONB NOT NULL,                         -- frozen manifest at queue time
  record_id UUID REFERENCES records(id) ON DELETE SET NULL,
  record_model_id UUID REFERENCES models(id) ON DELETE SET NULL,
  record_snapshot JSONB,                                    -- frozen record data at queue time (for replay/debug)
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_dedup_key TEXT,                                    -- SHA-256(template_id + record_id + inputs)
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','canceled')),
  progress_stage TEXT,                                      -- 'paseetah' | 'research' | 'build' | 'review' | 'upload' | free-form
  progress_message_ar TEXT,
  progress_message_en TEXT,
  claimed_by TEXT,                                          -- '<hostname>:<pid>' of daemon that owns the run
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  -- Result payload — the full sentinel JSON the command emitted
  result JSONB,
  drive_folder_url TEXT,                                    -- extracted from result for fast list queries
  drive_deck_url TEXT,                                      -- ditto
  -- Phase 3 — per-step state populated by the cloud worker as it walks
  -- `template.steps`. One entry per step in the template's pipeline; status
  -- progresses pending → running → completed/failed. Empty array for legacy
  -- jobs run by the local daemon.
  step_outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Error info
  error_code TEXT,                                          -- 'chrome_session_expired' | 'drive_upload_failed' | 'claude_error' | 'timeout' | 'daemon_restarted' | 'validation_failed' | 'unknown'
  error_message TEXT,
  error_detail TEXT,                                        -- stdout tail, not shown by default
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pjobs_status ON presentation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_pjobs_record_id ON presentation_jobs(record_id);
CREATE INDEX IF NOT EXISTS idx_pjobs_template_slug ON presentation_jobs(template_slug);
CREATE INDEX IF NOT EXISTS idx_pjobs_created_at ON presentation_jobs(created_at DESC);

-- Idempotency — blocks double-click within the queued/running window.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pjobs_dedup
  ON presentation_jobs(template_id, client_dedup_key)
  WHERE client_dedup_key IS NOT NULL AND status IN ('queued','running');

-- Idempotent ALTER for existing prod DBs (Phase 3 column).
ALTER TABLE presentation_jobs
  ADD COLUMN IF NOT EXISTS step_outputs JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Singleton heartbeat row written by the local daemon every ~15s. Presence
-- with a recent `last_heartbeat_at` = daemon healthy. Missing or stale =
-- daemon offline (banner shows in the app).
CREATE TABLE IF NOT EXISTS daemon_status (
  id TEXT PRIMARY KEY,                                      -- always 'presentations' in v1
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  hostname TEXT,
  pid INT,
  version TEXT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ
);

-- updated_at triggers
DROP TRIGGER IF EXISTS set_updated_at_presentation_templates ON presentation_templates;
CREATE TRIGGER set_updated_at_presentation_templates BEFORE UPDATE ON presentation_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_presentation_jobs ON presentation_jobs;
CREATE TRIGGER set_updated_at_presentation_jobs BEFORE UPDATE ON presentation_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS — same pattern as other tables: authenticated staff full access.
ALTER TABLE presentation_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE presentation_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE daemon_status          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access" ON presentation_templates;
DROP POLICY IF EXISTS "Authenticated full access" ON presentation_jobs;
DROP POLICY IF EXISTS "Authenticated full access" ON daemon_status;

CREATE POLICY "Authenticated full access" ON presentation_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON presentation_jobs      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON daemon_status          FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- claim_next_presentation_job — atomic claim used by the local daemon.
--
-- Supabase's JS client can't express `FOR UPDATE SKIP LOCKED` directly, so the
-- claim is encapsulated here. The daemon invokes this via `rpc()` and receives
-- the full claimed row (or NULL when the queue is empty). The function is
-- transactional: the SELECT locks the oldest queued row, the UPDATE transitions
-- it to running + records the worker id + started_at, and the RETURNING surfaces
-- the final state. Two daemons running concurrently (future case) never grab the
-- same row because of SKIP LOCKED.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_next_presentation_job(p_worker TEXT)
RETURNS SETOF presentation_jobs AS $$
  UPDATE presentation_jobs
     SET status      = 'running',
         claimed_by  = p_worker,
         started_at  = now(),
         updated_at  = now()
   WHERE id = (
     SELECT id FROM presentation_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *;
$$ LANGUAGE sql;

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
  v_sql := format(
    'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS SELECT %s FROM public.records WHERE model_id = %L',
    v_view_name, array_to_string(v_parts, ', '), v_model.id
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
