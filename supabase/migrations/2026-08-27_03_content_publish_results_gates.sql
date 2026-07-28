-- ============================================================================
-- Content operations, part 3: publishing per deliverable, results, and gates.
--
-- WHAT THIS FIXES
--
-- * mkt_publications hangs off content_item_id, so two platform outputs of one
--   idea cannot be scheduled independently — and the screen's failure mode is
--   "no platforms selected", which names a multi-select rather than the thing
--   the user actually has to create.
-- * Nothing stops scheduling a publication whose media and copy were never
--   approved. The approval is decorative until something enforces it.
-- * Performance and publishing are the same row, so "it published" and "it
--   worked" cannot be distinguished, and there is nowhere to record what was
--   learned or whether to repeat it.
-- * next_action and blocker are free-text columns somebody types. They must be
--   computed from the actual records or they are just another stale field.
--
-- Idempotent. Non-destructive.
-- ============================================================================
BEGIN;

-- ── 1. Publications belong to a deliverable ─────────────────────────────────
ALTER TABLE public.mkt_publications
  ADD COLUMN IF NOT EXISTS deliverable_id uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE,
  -- The exact versions this publication is locked to. Copied at schedule time
  -- so a later artifact revision cannot retroactively change what was posted.
  ADD COLUMN IF NOT EXISTS locked_copy_version_id uuid REFERENCES public.mkt_content_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS locked_media_version_id uuid REFERENCES public.mkt_content_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS first_comment text,
  ADD COLUMN IF NOT EXISTS destination_url text,
  ADD COLUMN IF NOT EXISTS utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Paid creatives attach to the real ad structure instead of pretending to be
  -- an ordinary organic post.
  ADD COLUMN IF NOT EXISTS ad_id uuid REFERENCES public.mkt_ads(id) ON DELETE SET NULL,
  -- Scheduling is authored in Riyadh time; the column stays timestamptz (the
  -- correct storage), and this records the zone the human chose it in so the
  -- UI can render back exactly what they typed.
  ADD COLUMN IF NOT EXISTS scheduled_timezone text NOT NULL DEFAULT 'Asia/Riyadh';

CREATE INDEX IF NOT EXISTS idx_mkt_pub_deliverable ON public.mkt_publications(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_mkt_pub_scheduled ON public.mkt_publications(scheduled_for)
  WHERE status IN ('scheduled','ready');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_pub_social_account_fk') THEN
    ALTER TABLE public.mkt_publications ADD CONSTRAINT mkt_pub_social_account_fk
      FOREIGN KEY (social_account_id) REFERENCES public.mkt_social_accounts(id) ON DELETE SET NULL;
  END IF;
  -- A paid publication that names no ad is a paid publication in name only.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_pub_published_has_url') THEN
    ALTER TABLE public.mkt_publications ADD CONSTRAINT mkt_pub_published_has_url
      CHECK (status <> 'published' OR published_url IS NOT NULL OR platform_post_id IS NOT NULL) NOT VALID;
    -- NOT validated: zero rows today, but a historical import might lack both
    -- and inventing a URL for it would be a fabricated record.
  END IF;
END $$;

-- ── 2. Results, kept apart from publishing ──────────────────────────────────
-- Snapshots over time already exist (mkt_performance_snapshots); they only need
-- to know which deliverable they belong to.
ALTER TABLE public.mkt_performance_snapshots
  ADD COLUMN IF NOT EXISTS deliverable_id uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS content_item_id uuid REFERENCES public.mkt_content_items(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_mkt_snap_deliverable ON public.mkt_performance_snapshots(deliverable_id, captured_at DESC);

-- The conclusion, which is a different kind of statement from a metric reading.
CREATE TABLE IF NOT EXISTS public.mkt_content_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id  uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  -- NULL = a conclusion about the whole package rather than one output.
  deliverable_id   uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE,
  goal_id          uuid REFERENCES public.mkt_goals(id) ON DELETE SET NULL,

  -- The KPI actually achieved. kpi_target lives on the deliverable; this is the
  -- measured side, and it is NULL until somebody measures — never 0.
  kpi_actual       numeric,
  measured_at      date,
  -- Structured platform metrics, plus the business numbers that matter here.
  metrics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  leads            integer,
  qualified_leads  integer,
  clicks           integer,
  conversions      integer,
  spend            numeric,
  cost_per_lead    numeric,
  attribution_source text,

  learning         text,
  recommendation   text,
  recorded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT mkt_cres_recommendation_check CHECK (recommendation IS NULL OR recommendation IN
    ('repeat','improve','stop','reuse')),
  CONSTRAINT mkt_cres_counts_nonneg CHECK (
    COALESCE(leads,0) >= 0 AND COALESCE(qualified_leads,0) >= 0
    AND COALESCE(clicks,0) >= 0 AND COALESCE(conversions,0) >= 0),
  -- Cost metrics only mean something for paid distribution, but a boosted
  -- organic post has spend too, so this is not tied to the paid flag.
  CONSTRAINT mkt_cres_spend_nonneg CHECK (spend IS NULL OR spend >= 0)
);
CREATE INDEX IF NOT EXISTS idx_mkt_cres_item ON public.mkt_content_results(content_item_id);
CREATE INDEX IF NOT EXISTS idx_mkt_cres_deliverable ON public.mkt_content_results(deliverable_id);

-- Target achievement, computed. NULL when either side is unknown — a target
-- with no reading is not 0%.
CREATE OR REPLACE FUNCTION public.mkt_deliverable_attainment(p_deliverable_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE d record; v_actual numeric; v_at date;
BEGIN
  SELECT * INTO d FROM public.mkt_content_deliverables WHERE id = p_deliverable_id;
  IF d IS NULL THEN RETURN NULL; END IF;

  SELECT kpi_actual, measured_at INTO v_actual, v_at
    FROM public.mkt_content_results
   WHERE deliverable_id = p_deliverable_id AND kpi_actual IS NOT NULL
   ORDER BY measured_at DESC NULLS LAST, created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'kpi', d.primary_kpi, 'unit', d.kpi_unit,
    'target', d.kpi_target, 'actual', v_actual, 'measured_at', v_at,
    'is_measured', v_actual IS NOT NULL,
    'attainment_pct', CASE
      WHEN v_actual IS NULL OR d.kpi_target IS NULL OR d.kpi_target = 0 THEN NULL
      ELSE round((v_actual / d.kpi_target) * 100, 1) END);
END $$;

-- ── 3. The gates ────────────────────────────────────────────────────────────
-- One function per gate, each returning the SAME list the UI shows, so a
-- disabled button and the reason it is disabled can never disagree.

-- A brief may be captured with nothing but a title (the Idea Inbox). This is
-- what it needs before it can leave 'idea'.
CREATE OR REPLACE FUNCTION public.mkt_content_missing_requirements(p_item_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE c record; missing text[] := ARRAY[]::text[]; v_sv_status text;
BEGIN
  SELECT * INTO c FROM public.mkt_content_items WHERE id = p_item_id;
  IF c IS NULL THEN RETURN ARRAY['not_found']; END IF;

  IF c.scope_kind IS NULL                                THEN missing := array_append(missing,'scope'); END IF;
  IF c.owner_user_id IS NULL                             THEN missing := array_append(missing,'owner'); END IF;

  -- An approved strategic source. A draft strategy is not a source you can
  -- commit production time against.
  IF c.strategy_version_id IS NULL THEN
    missing := array_append(missing,'strategy_version');
  ELSE
    SELECT status INTO v_sv_status FROM public.mkt_strategy_versions WHERE id = c.strategy_version_id;
    IF v_sv_status NOT IN ('approved','superseded') THEN
      missing := array_append(missing,'approved_strategy_version');
    END IF;
  END IF;
  IF c.plan_id IS NULL                                   THEN missing := array_append(missing,'plan'); END IF;

  -- A goal, or a stated reason there is none. Silence is not an answer.
  IF c.primary_goal_id IS NULL
     AND (c.always_on_reason IS NULL OR btrim(c.always_on_reason) = '') THEN
    missing := array_append(missing,'goal_or_always_on_reason');
  END IF;

  IF c.target_audience IS NULL OR btrim(c.target_audience) = ''
                                                         THEN missing := array_append(missing,'audience'); END IF;
  IF COALESCE(btrim(c.core_promise), btrim(c.main_idea), '') = ''
                                                         THEN missing := array_append(missing,'message'); END IF;
  IF COALESCE(btrim(c.desired_action), btrim(c.cta), '') = ''
                                                         THEN missing := array_append(missing,'desired_action'); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.mkt_content_deliverables
                  WHERE content_item_id = p_item_id AND archived_at IS NULL) THEN
    missing := array_append(missing,'at_least_one_deliverable');
  END IF;

  RETURN missing;
END $$;

-- What one output needs before it can be scheduled.
CREATE OR REPLACE FUNCTION public.mkt_deliverable_schedule_blockers(p_deliverable_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE d record; missing text[] := ARRAY[]::text[]; s record;
BEGIN
  SELECT * INTO d FROM public.mkt_content_deliverables WHERE id = p_deliverable_id;
  IF d IS NULL THEN RETURN ARRAY['not_found']; END IF;

  -- Legacy deliverables carry no platform (see 2026-08-27_01). Naming it here
  -- is what turns "unclassified" into an actionable item rather than a silent
  -- failure at publish time.
  IF d.platform IS NULL            THEN missing := array_append(missing,'platform'); END IF;
  IF d.social_account_id IS NULL   THEN missing := array_append(missing,'platform_account'); END IF;
  IF d.planned_publish_at IS NULL  THEN missing := array_append(missing,'publish_time'); END IF;

  -- Every artifact its template marks as gating publication must be approved.
  -- Reading it from the template is what makes this correct per format: a text
  -- post has no final_media step, so it is not asked for one.
  FOR s IN
    SELECT ws.artifact_type FROM public.mkt_workflow_steps ws
     WHERE ws.template_key = COALESCE(d.workflow_template_key,
             (SELECT key FROM public.mkt_workflow_templates WHERE format = d.format AND is_active LIMIT 1))
       AND ws.gates_publish AND ws.artifact_type IS NOT NULL
  LOOP
    IF public.mkt_approved_artifact(p_deliverable_id, s.artifact_type) IS NULL THEN
      missing := array_append(missing, 'approved_' || s.artifact_type);
    END IF;
  END LOOP;

  -- A paid deliverable that is not attached to an ad is not actually paid.
  IF d.distribution IN ('paid','both')
     AND NOT EXISTS (SELECT 1 FROM public.mkt_publications
                      WHERE deliverable_id = p_deliverable_id AND ad_id IS NOT NULL) THEN
    missing := array_append(missing,'paid_ad_link');
  END IF;

  RETURN missing;
END $$;

-- Enforce it. A publication may sit in draft while people work; moving it to
-- scheduled/published is the commitment, and that is what is checked.
CREATE OR REPLACE FUNCTION public.mkt_tg_publication_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE blockers text[];
BEGIN
  IF NEW.status NOT IN ('scheduled','publishing','published') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  IF NEW.deliverable_id IS NULL THEN
    RAISE EXCEPTION 'a publication must belong to a deliverable before it can be scheduled'
      USING ERRCODE='check_violation';
  END IF;

  blockers := public.mkt_deliverable_schedule_blockers(NEW.deliverable_id);
  IF array_length(blockers, 1) > 0 THEN
    RAISE EXCEPTION 'cannot schedule this deliverable yet — missing: %',
      array_to_string(blockers, ', ') USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_pub_zz_gate ON public.mkt_publications;
CREATE TRIGGER mkt_pub_zz_gate BEFORE INSERT OR UPDATE ON public.mkt_publications
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_publication_gate();

-- Locking the approved versions onto the publication at schedule time.
CREATE OR REPLACE FUNCTION public.mkt_tg_publication_lock_versions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.deliverable_id IS NOT NULL AND NEW.status IN ('scheduled','publishing','published') THEN
    NEW.locked_copy_version_id := COALESCE(NEW.locked_copy_version_id,
      public.mkt_approved_artifact(NEW.deliverable_id, 'caption'));
    NEW.locked_media_version_id := COALESCE(NEW.locked_media_version_id,
      public.mkt_approved_artifact(NEW.deliverable_id, 'final_media'),
      public.mkt_approved_artifact(NEW.deliverable_id, 'design_file'));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Runs BEFORE the gate (name ordering: lock < zz_gate).
DROP TRIGGER IF EXISTS mkt_pub_lock ON public.mkt_publications;
CREATE TRIGGER mkt_pub_lock BEFORE INSERT OR UPDATE ON public.mkt_publications
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_publication_lock_versions();

-- The brief's own gate: leaving 'idea' requires the activation set.
CREATE OR REPLACE FUNCTION public.mkt_tg_content_activation_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE missing text[];
BEGIN
  IF NEW.status = 'idea' OR NEW.status IN ('cancelled','archived') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NULL; END IF;
  -- Only gate the move OUT of idea. Rows already past it were created before
  -- these fields existed and are flagged by part 4, not blocked retroactively.
  IF TG_OP = 'UPDATE' AND OLD.status <> 'idea' THEN RETURN NULL; END IF;

  missing := public.mkt_content_missing_requirements(NEW.id);
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'content % cannot leave the idea stage yet — missing: %',
      NEW.content_number, array_to_string(missing, ', ') USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END $$;

-- AFTER, so mkt_content_missing_requirements() can read the row by id — the
-- same lesson the goal activation gate learned the hard way.
DROP TRIGGER IF EXISTS mkt_ci_zz_activation_gate ON public.mkt_content_items;
CREATE TRIGGER mkt_ci_zz_activation_gate AFTER INSERT OR UPDATE ON public.mkt_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_content_activation_gate();

-- ── 4. Next action and blockers, computed ───────────────────────────────────
-- next_action and blocker are text columns somebody types today. These replace
-- them with a reading of the actual records; the columns stay so nothing
-- breaks, but no screen should write them again.
CREATE OR REPLACE FUNCTION public.mkt_content_state(p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  c record; missing text[]; v_next jsonb; v_blockers jsonb; v_del int; v_done int; v_total int;
BEGIN
  SELECT * INTO c FROM public.mkt_content_items WHERE id = p_item_id;
  IF c IS NULL THEN RETURN NULL; END IF;

  missing := public.mkt_content_missing_requirements(p_item_id);

  SELECT count(*) INTO v_del FROM public.mkt_content_deliverables
   WHERE content_item_id = p_item_id AND archived_at IS NULL;

  SELECT count(*) FILTER (WHERE status IN ('completed','skipped')), count(*)
    INTO v_done, v_total
    FROM public.mkt_content_tasks
   WHERE content_item_id = p_item_id AND status <> 'cancelled';

  -- The next thing a person should actually do, in dependency order.
  SELECT to_jsonb(t) INTO v_next FROM (
    SELECT tk.id, tk.title, tk.task_type, tk.deliverable_id, tk.assigned_user_id, tk.due_date
      FROM public.mkt_content_tasks tk
     WHERE tk.content_item_id = p_item_id
       AND tk.status IN ('not_started','in_progress','changes_requested')
     ORDER BY tk.sort_order, tk.created_at LIMIT 1) t;

  -- Real blockers: blocked tasks, stale approvals, and unmet activation needs.
  SELECT coalesce(jsonb_agg(b), '[]'::jsonb) INTO v_blockers FROM (
    SELECT jsonb_build_object('kind','task_blocked','id',id,'label',title,
                              'reason', blocked_reason) AS b
      FROM public.mkt_content_tasks
     WHERE content_item_id = p_item_id AND status = 'blocked' AND blocked_reason IS NOT NULL
    UNION ALL
    SELECT jsonb_build_object('kind','stale_artifact','id',v.id,
                              'label', v.version_type, 'reason', v.stale_reason)
      FROM public.mkt_content_versions v
     WHERE v.content_item_id = p_item_id AND v.is_stale AND v.approval_state = 'approved'
  ) x;

  RETURN jsonb_build_object(
    'status', c.status,
    'missing', to_jsonb(missing),
    'is_activatable', array_length(missing,1) IS NULL,
    'deliverables', v_del,
    'tasks_done', v_done, 'tasks_total', v_total,
    'progress_pct', CASE WHEN v_total = 0 THEN NULL
                         ELSE round((v_done::numeric / v_total) * 100) END,
    'next_action', v_next,
    'blockers', v_blockers,
    'is_overdue', c.due_date IS NOT NULL AND c.due_date < current_date
                  AND c.status NOT IN ('published','cancelled','archived'));
END $$;

-- ── 5. Assets: the library works in both directions ─────────────────────────
-- mkt_asset_links is already polymorphic (target_type/target_id), so a
-- deliverable link needs no new table — only permission to say 'deliverable'
-- and an index that makes the reverse lookup cheap.
ALTER TABLE public.mkt_asset_links
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS note text;

-- The link knew project / campaign / content_item / scene / slide / publication
-- but not 'deliverable' — which is now the thing production work attaches to.
-- Both the auto-library trigger and the backfill write it. Additive: every
-- existing target_type stays legal.
ALTER TABLE public.mkt_asset_links DROP CONSTRAINT IF EXISTS mkt_asset_links_target_type_check;
ALTER TABLE public.mkt_asset_links ADD CONSTRAINT mkt_asset_links_target_type_check
  CHECK (target_type IN ('project','campaign','content_item','deliverable','scene','slide','publication'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_asset_links_role_check') THEN
    ALTER TABLE public.mkt_asset_links ADD CONSTRAINT mkt_asset_links_role_check
      CHECK (role IS NULL OR role IN ('source','working','final','reference')) NOT VALID;
    ALTER TABLE public.mkt_asset_links VALIDATE CONSTRAINT mkt_asset_links_role_check;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mkt_asset_link_unique
  ON public.mkt_asset_links(asset_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_mkt_asset_links_target
  ON public.mkt_asset_links(target_type, target_id);

-- raw / working / final classification, and the parent an asset was derived
-- from — so "this cut came from that footage" is an edge, not a note.
ALTER TABLE public.mkt_raw_assets
  ADD COLUMN IF NOT EXISTS asset_class text NOT NULL DEFAULT 'raw',
  ADD COLUMN IF NOT EXISTS parent_asset_id uuid REFERENCES public.mkt_raw_assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_raw_asset_class_check') THEN
    ALTER TABLE public.mkt_raw_assets ADD CONSTRAINT mkt_raw_asset_class_check
      CHECK (asset_class IN ('raw','working','final')) NOT VALID;
    ALTER TABLE public.mkt_raw_assets VALIDATE CONSTRAINT mkt_raw_asset_class_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_raw_asset_no_self_parent') THEN
    ALTER TABLE public.mkt_raw_assets ADD CONSTRAINT mkt_raw_asset_no_self_parent
      CHECK (parent_asset_id IS NULL OR parent_asset_id <> id) NOT VALID;
    ALTER TABLE public.mkt_raw_assets VALIDATE CONSTRAINT mkt_raw_asset_no_self_parent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_raw_asset_source_kind_check') THEN
    ALTER TABLE public.mkt_raw_assets ADD CONSTRAINT mkt_raw_asset_source_kind_check
      CHECK (source_kind IS NULL OR source_kind IN
        ('in_house','developer','stock','client','ugc','ai_generated','other')) NOT VALID;
    ALTER TABLE public.mkt_raw_assets VALIDATE CONSTRAINT mkt_raw_asset_source_kind_check;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_raw_assets_parent ON public.mkt_raw_assets(parent_asset_id);
CREATE INDEX IF NOT EXISTS idx_mkt_raw_assets_class ON public.mkt_raw_assets(asset_class)
  WHERE archived_at IS NULL;

-- Approving final media registers it in the library automatically, so the
-- library is never missing the one asset people actually want to find again.
CREATE OR REPLACE FUNCTION public.mkt_tg_final_media_to_library()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE d record; c record; v_asset uuid;
BEGIN
  IF NEW.approval_state <> 'approved' OR NEW.version_type <> 'final_media'
     OR NEW.file_id IS NULL OR NEW.deliverable_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.approval_state = 'approved' THEN RETURN NULL; END IF;

  SELECT * INTO d FROM public.mkt_content_deliverables WHERE id = NEW.deliverable_id;
  SELECT * INTO c FROM public.mkt_content_items WHERE id = NEW.content_item_id;

  -- One library row per file: re-approving the same file must not duplicate it.
  SELECT id INTO v_asset FROM public.mkt_raw_assets WHERE file_id = NEW.file_id LIMIT 1;
  IF v_asset IS NULL THEN
    INSERT INTO public.mkt_raw_assets
      (file_id, asset_name, asset_type, asset_class, project_id, source_kind,
       owner_user_id, uploaded_by_user_id, approval_status, usage_status)
    VALUES
      (NEW.file_id,
       COALESCE(NULLIF(d.label,''), c.title)
         || CASE WHEN d.platform IS NULL THEN '' ELSE ' — ' || d.platform END,
       -- asset_type is a SUBJECT taxonomy (property_photo, drone_footage,
       -- brochure, …) — there is no 'video' or 'image' in it, and usage_status
       -- is 'in_use', not 'used'. Getting either wrong raises 23514 at approval
       -- time. 'custom' because nothing here knows what the footage is OF;
       -- media kind is already carried by mime_type / duration_ms / width.
       'custom',
       'final', c.project_id, 'in_house',
       COALESCE(d.owner_user_id, c.owner_user_id), NEW.approved_by_user_id,
       'approved', 'in_use')
    RETURNING id INTO v_asset;
  ELSE
    UPDATE public.mkt_raw_assets
       SET asset_class = 'final', usage_status = 'in_use'
     WHERE id = v_asset AND asset_class <> 'final';
  END IF;

  INSERT INTO public.mkt_asset_links (asset_id, target_type, target_id, role, created_by_user_id)
  VALUES (v_asset, 'deliverable', NEW.deliverable_id, 'final', NEW.approved_by_user_id)
  ON CONFLICT (asset_id, target_type, target_id) DO NOTHING;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mkt_cv_zz_final_to_library ON public.mkt_content_versions;
CREATE TRIGGER mkt_cv_zz_final_to_library AFTER INSERT OR UPDATE ON public.mkt_content_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_final_media_to_library();

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_content_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_content_results_read ON public.mkt_content_results;
DROP POLICY IF EXISTS mkt_content_results_ins ON public.mkt_content_results;
DROP POLICY IF EXISTS mkt_content_results_upd ON public.mkt_content_results;
DROP POLICY IF EXISTS mkt_content_results_del ON public.mkt_content_results;
CREATE POLICY mkt_content_results_read ON public.mkt_content_results FOR SELECT TO authenticated
  USING (public.wassell_mkt_can('read'));
CREATE POLICY mkt_content_results_ins ON public.mkt_content_results FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mkt_can('write_content'));
CREATE POLICY mkt_content_results_upd ON public.mkt_content_results FOR UPDATE TO authenticated
  USING (public.wassell_mkt_can('write_content'));
CREATE POLICY mkt_content_results_del ON public.mkt_content_results FOR DELETE TO authenticated
  USING (public.wassell_mkt_can('write_content'));

COMMIT;
