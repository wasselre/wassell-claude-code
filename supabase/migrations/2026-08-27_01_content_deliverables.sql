-- ============================================================================
-- Content operations, part 1: the deliverable layer.
--
-- THE PROBLEM THIS FIXES
--
-- mkt_content_items is currently three things at once: the strategic idea, the
-- platform output, and the publication. That is why it carries ONE language,
-- ONE caption, ONE cta_destination, ONE planned_publish_at and a
-- mkt_content_platforms multi-select. "The same reel for Instagram and TikTok"
-- is a single row, so the two cannot have different aspect ratios, different
-- captions, different owners, different due dates, or be scheduled apart — and
-- mkt_video_scenes hangs off content_item_id, so they cannot even have
-- different scenes.
--
-- A content item becomes what its name always implied: the BRIEF — the idea,
-- its strategic source, its message. Each platform/account/format/language
-- output becomes a row in mkt_content_deliverables.
--
-- NON-DESTRUCTIVE BY CONSTRUCTION
--
-- Every legacy column on mkt_content_items stays exactly where it is. Part 4
-- backfills a deliverable from them; nothing is dropped in this migration or
-- the next three. The old screens keep reading the old columns and keep
-- working while the new ones are built. Removing the duplicated columns is a
-- separate, later decision that needs the UI to have moved first.
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ── 1. The brief gains what a brief actually needs ──────────────────────────
-- Everything here is about the IDEA, not about any one platform output. The
-- fields that differ per output are deliberately NOT added here — they go on
-- the deliverable below.
ALTER TABLE public.mkt_content_items
  -- Bound to an exact immutable strategy version, exactly like mkt_plans. A
  -- newer approved strategy must never silently re-parent existing content;
  -- see mkt_plan_strategy_links for the precedent this follows.
  ADD COLUMN IF NOT EXISTS strategy_version_id uuid REFERENCES public.mkt_strategy_versions(id) ON DELETE RESTRICT,
  -- What the content is FOR. A project reel and a brand film are not the same
  -- kind of object and cannot share one implicit "project" field.
  ADD COLUMN IF NOT EXISTS scope_kind text,
  ADD COLUMN IF NOT EXISTS scope_note text,
  -- The argument the brief makes.
  ADD COLUMN IF NOT EXISTS audience_insight text,
  ADD COLUMN IF NOT EXISTS core_promise text,
  ADD COLUMN IF NOT EXISTS evidence text,
  ADD COLUMN IF NOT EXISTS desired_action text,
  ADD COLUMN IF NOT EXISTS mandatory_info text,
  ADD COLUMN IF NOT EXISTS prohibited_claims text,
  -- An always-on brief has no campaign goal and needs a stated reason instead,
  -- so "no goal" is a decision on the record rather than an empty field.
  ADD COLUMN IF NOT EXISTS always_on_reason text,
  -- Reuse as a real edge, not a sentence in a notes box.
  ADD COLUMN IF NOT EXISTS parent_content_item_id uuid REFERENCES public.mkt_content_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reuse_kind text,
  -- The stage clocks the brief owns. Per-output dates live on the deliverable.
  ADD COLUMN IF NOT EXISTS brief_due_date date,
  ADD COLUMN IF NOT EXISTS production_due_date date,
  ADD COLUMN IF NOT EXISTS review_due_date date,
  ADD COLUMN IF NOT EXISTS window_start date,
  ADD COLUMN IF NOT EXISTS window_end date,
  -- Set when the brief clears its gate; the gate trigger below maintains it.
  ADD COLUMN IF NOT EXISTS brief_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS brief_approved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Written by part 4 so a migrated row is identifiable forever.
  ADD COLUMN IF NOT EXISTS legacy_shape text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_scope_kind_check') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_scope_kind_check
      CHECK (scope_kind IS NULL OR scope_kind IN
        ('project','brand','market','developer','campaign_only','other')) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_scope_kind_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_reuse_kind_check') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_reuse_kind_check
      CHECK (reuse_kind IS NULL OR reuse_kind IN
        ('recut','translation','platform_variant','refresh','series_episode','other')) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_reuse_kind_check;
  END IF;
  -- A scope of 'project' without a project is the same silent hole the goal
  -- model had with "900" and no unit.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_project_scope_has_project') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_project_scope_has_project
      CHECK (scope_kind IS DISTINCT FROM 'project' OR project_id IS NOT NULL) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_project_scope_has_project;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_no_self_parent') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_no_self_parent
      CHECK (parent_content_item_id IS NULL OR parent_content_item_id <> id) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_no_self_parent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_window_order') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_window_order
      CHECK (window_end IS NULL OR window_start IS NULL OR window_end >= window_start) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_window_order;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_ci_strategy_version ON public.mkt_content_items(strategy_version_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_parent ON public.mkt_content_items(parent_content_item_id);

-- ── 2. Deliverables ─────────────────────────────────────────────────────────
-- One row per platform × account × format × language output.
CREATE TABLE IF NOT EXISTS public.mkt_content_deliverables (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id   uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  -- Stable, human-quotable within the brief: C-00011 / D2.
  deliverable_number integer NOT NULL,
  label             text,

  -- NULLABLE on purpose. Legacy content carries no platform at all
  -- (mkt_content_platforms is empty in production), and a backfill that put
  -- 'instagram' or 'other' there would be inventing a fact. A deliverable
  -- without a platform is flagged by needs_classification below and is refused
  -- by the scheduling gate until somebody says what it actually is.
  platform          text,
  -- The account it publishes to. Nullable while planning; required to schedule.
  social_account_id uuid,
  distribution      text NOT NULL DEFAULT 'organic',
  format            text NOT NULL,
  language          text NOT NULL DEFAULT 'ar',
  aspect_ratio      text,
  target_seconds    integer,

  owner_user_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  due_date          date,
  planned_publish_at timestamptz,

  status            text NOT NULL DEFAULT 'planned',

  -- What this specific output is judged by. Separate metric and unit for the
  -- same reason goals need them: a target of 900 with no unit says nothing.
  primary_kpi       text,
  kpi_unit          text,
  kpi_target        numeric,

  -- The two things scheduling is gated on. Both point at mkt_content_versions
  -- rows; the FKs are added in part 2 once that table has been re-pointed.
  approved_copy_version_id  uuid,
  approved_media_version_id uuid,

  -- The workflow template that generated this deliverable's tasks. Recorded so
  -- a regenerate knows what it is replacing and a migrated row is identifiable.
  workflow_template_key text,

  notes             text,
  -- Set by the backfill on anything carried over from the single-platform
  -- shape, and by any path that cannot fill a required field. Same posture as
  -- mkt_plans.needs_classification: flag it, never guess it.
  needs_classification boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,

  CONSTRAINT mkt_del_number_positive CHECK (deliverable_number > 0),
  CONSTRAINT mkt_del_seconds_positive CHECK (target_seconds IS NULL OR target_seconds > 0),
  CONSTRAINT mkt_del_kpi_needs_unit CHECK (kpi_target IS NULL OR kpi_unit IS NOT NULL),
  CONSTRAINT mkt_del_platform_check CHECK (platform IS NULL OR platform IN
    ('instagram','tiktok','youtube','snapchat','x','facebook','linkedin',
     'whatsapp','website','email','offline','other')),
  -- A deliverable may sit unclassified, but it may not be called ready without
  -- knowing where it goes.
  CONSTRAINT mkt_del_live_needs_platform CHECK (
    status IN ('planned','cancelled','on_hold') OR platform IS NOT NULL),
  CONSTRAINT mkt_del_distribution_check CHECK (distribution IN ('organic','paid','both')),
  CONSTRAINT mkt_del_language_check CHECK (language IN ('ar','en','both')),
  CONSTRAINT mkt_del_format_check CHECK (format IN
    ('reel','short_video','long_form_video','story','carousel','static_image',
     'infographic','text_post','article','newsletter','landing_page',
     'paid_video_ad','paid_image_ad','raw_asset_only','other')),
  CONSTRAINT mkt_del_status_check CHECK (status IN
    ('planned','in_production','internal_review','changes_requested',
     'approved','scheduled','published','cancelled','on_hold')),
  CONSTRAINT mkt_del_aspect_check CHECK (aspect_ratio IS NULL OR aspect_ratio IN
    ('9:16','1:1','4:5','16:9','2:3','3:2','other'))
);

-- Numbering is per brief, so C-00011/D1 and C-00012/D1 coexist.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_del_number_unique
  ON public.mkt_content_deliverables(content_item_id, deliverable_number);
CREATE INDEX IF NOT EXISTS idx_mkt_del_item ON public.mkt_content_deliverables(content_item_id);
CREATE INDEX IF NOT EXISTS idx_mkt_del_owner ON public.mkt_content_deliverables(owner_user_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_del_status ON public.mkt_content_deliverables(status)
  WHERE archived_at IS NULL;
-- The calendar reads this range; without the index it scans every deliverable.
CREATE INDEX IF NOT EXISTS idx_mkt_del_publish_at ON public.mkt_content_deliverables(planned_publish_at)
  WHERE archived_at IS NULL AND planned_publish_at IS NOT NULL;

-- Auto-number within the brief. Doing this in a trigger rather than in the API
-- means a deliverable created by a script, a backfill or a future importer is
-- numbered the same way.
CREATE OR REPLACE FUNCTION public.mkt_tg_deliverable_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.deliverable_number IS NULL OR NEW.deliverable_number = 0 THEN
    SELECT COALESCE(max(deliverable_number), 0) + 1 INTO NEW.deliverable_number
      FROM public.mkt_content_deliverables WHERE content_item_id = NEW.content_item_id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_del_number ON public.mkt_content_deliverables;
CREATE TRIGGER mkt_del_number BEFORE INSERT OR UPDATE ON public.mkt_content_deliverables
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_deliverable_number();

-- ── 3. Per-deliverable copy fields ──────────────────────────────────────────
-- Caption, hashtags and CTA destination differ per platform — a TikTok caption
-- is not an Instagram caption — so they belong here, not on the brief. The
-- brief keeps its own copies for now; part 4 copies them down and the UI reads
-- the deliverable.
ALTER TABLE public.mkt_content_deliverables
  ADD COLUMN IF NOT EXISTS caption text,
  ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS first_comment text,
  ADD COLUMN IF NOT EXISTS cta_destination text,
  ADD COLUMN IF NOT EXISTS destination_url text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_del_cta_destination_check') THEN
    ALTER TABLE public.mkt_content_deliverables ADD CONSTRAINT mkt_del_cta_destination_check
      CHECK (cta_destination IS NULL OR cta_destination IN
        ('whatsapp','landing_page','website','phone_call','instagram_dm','form','profile','none'));
  END IF;
END $$;

-- ── 4. Scenes, slides and type details move to the deliverable ──────────────
-- Nullable and additive: existing rows keep their content_item_id and keep
-- rendering. Part 4 fills deliverable_id for the migrated rows.
ALTER TABLE public.mkt_video_scenes
  ADD COLUMN IF NOT EXISTS deliverable_id uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE;
ALTER TABLE public.mkt_carousel_slides
  ADD COLUMN IF NOT EXISTS deliverable_id uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_mkt_scenes_deliverable ON public.mkt_video_scenes(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_mkt_slides_deliverable ON public.mkt_carousel_slides(deliverable_id);

-- Total planned duration, computed rather than typed. Returns NULL when there
-- are no scenes: a video with no scenes planned is unplanned, not zero seconds.
CREATE OR REPLACE FUNCTION public.mkt_deliverable_planned_seconds(p_deliverable_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT sum(planned_seconds)::integer FROM public.mkt_video_scenes
   WHERE deliverable_id = p_deliverable_id AND planned_seconds IS NOT NULL;
$$;

-- ── 5. Flexible role assignments ────────────────────────────────────────────
-- Replaces writer_user_id / designer_user_id / editor_user_id /
-- presenter_user_id / photographer_user_id, which force one person per fixed
-- craft and cannot express "two editors" or "a voice-over artist". Those five
-- columns stay for now; part 4 copies them into rows here.
CREATE TABLE IF NOT EXISTS public.mkt_content_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  -- NULL = the assignment covers the whole brief.
  deliverable_id  uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_key        text NOT NULL,
  is_reviewer     boolean NOT NULL DEFAULT false,
  is_final_approver boolean NOT NULL DEFAULT false,
  note            text,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_crole_key_check CHECK (role_key IN
    ('owner','writer','scriptwriter','designer','editor','videographer',
     'photographer','presenter','voice_over','translator','strategist',
     'reviewer','approver','publisher','other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS mkt_crole_unique
  ON public.mkt_content_roles(content_item_id, COALESCE(deliverable_id, '00000000-0000-0000-0000-000000000000'::uuid), user_id, role_key);
CREATE INDEX IF NOT EXISTS idx_mkt_crole_user ON public.mkt_content_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_mkt_crole_deliverable ON public.mkt_content_roles(deliverable_id);

-- ── 6. RLS — mirrors the existing content tables exactly ────────────────────
ALTER TABLE public.mkt_content_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_content_roles ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mkt_content_deliverables','mkt_content_roles'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_upd', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_del', t);
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                      USING (public.wassell_mkt_can('read'))$f$, t || '_read', t);
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
                      WITH CHECK (public.wassell_mkt_can('write_content'))$f$, t || '_ins', t);
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
                      USING (public.wassell_mkt_can('write_content'))$f$, t || '_upd', t);
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
                      USING (public.wassell_mkt_can('write_content'))$f$, t || '_del', t);
  END LOOP;
END $$;

COMMIT;
