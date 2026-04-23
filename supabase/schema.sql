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

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar TEXT NOT NULL,
  label_en TEXT NOT NULL,
  trigger_model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN ('create', 'update', 'delete')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workflow execution log — audit trail of every workflow run.
-- The row snapshot keeps the entry readable even if the workflow is later edited.
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
  status TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS maps_config JSONB NOT NULL DEFAULT '{"location_url_field_id":null,"manual_lat_field_id":null,"manual_lng_field_id":null,"pin_color_field_id":null,"pin_label_field_id":null,"click_action":"popup","popup_title_field_id":null,"popup_subtitle_field_id":null,"popup_badge_field_id":null,"popup_shown_field_ids":[],"map_style_json":null,"default_center_lat":null,"default_center_lng":null,"default_zoom":null}'::jsonb;

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
