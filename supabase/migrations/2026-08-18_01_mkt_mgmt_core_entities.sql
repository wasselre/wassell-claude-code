-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727091839 — "mkt_mgmt_core_entities".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- ============================================================================
-- Internal Marketing Management — core entities (2026-08-18).
-- Strategy → Campaign → Content → Production → Approval → Schedule → Publish
--          → Performance → CRM outcome → Learning
--
-- REUSE, not duplication. These reference existing entities rather than
-- recreating them:
--   projects  → all_projects records (uuid, NO FK: JSONB rows in `records`,
--               same posture as mkt_project_organizations)
--   users     → public.users (real FK)
--   files     → public.files (real FK) — storage stays the Files subsystem
--   orgs      → mkt_organizations (real FK)
--   evidence  → mkt_insights / mkt_content_posts / mkt_paid_ads (real FK)
--   CRM       → clients / followups / appointments records (uuid, no FK)
--
-- Physical tables (not JSONB models) because this workflow needs FK integrity,
-- CHECK-enforced status machines and version immutability, none of which the
-- JSONB model system can express. The existing `tasks` JSONB model stays as the
-- general admin list; content-production tasks need FKs to items/scenes/slides.
-- ============================================================================

-- ── 1. Campaigns ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_internal_campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text UNIQUE NOT NULL,
  name_ar           text NOT NULL,
  name_en           text,
  campaign_type     text NOT NULL DEFAULT 'organic'
    CHECK (campaign_type IN ('organic','paid','project_launch','promotional_offer',
      'awareness','lead_generation','retargeting','construction_update',
      'investor','seasonal','custom')),
  status            text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','planned','active','paused','completed','cancelled','archived')),
  channel_mix       text NOT NULL DEFAULT 'organic' CHECK (channel_mix IN ('organic','paid','both')),
  priority          text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  start_date        date,
  end_date          date,
  owner_user_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- strategy
  objective         text,
  target_audience   text,
  main_message      text,
  positioning       text,
  offer             text,
  content_pillars   text[] NOT NULL DEFAULT '{}',
  hooks             text[] NOT NULL DEFAULT '{}',
  cta               text,
  landing_url       text,
  target_leads        integer CHECK (target_leads IS NULL OR target_leads >= 0),
  target_appointments integer CHECK (target_appointments IS NULL OR target_appointments >= 0),
  target_sales        integer CHECK (target_sales IS NULL OR target_sales >= 0),
  target_revenue      numeric CHECK (target_revenue IS NULL OR target_revenue >= 0),
  budget              numeric CHECK (budget IS NULL OR budget >= 0),
  target_cpl          numeric, target_cpa numeric, target_roas numeric,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT campaign_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_mkt_camp_status ON public.mkt_internal_campaigns(status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_camp_owner  ON public.mkt_internal_campaigns(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_mkt_camp_dates  ON public.mkt_internal_campaigns(start_date, end_date);

CREATE TABLE IF NOT EXISTS public.mkt_internal_campaign_projects (
  campaign_id uuid NOT NULL REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL,           -- all_projects record id (JSONB: no FK)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_mkt_camp_proj_project ON public.mkt_internal_campaign_projects(project_id);

CREATE TABLE IF NOT EXISTS public.mkt_internal_campaign_members (
  campaign_id uuid NOT NULL REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_in_campaign text NOT NULL DEFAULT 'member'
    CHECK (role_in_campaign IN ('owner','manager','writer','designer','editor','publisher','reviewer','member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);

-- ── 2. Content items (the ONE central entity) ───────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.mkt_content_number_seq;

CREATE TABLE IF NOT EXISTS public.mkt_content_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_number  text UNIQUE NOT NULL DEFAULT ('C-' || lpad(nextval('public.mkt_content_number_seq')::text, 5, '0')),
  title           text NOT NULL,
  content_type    text NOT NULL
    CHECK (content_type IN ('reel','tiktok_video','snapchat_video','snapchat_story',
      'instagram_story','static_image','carousel','infographic','long_form_video',
      'paid_video_ad','paid_image_ad','project_announcement','testimonial',
      'construction_update','educational','floor_plan','property_tour','drone_video',
      'presenter_video','ai_video','motion_graphics','custom')),
  status          text NOT NULL DEFAULT 'idea'
    CHECK (status IN ('idea','brief','writing','awaiting_script_approval',
      'approved_for_production','raw_assets_required','recording','designing','editing',
      'internal_review','revision_requested','awaiting_final_approval','approved',
      'ready_to_publish','scheduled','published','cancelled','archived')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  purpose         text CHECK (purpose IS NULL OR purpose IN ('awareness','engagement',
      'lead_generation','retargeting','branding','education','conversion',
      'project_launch','offer_promotion','investor')),
  project_id      uuid,                                    -- all_projects (no FK)
  campaign_id     uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE SET NULL,
  owner_user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  writer_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  designer_user_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  editor_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  presenter_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  photographer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  due_date          date,
  planned_publish_at timestamptz,
  language        text NOT NULL DEFAULT 'ar' CHECK (language IN ('ar','en','both')),
  target_audience text,
  content_pillar  text,
  hook            text,
  main_idea       text,
  cta             text,
  caption         text,
  hashtags        text[] NOT NULL DEFAULT '{}',
  reference_links text[] NOT NULL DEFAULT '{}',
  production_notes text,
  -- provenance: external evidence → internal execution (traceable forever)
  source_insight_id uuid REFERENCES public.mkt_insights(id) ON DELETE SET NULL,
  source_post_id    uuid REFERENCES public.mkt_content_posts(id) ON DELETE SET NULL,
  source_ad_id      uuid REFERENCES public.mkt_paid_ads(id) ON DELETE SET NULL,
  source_org_id     uuid REFERENCES public.mkt_organizations(id) ON DELETE SET NULL,
  source_url        text,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_status   ON public.mkt_content_items(status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_ci_campaign ON public.mkt_content_items(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_project  ON public.mkt_content_items(project_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_owner    ON public.mkt_content_items(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_due      ON public.mkt_content_items(due_date) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_ci_source   ON public.mkt_content_items(source_insight_id);

CREATE TABLE IF NOT EXISTS public.mkt_content_platforms (
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram','tiktok','youtube','snapchat','x','facebook','linkedin','whatsapp','website')),
  PRIMARY KEY (content_item_id, platform)
);

-- ── 3. Status history (never overwritten) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  from_status text, to_status text NOT NULL,
  changed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  version_id uuid
);
CREATE INDEX IF NOT EXISTS idx_mkt_csh_item ON public.mkt_content_status_history(content_item_id, changed_at DESC);

-- ── 4. Versions (immutable once approved/published) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  version_type text NOT NULL
    CHECK (version_type IN ('brief','script','caption','video_edit','post_design',
      'carousel_design','platform_variant','final','published')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  change_summary text,
  approval_state text NOT NULL DEFAULT 'draft'
    CHECK (approval_state IN ('draft','pending','approved','changes_requested','rejected','superseded')),
  approved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  superseded_by uuid REFERENCES public.mkt_content_versions(id) ON DELETE SET NULL,
  is_locked boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version_type, version_number)
);
CREATE INDEX IF NOT EXISTS idx_mkt_cv_item ON public.mkt_content_versions(content_item_id, version_type, version_number DESC);

-- ── 5. Video production ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_video_details (
  content_item_id uuid PRIMARY KEY REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  video_type text CHECK (video_type IS NULL OR video_type IN ('recorded','edited_raw','ai_generated',
    'motion_graphics','drone','property_tour','presenter','voice_over','screen_recording','mixed')),
  planned_seconds integer CHECK (planned_seconds IS NULL OR planned_seconds > 0),
  actual_seconds  integer CHECK (actual_seconds IS NULL OR actual_seconds > 0),
  aspect_ratio text, resolution text,
  objective text, recording_location text, recording_date date,
  production_requirements text, audio_requirements text,
  voiceover_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mkt_video_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  scene_number integer NOT NULL CHECK (scene_number > 0),
  scene_type text NOT NULL DEFAULT 'b_roll'
    CHECK (scene_type IN ('presenter','b_roll','drone','ai_visual','animation',
      'screen_recording','property_shot','floor_plan','text_only','testimonial','custom')),
  planned_seconds integer CHECK (planned_seconds IS NULL OR planned_seconds > 0),
  actual_seconds  integer CHECK (actual_seconds IS NULL OR actual_seconds > 0),
  visual_description text, on_screen_text text, voice_over text, dialogue text, subtitle text,
  camera_angle text, camera_movement text, shot_instructions text, location text,
  raw_asset_id uuid,                                  -- FK added after assets table
  reference_url text,
  assigned_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','blocked','waiting_review','completed','cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_scene_item ON public.mkt_video_scenes(content_item_id, scene_number);

-- ── 6. Post / carousel production ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_post_details (
  content_item_id uuid PRIMARY KEY REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  post_type text CHECK (post_type IS NULL OR post_type IN ('static_image','carousel','infographic',
    'quote','comparison','floor_plan','project_features','offer','educational',
    'testimonial','announcement','custom')),
  headline text, design_instructions text, visual_style text, dimensions text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mkt_carousel_slides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  slide_number integer NOT NULL CHECK (slide_number > 0),
  slide_type text NOT NULL DEFAULT 'content'
    CHECK (slide_type IN ('cover','content','comparison','feature','offer','testimonial','cta','custom')),
  headline text, body_text text, supporting_text text, cta text,
  design_instructions text,
  raw_asset_id uuid,                                  -- FK added after assets table
  reference_url text,
  assigned_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','blocked','waiting_review','completed','cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_slide_item ON public.mkt_carousel_slides(content_item_id, slide_number);

-- ── 7. Raw asset library (records over folders) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_raw_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  asset_name text NOT NULL,
  asset_type text NOT NULL DEFAULT 'custom'
    CHECK (asset_type IN ('property_photo','property_video','drone_footage','presenter_footage',
      'developer_footage','construction_footage','floor_plan','brochure','logo','audio',
      'voice_over','testimonial','render','ai_generated','screenshot','document','music',
      'brand_template','custom')),
  project_id uuid, unit_id uuid,                       -- records (no FK)
  developer_org_id uuid REFERENCES public.mkt_organizations(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE SET NULL,
  location text, subject text,
  recorded_at date,
  recorded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  uploaded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  orientation text CHECK (orientation IS NULL OR orientation IN ('portrait','landscape','square')),
  width integer, height integer, duration_ms integer, size_bytes bigint, mime_type text,
  usage_rights text CHECK (usage_rights IS NULL OR usage_rights IN ('owned','licensed','developer_supplied','restricted','unknown')),
  rights_expires_at date,
  quality_rating smallint CHECK (quality_rating IS NULL OR quality_rating BETWEEN 1 AND 5),
  people text[] NOT NULL DEFAULT '{}',
  transcript text, ocr_text text, ai_description text,
  tags text[] NOT NULL DEFAULT '{}',
  checksum_sha256 text,
  thumbnail_path text,
  approval_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (approval_status IN ('unreviewed','approved','rejected')),
  usage_status text NOT NULL DEFAULT 'available'
    CHECK (usage_status IN ('available','in_use','expired_rights','low_quality','missing_original','archived')),
  -- honest processing states: never silently zero
  processing_status text NOT NULL DEFAULT 'not_attempted'
    CHECK (processing_status IN ('not_attempted','pending','processing','completed','degraded','failed','unsupported')),
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_project  ON public.mkt_raw_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_type     ON public.mkt_raw_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_tags     ON public.mkt_raw_assets USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_checksum ON public.mkt_raw_assets(checksum_sha256) WHERE checksum_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_asset_search   ON public.mkt_raw_assets
  USING gin(to_tsvector('simple', coalesce(asset_name,'')||' '||coalesce(transcript,'')||' '||coalesce(ocr_text,'')||' '||coalesce(ai_description,'')));

ALTER TABLE public.mkt_video_scenes    DROP CONSTRAINT IF EXISTS mkt_video_scenes_raw_asset_fk;
ALTER TABLE public.mkt_video_scenes    ADD CONSTRAINT mkt_video_scenes_raw_asset_fk
  FOREIGN KEY (raw_asset_id) REFERENCES public.mkt_raw_assets(id) ON DELETE SET NULL;
ALTER TABLE public.mkt_carousel_slides DROP CONSTRAINT IF EXISTS mkt_carousel_slides_raw_asset_fk;
ALTER TABLE public.mkt_carousel_slides ADD CONSTRAINT mkt_carousel_slides_raw_asset_fk
  FOREIGN KEY (raw_asset_id) REFERENCES public.mkt_raw_assets(id) ON DELETE SET NULL;

-- One asset, many uses — never duplicate the file to make it appear elsewhere.
CREATE TABLE IF NOT EXISTS public.mkt_asset_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.mkt_raw_assets(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('project','campaign','content_item','scene','slide','publication')),
  target_id uuid NOT NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_links_target ON public.mkt_asset_links(target_type, target_id);

COMMENT ON TABLE public.mkt_raw_assets IS 'Digital asset records. Files live in public.files; folders are never the primary model.';;
