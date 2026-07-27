-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727091937 — "mkt_mgmt_workflow_entities".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- ── 8. Content production tasks (dependency-aware) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  task_type text NOT NULL DEFAULT 'custom'
    CHECK (task_type IN ('write_brief','write_script','approve_script','prepare_assets',
      'record','edit_video','review_video','revisions','write_caption','write_copy',
      'design_slides','review_design','approve_final','schedule_publication',
      'record_performance','custom')),
  campaign_id     uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  content_item_id uuid REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  scene_id        uuid REFERENCES public.mkt_video_scenes(id) ON DELETE CASCADE,
  slide_id        uuid REFERENCES public.mkt_carousel_slides(id) ON DELETE CASCADE,
  project_id      uuid,
  assigned_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  due_date date,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','blocked','waiting_review','completed','cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  depends_on_task_id uuid REFERENCES public.mkt_content_tasks(id) ON DELETE SET NULL,
  blocked_reason text,
  sort_order integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_has_a_parent CHECK (campaign_id IS NOT NULL OR content_item_id IS NOT NULL),
  CONSTRAINT task_not_self_dependent CHECK (depends_on_task_id IS NULL OR depends_on_task_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_mkt_task_item     ON public.mkt_content_tasks(content_item_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_mkt_task_assignee ON public.mkt_content_tasks(assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_mkt_task_due      ON public.mkt_content_tasks(due_date) WHERE status NOT IN ('completed','cancelled');

-- ── 9. Approvals + comments (attachable to anything) ───────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('content_item','version','scene','slide','asset','publication','campaign')),
  target_id uuid NOT NULL,
  version_id uuid REFERENCES public.mkt_content_versions(id) ON DELETE SET NULL,
  stage text NOT NULL
    CHECK (stage IN ('brief','script','copy','design','video','compliance','developer','final','publication')),
  reviewer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending','approved','changes_requested','rejected','cancelled')),
  comment text,
  requested_changes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT decision_has_timestamp CHECK (decision = 'pending' OR decided_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mkt_appr_target  ON public.mkt_approvals(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_appr_pending ON public.mkt_approvals(reviewer_user_id) WHERE decision='pending';

CREATE TABLE IF NOT EXISTS public.mkt_mgmt_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('content_item','version','scene','slide','asset','publication','campaign','task')),
  target_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  author_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mkt_comment_target ON public.mkt_mgmt_comments(target_type, target_id, created_at DESC);

-- ── 10. Publications (one content item → many platform publications) ───────
CREATE TABLE IF NOT EXISTS public.mkt_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  version_id uuid REFERENCES public.mkt_content_versions(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('instagram','tiktok','youtube','snapchat','x','facebook','linkedin','whatsapp','website')),
  social_account_id uuid REFERENCES public.mkt_social_accounts(id) ON DELETE SET NULL,
  project_id uuid,
  campaign_id uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'organic' CHECK (channel IN ('organic','paid')),
  scheduled_for timestamptz,
  published_at timestamptz,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','scheduled','publishing','published','failed','cancelled','removed','unknown')),
  caption text,
  hashtags text[] NOT NULL DEFAULT '{}',
  asset_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  published_url text,
  platform_post_id text,
  -- never pretend automatic publishing exists where it does not
  publish_method text NOT NULL DEFAULT 'manual'
    CHECK (publish_method IN ('manual','api','scheduled_api')),
  error_message text,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  published_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_needs_timestamp CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mkt_pub_item      ON public.mkt_publications(content_item_id);
CREATE INDEX IF NOT EXISTS idx_mkt_pub_schedule  ON public.mkt_publications(scheduled_for) WHERE status IN ('scheduled','ready');
CREATE INDEX IF NOT EXISTS idx_mkt_pub_campaign  ON public.mkt_publications(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_pub_published ON public.mkt_publications(published_at DESC) WHERE status='published';

-- ── 11. Performance snapshots (append-only, never overwritten) ─────────────
CREATE TABLE IF NOT EXISTS public.mkt_performance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid REFERENCES public.mkt_publications(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  platform text,
  channel text CHECK (channel IS NULL OR channel IN ('organic','paid')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','platform_api','import','estimated')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- honest states: a missing metric is NOT zero
  collection_status text NOT NULL DEFAULT 'collected'
    CHECK (collection_status IN ('collected','partial','not_available','not_measurable','not_attempted','failed','awaiting_data')),
  error text,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT snapshot_has_subject CHECK (publication_id IS NOT NULL OR campaign_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mkt_perf_pub  ON public.mkt_performance_snapshots(publication_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_perf_camp ON public.mkt_performance_snapshots(campaign_id, captured_at DESC);

-- ── 12. CRM attribution ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_lead_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid, followup_id uuid, appointment_id uuid, reservation_id uuid,  -- records (no FK)
  project_id uuid,
  campaign_id uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE SET NULL,
  content_item_id uuid REFERENCES public.mkt_content_items(id) ON DELETE SET NULL,
  publication_id uuid REFERENCES public.mkt_publications(id) ON DELETE SET NULL,
  paid_ad_id uuid REFERENCES public.mkt_paid_ads(id) ON DELETE SET NULL,
  platform text, social_account_id uuid REFERENCES public.mkt_social_accounts(id) ON DELETE SET NULL,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  touch_type text NOT NULL DEFAULT 'unknown' CHECK (touch_type IN ('first','last','multi','unknown')),
  attribution_type text NOT NULL DEFAULT 'unknown'
    CHECK (attribution_type IN ('utm','platform_lead_form','manual_confirmed','inferred','unknown')),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  lead_at timestamptz, revenue numeric CHECK (revenue IS NULL OR revenue >= 0),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribution_has_marketing_side CHECK (
    campaign_id IS NOT NULL OR content_item_id IS NOT NULL OR publication_id IS NOT NULL OR paid_ad_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mkt_attr_client   ON public.mkt_lead_attributions(client_id);
CREATE INDEX IF NOT EXISTS idx_mkt_attr_campaign ON public.mkt_lead_attributions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_attr_content  ON public.mkt_lead_attributions(content_item_id);

-- ── 13. Intelligence → execution trail ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_intelligence_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('insight','content_post','paid_ad','observed_fact','organization','manual')),
  source_id uuid NOT NULL,
  action_type text NOT NULL
    CHECK (action_type IN ('create_content','create_campaign','add_reference','add_hook','add_offer','assign_review','dismiss')),
  content_item_id uuid REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  note text,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_intel_act_source ON public.mkt_intelligence_actions(source_type, source_id);

-- ── 14. Operational alerts (deterministic, every one links to a record) ────
CREATE TABLE IF NOT EXISTS public.mkt_mgmt_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  title_ar text NOT NULL, title_en text NOT NULL,
  body_ar text, body_en text,
  target_type text NOT NULL CHECK (target_type IN ('content_item','campaign','publication','project','task','asset','user')),
  target_id uuid NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key text UNIQUE NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  dismissed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_mkt_alert_open ON public.mkt_mgmt_alerts(severity, generated_at DESC)
  WHERE resolved_at IS NULL AND dismissed = false;;
