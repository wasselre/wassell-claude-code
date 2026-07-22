-- ============================================================================
-- 2026-07-22: Project Marketing Intelligence — core normalized schema (Phase 0)
-- ----------------------------------------------------------------------------
-- Foundation for the Project Marketing Intelligence module: a normalized,
-- provider-agnostic store for developer + competitor-marketer marketing content
-- (organic posts, paid ads, metric snapshots) collected via Apify / YouTube Data
-- API / Browserbase, plus our own marketing-asset library.
--
-- DESIGN (see docs/marketing-intelligence-design.md):
--   • ADDITIVE ONLY — new `mkt_*` tables. Touches NOTHING existing. `developers`
--     (records-model, 200 rows) is preserved; orgs LINK to it via developer_record_id.
--   • PHYSICAL tables (not JSONB records) — built to scale to millions of rows +
--     continuous ingestion, same posture as market_listings / district_boundaries.
--   • RLS: authenticated may SELECT (marketing intel is public competitor data over
--     the broadly-shared project catalog). WRITES are service-role only — the SPA
--     never writes these; it goes through /api/marketing/* (JWT-validated) → worker /
--     service-role. Human edits (add account, confirm attribution) are gated at the
--     API layer, mirroring document_templates. Anon is fully blocked by RLS.
--   • Provider-agnostic: raw payloads are retained (mkt_raw_ingestions) and every
--     row records which provider(s) produced it, so switching providers never dupes.
--
-- Naming: `mkt_` prefix namespaces the whole module for easy discovery/management.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. ORGANIZATIONS — developers, external marketing companies, Wassel, publishers
--    Compatibility strategy: this does NOT replace `developers`. A developer org
--    row carries developer_record_id → the existing developers record (public.records).
--    Existing lookups/rollups keep working untouched; orgs add the social layer on top.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_type            text NOT NULL DEFAULT 'marketer'
                        CHECK (org_type IN ('developer','marketer','agency','influencer','internal','publisher')),
  name_ar             text,
  name_en             text,
  website             text,
  -- Safe link to the existing developers model row (records.id). NULL for pure
  -- marketers/influencers that aren't in the developers catalog.
  developer_record_id uuid,
  hq_city             text,
  followers_cached    int,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_organizations_type_idx        ON public.mkt_organizations (org_type);
CREATE INDEX IF NOT EXISTS mkt_organizations_developer_idx   ON public.mkt_organizations (developer_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_organizations_developer_uq
  ON public.mkt_organizations (developer_record_id) WHERE developer_record_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. SOCIAL ACCOUNTS — one row per (organization, platform)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_social_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.mkt_organizations(id) ON DELETE CASCADE,
  platform            text NOT NULL
                        CHECK (platform IN ('instagram','tiktok','snapchat','youtube','x','facebook')),
  handle              text NOT NULL,
  profile_url         text,
  external_account_id text,                 -- platform-native id (e.g. YouTube channelId, IG user pk)
  display_name        text,
  followers           int,
  verified            boolean,
  is_active           boolean NOT NULL DEFAULT true,
  -- Which provider collects this account, + provider-specific config/state.
  provider            text CHECK (provider IN ('apify','youtube','browserbase')),
  provider_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_cursor         text,                 -- stored incremental cursor (e.g. uploads-playlist pageToken)
  last_synced_at      timestamptz,
  scrape_status       text NOT NULL DEFAULT 'idle'
                        CHECK (scrape_status IN ('idle','ok','auth_failed','rate_limited','unavailable','error')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Same handle on a platform is a single account.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_social_accounts_platform_handle_uq
  ON public.mkt_social_accounts (platform, lower(handle));
CREATE INDEX IF NOT EXISTS mkt_social_accounts_org_idx      ON public.mkt_social_accounts (organization_id);
CREATE INDEX IF NOT EXISTS mkt_social_accounts_provider_idx ON public.mkt_social_accounts (provider, is_active);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. PROJECT ↔ ORGANIZATION relationships (developer 1:1, marketers M:N)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_project_organizations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,                    -- all_projects records.id
  organization_id   uuid NOT NULL REFERENCES public.mkt_organizations(id) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'observed_marketer'
                      CHECK (relationship_type IN
                        ('developer','authorized_marketer','observed_marketer','internal_marketer','former_marketer')),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at  timestamptz NOT NULL DEFAULT now(),
  confidence        numeric,                          -- 0..1 for observed (auto) relationships
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_confirmed   boolean NOT NULL DEFAULT false,
  confirmed_by      uuid,
  confirmed_at      timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_project_organizations_uq
  ON public.mkt_project_organizations (project_id, organization_id, relationship_type);
CREATE INDEX IF NOT EXISTS mkt_project_organizations_project_idx ON public.mkt_project_organizations (project_id);
CREATE INDEX IF NOT EXISTS mkt_project_organizations_org_idx     ON public.mkt_project_organizations (organization_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. CONTENT POSTS — externally published ORGANIC content (developer + marketer)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_content_posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform           text NOT NULL
                       CHECK (platform IN ('instagram','tiktok','snapchat','youtube','x','facebook')),
  external_id        text NOT NULL,                   -- platform-native post/video id
  social_account_id  uuid REFERENCES public.mkt_social_accounts(id) ON DELETE SET NULL,
  organization_id    uuid REFERENCES public.mkt_organizations(id) ON DELETE SET NULL,
  post_url           text,
  canonical_url      text,                            -- normalized dedup key (secondary)
  post_type          text CHECK (post_type IN ('image','video','carousel','reel','story','short','text','unknown')),
  caption            text,
  lang               text,
  published_at       timestamptz,
  media_refs         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{kind,url,storage_path?}]
  thumbnail_ref      text,
  duration_ms        int,
  hashtags           text[] NOT NULL DEFAULT '{}',
  mentions           text[] NOT NULL DEFAULT '{}',
  engagement         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- latest snapshot cache {views,likes,comments,shares,saves}
  content_hash       text,                            -- fuzzy-dedup fingerprint (publisher+time+caption[+media])
  -- Provider provenance — accumulates every provider that saw this post so a
  -- provider switch never creates a duplicate row (dedup §6).
  providers          text[] NOT NULL DEFAULT '{}',
  first_provider     text,
  availability       text NOT NULL DEFAULT 'available'
                       CHECK (availability IN ('available','deleted','unavailable')),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  sync_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- PRIMARY dedup key: platform + external_id (§6 step 1).
CREATE UNIQUE INDEX IF NOT EXISTS mkt_content_posts_platform_extid_uq
  ON public.mkt_content_posts (platform, external_id);
-- SECONDARY dedup guard: canonical URL when present (§6 step 2).
CREATE UNIQUE INDEX IF NOT EXISTS mkt_content_posts_canonical_uq
  ON public.mkt_content_posts (canonical_url) WHERE canonical_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_content_posts_account_idx   ON public.mkt_content_posts (social_account_id, published_at DESC);
CREATE INDEX IF NOT EXISTS mkt_content_posts_org_idx       ON public.mkt_content_posts (organization_id, published_at DESC);
CREATE INDEX IF NOT EXISTS mkt_content_posts_published_idx ON public.mkt_content_posts (published_at DESC);
CREATE INDEX IF NOT EXISTS mkt_content_posts_hash_idx      ON public.mkt_content_posts (content_hash) WHERE content_hash IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. CONTENT → PROJECT attribution (a post may hit 0, 1, or many projects)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_content_attributions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_post_id   uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL,                    -- all_projects records.id
  attribution_method text NOT NULL
                      CHECK (attribution_method IN
                        ('name_ar','name_en','alias','hashtag','developer_account','marketer_assignment',
                         'landing_url','caption','transcript','ocr','manual')),
  confidence        numeric NOT NULL DEFAULT 0,       -- 0..1
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { matched_alias, snippet, ... }
  matched_aliases   text[] NOT NULL DEFAULT '{}',
  review_status     text NOT NULL DEFAULT 'candidate'
                      CHECK (review_status IN ('candidate','auto_accepted','confirmed','rejected')),
  confirmed_by      uuid,
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_content_attributions_uq
  ON public.mkt_content_attributions (content_post_id, project_id);
CREATE INDEX IF NOT EXISTS mkt_content_attributions_project_idx ON public.mkt_content_attributions (project_id, review_status);
CREATE INDEX IF NOT EXISTS mkt_content_attributions_review_idx  ON public.mkt_content_attributions (review_status)
  WHERE review_status = 'candidate';

-- ════════════════════════════════════════════════════════════════════════════
-- 6. METRIC SNAPSHOTS — time series (never overwrite; history powers trend AI)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_metric_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('post','ad','account')),
  subject_id    uuid NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  metrics       jsonb NOT NULL,                       -- {views,likes,comments,shares,saves,play_count,followers}
  provider      text,
  raw_ref       uuid,                                 -- mkt_raw_ingestions.id this came from
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_metric_snapshots_subject_idx
  ON public.mkt_metric_snapshots (subject_type, subject_id, captured_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. PAID ADS — separate from organic. NEVER stores/estimates spend/leads/ROAS.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_paid_ads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform           text NOT NULL CHECK (platform IN ('meta','tiktok','snapchat')),
  external_ad_id     text NOT NULL,                   -- ad_archive_id
  organization_id    uuid REFERENCES public.mkt_organizations(id) ON DELETE SET NULL,
  advertiser_name    text,
  creative_media_ref text,
  creative_type      text,
  headline           text,
  body               text,
  cta                text,
  landing_url        text,
  platform_started_at timestamptz,                    -- platform-reported start
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  is_active          boolean NOT NULL DEFAULT true,
  reach_info         jsonb,                            -- only if platform publicly discloses (EU) — else null
  providers          text[] NOT NULL DEFAULT '{}',
  raw_ref            uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_paid_ads_platform_extid_uq
  ON public.mkt_paid_ads (platform, external_ad_id);
CREATE INDEX IF NOT EXISTS mkt_paid_ads_org_idx ON public.mkt_paid_ads (organization_id, is_active);

-- Ad → project attribution reuses the same candidate/confirm model as posts.
CREATE TABLE IF NOT EXISTS public.mkt_ad_attributions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paid_ad_id     uuid NOT NULL REFERENCES public.mkt_paid_ads(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL,
  attribution_method text NOT NULL,
  confidence     numeric NOT NULL DEFAULT 0,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status  text NOT NULL DEFAULT 'candidate'
                   CHECK (review_status IN ('candidate','auto_accepted','confirmed','rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ad_attributions_uq ON public.mkt_ad_attributions (paid_ad_id, project_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 8. RAW INGESTIONS — retained provider payloads (debug + future reprocessing)
--    Retention: cleanup job deletes rows older than 90d (see mkt_raw_ingestions_cleanup).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_raw_ingestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL,
  source_type        text NOT NULL,                   -- 'profile'|'post'|'metrics'|'ads'|'discover'
  external_identity  text,                            -- account handle / post id / actor run id
  collected_at       timestamptz NOT NULL DEFAULT now(),
  payload            jsonb NOT NULL,
  processing_status  text NOT NULL DEFAULT 'pending'
                       CHECK (processing_status IN ('pending','processed','failed','skipped')),
  normalization_version int NOT NULL DEFAULT 1,
  error_info         text,
  dedup_key          text,                            -- provider+source_type+external_identity+content hash
  ingestion_run_id   uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_raw_ingestions_status_idx  ON public.mkt_raw_ingestions (processing_status, collected_at);
CREATE INDEX IF NOT EXISTS mkt_raw_ingestions_run_idx     ON public.mkt_raw_ingestions (ingestion_run_id);
CREATE INDEX IF NOT EXISTS mkt_raw_ingestions_dedup_idx   ON public.mkt_raw_ingestions (dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_raw_ingestions_age_idx     ON public.mkt_raw_ingestions (collected_at);

-- ════════════════════════════════════════════════════════════════════════════
-- 9. INGESTION RUNS — every collection operation, for visibility + cost tracking
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_ingestion_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  source_account_id uuid REFERENCES public.mkt_social_accounts(id) ON DELETE SET NULL,
  requested_scope   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {kind:'incremental'|'backfill'|'metrics'|'ads'|'discover', ...}
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','succeeded','failed','partial','cancelled')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  items_received    int NOT NULL DEFAULT 0,
  items_inserted    int NOT NULL DEFAULT 0,
  items_updated     int NOT NULL DEFAULT 0,
  items_skipped     int NOT NULL DEFAULT 0,
  errors            jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_cost     jsonb,                            -- provider-reported cost/units when available
  rate_limit_info   jsonb,
  worker_job_ref    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_ingestion_runs_account_idx ON public.mkt_ingestion_runs (source_account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS mkt_ingestion_runs_status_idx  ON public.mkt_ingestion_runs (status, started_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- 10. PROVIDER REGISTRY + health, and Apify ACTOR CONFIG registry
--     (Actor IDs live in ONE table, never hardcoded across the codebase.)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_providers (
  provider_key   text PRIMARY KEY,                    -- 'apify' | 'youtube' | 'browserbase'
  display_name   text NOT NULL,
  is_enabled     boolean NOT NULL DEFAULT true,
  health_status  text NOT NULL DEFAULT 'not_configured'
                   CHECK (health_status IN
                     ('not_configured','connected','auth_failed','rate_limited','unavailable','config_invalid')),
  health_detail  text,
  last_checked_at timestamptz,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mkt_actor_configs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type      text NOT NULL,                     -- 'instagram_profile','tiktok_profile','meta_ads', ...
  actor_id         text NOT NULL,                     -- Apify actor id (e.g. 'apify/instagram-scraper')
  input_builder    text,                              -- name of the TS input-builder fn
  result_parser    text,                              -- name of the TS parser fn
  supported_fields text[] NOT NULL DEFAULT '{}',
  version          text,
  is_enabled       boolean NOT NULL DEFAULT false,    -- OFF until an actor is vetted + token present
  cost_info        jsonb,
  notes            text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_actor_configs_source_uq ON public.mkt_actor_configs (source_type, actor_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 11. OUR ASSET LIBRARY — Wassel's own marketing creatives (bytes in Files system)
--     Owner-scoped like media_assets; the record stores the files.id / storage ref.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mkt_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid,                             -- all_projects records.id
  title             text,
  description       text,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','ready','published','archived')),
  version           int NOT NULL DEFAULT 1,
  -- Storage: the Files system (files.id) OR a bucket path — bytes never live here.
  file_id           uuid,
  storage_bucket    text,
  storage_path      text,
  thumbnail_ref     text,
  preview_ref       text,
  duration_ms       int,
  width             int,
  height            int,
  content_type      text CHECK (content_type IN
                      ('reel','story','carousel','image','video','drone','animation',
                       'floor_plan','testimonial','lifestyle','construction_update')),
  purpose           text CHECK (purpose IN ('awareness','lead_gen','retargeting','branding','education')),
  platforms         text[] NOT NULL DEFAULT '{}',
  lang              text,
  tags              text[] NOT NULL DEFAULT '{}',
  hook              text,
  cta               text,
  caption           text,
  script            text,
  production_stage  text NOT NULL DEFAULT 'raw'
                      CHECK (production_stage IN ('raw','editing','review','approved','published','archived')),
  -- Future-AI hooks (populated later; no migration needed to start using them).
  transcript        text,
  ocr_text          text,
  ai_tags           jsonb,
  created_by_user_id uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_assets_project_idx ON public.mkt_assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mkt_assets_stage_idx   ON public.mkt_assets (production_stage);
CREATE INDEX IF NOT EXISTS mkt_assets_owner_idx   ON public.mkt_assets (created_by_user_id, created_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- updated_at touch trigger (shared)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mkt_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mkt_organizations','mkt_social_accounts','mkt_project_organizations','mkt_content_posts',
    'mkt_content_attributions','mkt_paid_ads','mkt_assets'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — authenticated may SELECT; writes service-role only (SPA → /api → worker).
--   mkt_assets is owner-scoped (our private creatives).
--   mkt_raw_ingestions / mkt_ingestion_runs are admin-read (operational data).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mkt_organizations','mkt_social_accounts','mkt_project_organizations','mkt_content_posts',
    'mkt_content_attributions','mkt_metric_snapshots','mkt_paid_ads','mkt_ad_attributions',
    'mkt_raw_ingestions','mkt_ingestion_runs','mkt_providers','mkt_actor_configs','mkt_assets'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Public-competitor-intel tables: any authenticated user may read.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mkt_organizations','mkt_social_accounts','mkt_project_organizations','mkt_content_posts',
    'mkt_content_attributions','mkt_metric_snapshots','mkt_paid_ads','mkt_ad_attributions',
    'mkt_providers','mkt_actor_configs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- Operational tables: admin-read only.
DROP POLICY IF EXISTS mkt_raw_ingestions_admin ON public.mkt_raw_ingestions;
CREATE POLICY mkt_raw_ingestions_admin ON public.mkt_raw_ingestions FOR SELECT TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));
GRANT SELECT ON public.mkt_raw_ingestions TO authenticated;

DROP POLICY IF EXISTS mkt_ingestion_runs_read ON public.mkt_ingestion_runs;
CREATE POLICY mkt_ingestion_runs_read ON public.mkt_ingestion_runs FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mkt_ingestion_runs TO authenticated;

-- Our private creatives: owner-scoped.
DROP POLICY IF EXISTS mkt_assets_owner_select ON public.mkt_assets;
CREATE POLICY mkt_assets_owner_select ON public.mkt_assets FOR SELECT TO authenticated
  USING (created_by_user_id = (SELECT auth.uid()) OR public.wassell_is_admin((SELECT auth.uid())));
GRANT SELECT ON public.mkt_assets TO authenticated;

COMMIT;
