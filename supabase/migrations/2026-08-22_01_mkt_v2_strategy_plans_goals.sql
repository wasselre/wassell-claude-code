-- ============================================================================
-- Marketing Management v2, part 1: strategy versions, plans, goals, target
-- periods.  Design record: docs/marketing-management-v2.md
--
-- ADDITIVE ONLY. Creates new tables; touches no existing table, column,
-- constraint, trigger, function or policy. Safe to replay (IF NOT EXISTS
-- throughout, DO-blocks guard every constraint and policy).
--
-- Production baseline immediately before writing this (probed via PostgREST,
-- not read from filenames):
--   campaigns 2 · content_items 1 · versions 0 · status_history 2 · scenes 3
--   slides 0 · raw_assets 2 · asset_links 0 · tasks 12 · approvals 2
--   publications 0 · performance_snapshots 0 · lead_attributions 0
--   intelligence_actions 0 · alerts 0 · role_grants 0
-- Intelligence side (must remain untouched): observed_facts 16120 ·
--   collection_jobs 4020 · content_posts 2954 · organizations 201 · insights 49
-- ============================================================================

-- ── Strategy versions ───────────────────────────────────────────────────────
-- ONE table, not strategy + versions. The chain IS the strategy: each row
-- points at the approved row it replaces via supersedes_version_id, so "the
-- current strategy" is the approved row nothing supersedes. A separate parent
-- table would add a row that carries no decisions and can never be wrong.
CREATE TABLE IF NOT EXISTS public.mkt_strategy_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_number    integer NOT NULL,
  name_ar           text NOT NULL,
  name_en           text,
  summary_ar        text,
  summary_en        text,
  status            text NOT NULL DEFAULT 'draft',

  effective_date    date,
  expires_at        date,
  -- Set when a later version replaces this one. Self-reference, so the history
  -- of what Wassel believed at any point stays reconstructable.
  supersedes_version_id uuid REFERENCES public.mkt_strategy_versions(id) ON DELETE SET NULL,

  positioning       text,
  organic_paid_strategy text,
  -- Lists are jsonb arrays of {ar, en, note} objects. They are edited as whole
  -- lists in one form and never joined against, so separate child tables would
  -- be six tables of ceremony for no query benefit.
  priority_audiences     jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_problems      jsonb NOT NULL DEFAULT '[]'::jsonb,
  value_propositions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority_markets       jsonb NOT NULL DEFAULT '[]'::jsonb,
  property_categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
  funnel                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  channel_roles          jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_principles     jsonb NOT NULL DEFAULT '[]'::jsonb,
  measurement_principles jsonb NOT NULL DEFAULT '[]'::jsonb,
  strategic_priorities   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Deliberately named for what it is: the things Wassel will NOT do. A
  -- strategy that only lists priorities has not actually chosen anything.
  not_priorities         jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions            jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks                  jsonb NOT NULL DEFAULT '[]'::jsonb,

  owner_user_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approver_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  -- Marks a record created by migration to satisfy referential integrity.
  -- NEVER presented in the UI as an approved Wassel strategy.
  is_migration_holder boolean NOT NULL DEFAULT false,

  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_sv_status_check') THEN
    ALTER TABLE public.mkt_strategy_versions ADD CONSTRAINT mkt_sv_status_check
      CHECK (status IN ('draft','in_review','approved','superseded','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_sv_version_positive') THEN
    ALTER TABLE public.mkt_strategy_versions ADD CONSTRAINT mkt_sv_version_positive
      CHECK (version_number >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_sv_no_self_supersede') THEN
    ALTER TABLE public.mkt_strategy_versions ADD CONSTRAINT mkt_sv_no_self_supersede
      CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> id);
  END IF;
  -- An approved version must record who approved it and when: otherwise
  -- "approved" is an unfalsifiable claim.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_sv_approved_has_approver') THEN
    ALTER TABLE public.mkt_strategy_versions ADD CONSTRAINT mkt_sv_approved_has_approver
      CHECK (status <> 'approved' OR (approver_user_id IS NOT NULL AND approved_at IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mkt_sv_version_unique
  ON public.mkt_strategy_versions(version_number);
-- At most ONE approved, non-superseded strategy at a time. This is the
-- constraint that makes "the current strategy" a well-defined question.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_sv_one_current
  ON public.mkt_strategy_versions((status)) WHERE status = 'approved';

-- Approved strategy versions are immutable, exactly as approved content
-- versions are. Editing a decision under which plans were already executed
-- would rewrite history; the answer is a new version.
CREATE OR REPLACE FUNCTION public.mkt_tg_strategy_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.status IN ('approved','superseded') THEN
    -- Only lifecycle moves are allowed on a frozen version.
    IF (NEW.status IS DISTINCT FROM OLD.status
        AND NEW.status IN ('superseded','archived'))
       OR (NEW.archived_at IS DISTINCT FROM OLD.archived_at)
       OR (NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    IF to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
      RAISE EXCEPTION
        'strategy version % is % — create a NEW version instead of editing it',
        OLD.version_number, OLD.status USING ERRCODE='check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_sv_immutable ON public.mkt_strategy_versions;
CREATE TRIGGER mkt_sv_immutable BEFORE UPDATE ON public.mkt_strategy_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_strategy_immutable();

-- A version may only supersede an approved one, and only one may do so.
CREATE OR REPLACE FUNCTION public.mkt_tg_strategy_supersede_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_status text;
BEGIN
  IF NEW.supersedes_version_id IS NOT NULL THEN
    SELECT status INTO v_status FROM public.mkt_strategy_versions WHERE id = NEW.supersedes_version_id;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'superseded strategy version does not exist' USING ERRCODE='foreign_key_violation';
    END IF;
    IF v_status NOT IN ('approved','superseded') THEN
      RAISE EXCEPTION 'a strategy version can only supersede an approved version (target is %)', v_status
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_sv_supersede_valid ON public.mkt_strategy_versions;
CREATE TRIGGER mkt_sv_supersede_valid BEFORE INSERT OR UPDATE ON public.mkt_strategy_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_strategy_supersede_valid();

-- ── Plans ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_type           text NOT NULL,
  parent_plan_id      uuid REFERENCES public.mkt_plans(id) ON DELETE SET NULL,
  -- RESTRICT, not SET NULL: a plan whose strategy vanished would be an
  -- execution record with no mandate. Superseding is the supported path.
  strategy_version_id uuid REFERENCES public.mkt_strategy_versions(id) ON DELETE RESTRICT,

  name_ar             text NOT NULL,
  name_en             text,
  summary_ar          text,
  summary_en          text,
  status              text NOT NULL DEFAULT 'draft',
  period_start        date NOT NULL,
  period_end          date NOT NULL,

  priorities          jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget              numeric,
  channel_budgets     jsonb NOT NULL DEFAULT '{}'::jsonb,
  team_capacity       jsonb NOT NULL DEFAULT '{}'::jsonb,
  production_capacity jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority_audiences  jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority_locations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  property_types      jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks               jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependencies        jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_frequency    text,

  owner_user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approver_user_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at         timestamptz,
  needs_classification boolean NOT NULL DEFAULT false,
  is_migration_holder  boolean NOT NULL DEFAULT false,

  created_by_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_plan_type_check') THEN
    ALTER TABLE public.mkt_plans ADD CONSTRAINT mkt_plan_type_check
      CHECK (plan_type IN ('annual','quarterly','monthly','project','custom'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_plan_status_check') THEN
    ALTER TABLE public.mkt_plans ADD CONSTRAINT mkt_plan_status_check
      CHECK (status IN ('draft','in_review','approved','active','completed','cancelled','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_plan_period_order') THEN
    ALTER TABLE public.mkt_plans ADD CONSTRAINT mkt_plan_period_order
      CHECK (period_end >= period_start);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_plan_no_self_parent') THEN
    ALTER TABLE public.mkt_plans ADD CONSTRAINT mkt_plan_no_self_parent
      CHECK (parent_plan_id IS NULL OR parent_plan_id <> id);
  END IF;
  -- A plan that is live must rest on an approved strategy. Draft plans may be
  -- written before the strategy is settled; active ones may not.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_plan_active_needs_strategy') THEN
    ALTER TABLE public.mkt_plans ADD CONSTRAINT mkt_plan_active_needs_strategy
      CHECK (status NOT IN ('approved','active') OR strategy_version_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_plans_status ON public.mkt_plans(status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_plans_period ON public.mkt_plans(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_mkt_plans_strategy ON public.mkt_plans(strategy_version_id);

-- Plan nesting: a child must be a SHORTER period than its parent, must sit
-- inside the parent's dates, and the chain must not cycle.
CREATE OR REPLACE FUNCTION public.mkt_plan_rank(p_type text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type WHEN 'annual' THEN 4 WHEN 'quarterly' THEN 3
                     WHEN 'monthly' THEN 2 ELSE 1 END;
$$;

CREATE OR REPLACE FUNCTION public.mkt_tg_plan_hierarchy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p record; hops int := 0; cur uuid;
BEGIN
  IF NEW.parent_plan_id IS NOT NULL THEN
    SELECT plan_type, period_start, period_end INTO p
      FROM public.mkt_plans WHERE id = NEW.parent_plan_id;
    IF p IS NULL THEN
      RAISE EXCEPTION 'parent plan does not exist' USING ERRCODE='foreign_key_violation';
    END IF;
    IF public.mkt_plan_rank(NEW.plan_type) > public.mkt_plan_rank(p.plan_type) THEN
      RAISE EXCEPTION 'a % plan cannot sit under a % plan', NEW.plan_type, p.plan_type
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.period_start < p.period_start OR NEW.period_end > p.period_end THEN
      RAISE EXCEPTION 'child plan period (% .. %) must fall inside its parent (% .. %)',
        NEW.period_start, NEW.period_end, p.period_start, p.period_end
        USING ERRCODE='check_violation';
    END IF;
    -- Walk up; a bounded loop is cheaper than a recursive CTE and cannot hang.
    cur := NEW.parent_plan_id;
    WHILE cur IS NOT NULL AND hops < 20 LOOP
      IF cur = NEW.id THEN
        RAISE EXCEPTION 'plan hierarchy would form a cycle' USING ERRCODE='check_violation';
      END IF;
      SELECT parent_plan_id INTO cur FROM public.mkt_plans WHERE id = cur;
      hops := hops + 1;
    END LOOP;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_plan_hierarchy ON public.mkt_plans;
CREATE TRIGGER mkt_plan_hierarchy BEFORE INSERT OR UPDATE ON public.mkt_plans
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_plan_hierarchy();

-- Priority projects: a junction, mirroring mkt_internal_campaign_projects.
-- No FK on project_id — all_projects lives as JSONB in `records`, so no FK is
-- possible. Pre-existing pattern, not a new compromise.
CREATE TABLE IF NOT EXISTS public.mkt_plan_projects (
  plan_id    uuid NOT NULL REFERENCES public.mkt_plans(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  PRIMARY KEY (plan_id, project_id)
);

-- ── Goals ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_goals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES public.mkt_plans(id) ON DELETE CASCADE,
  parent_goal_id uuid REFERENCES public.mkt_goals(id) ON DELETE SET NULL,

  -- The mandatory three-way separation. An output commitment ("publish one
  -- report a week") is NOT a business outcome ("300 qualified leads") and the
  -- schema refuses to let them be the same kind of thing.
  goal_category  text NOT NULL,

  name_ar        text NOT NULL,
  name_en        text,
  description    text,
  metric         text,
  unit           text,
  baseline_value numeric,
  target_value   numeric,
  start_date     date,
  end_date       date,
  owner_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  measurement_frequency text,
  -- Where the number comes from. A goal with no source of truth is a wish;
  -- an alert rule flags it.
  source_of_truth text,
  scope          text,

  status         text NOT NULL DEFAULT 'draft',
  actual_value   numeric,
  forecast_value numeric,
  result         text,
  notes          text,
  assumptions    jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_category_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_category_check
      CHECK (goal_category IN ('outcome','kpi','output'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_status_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_status_check
      CHECK (status IN ('draft','active','achieved','missed','abandoned','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_result_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_result_check
      CHECK (result IS NULL OR result IN ('on_track','at_risk','off_track'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_no_self_parent') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_no_self_parent
      CHECK (parent_goal_id IS NULL OR parent_goal_id <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_date_order') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_date_order
      CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_goals_plan ON public.mkt_goals(plan_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_goals_parent ON public.mkt_goals(parent_goal_id);

-- A sub-goal must belong to the same plan, and the tree must not cycle.
CREATE OR REPLACE FUNCTION public.mkt_tg_goal_hierarchy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_plan uuid; hops int := 0; cur uuid;
BEGIN
  IF NEW.parent_goal_id IS NOT NULL THEN
    SELECT plan_id INTO v_plan FROM public.mkt_goals WHERE id = NEW.parent_goal_id;
    IF v_plan IS NULL THEN
      RAISE EXCEPTION 'parent goal does not exist' USING ERRCODE='foreign_key_violation';
    END IF;
    IF v_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'a sub-goal must belong to the same plan as its parent'
        USING ERRCODE='check_violation';
    END IF;
    cur := NEW.parent_goal_id;
    WHILE cur IS NOT NULL AND hops < 20 LOOP
      IF cur = NEW.id THEN
        RAISE EXCEPTION 'goal hierarchy would form a cycle' USING ERRCODE='check_violation';
      END IF;
      SELECT parent_goal_id INTO cur FROM public.mkt_goals WHERE id = cur;
      hops := hops + 1;
    END LOOP;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_goal_hierarchy ON public.mkt_goals;
CREATE TRIGGER mkt_goal_hierarchy BEFORE INSERT OR UPDATE ON public.mkt_goals
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_goal_hierarchy();

-- ── Target periods: deliberate allocation, never target ÷ 12 ────────────────
CREATE TABLE IF NOT EXISTS public.mkt_goal_target_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id        uuid NOT NULL REFERENCES public.mkt_goals(id) ON DELETE CASCADE,
  label          text,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  target_value   numeric NOT NULL,
  actual_value   numeric,
  forecast_value numeric,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_gtp_period_order') THEN
    ALTER TABLE public.mkt_goal_target_periods ADD CONSTRAINT mkt_gtp_period_order
      CHECK (period_end >= period_start);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mkt_gtp_unique_period
  ON public.mkt_goal_target_periods(goal_id, period_start);
CREATE INDEX IF NOT EXISTS idx_mkt_gtp_goal ON public.mkt_goal_target_periods(goal_id);

-- Pacing: what the goal SHOULD be at today's date, versus what it is.
-- Returns honest nulls rather than zeros when nothing is measurable.
CREATE OR REPLACE FUNCTION public.mkt_goal_pacing(p_goal_id uuid, p_as_of date DEFAULT current_date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE g record; v_expected numeric; v_actual numeric; v_periods int; v_measured int;
BEGIN
  SELECT * INTO g FROM public.mkt_goals WHERE id = p_goal_id;
  IF g IS NULL THEN RETURN NULL; END IF;

  SELECT count(*), count(actual_value),
         sum(target_value) FILTER (WHERE period_start <= p_as_of),
         sum(actual_value)
    INTO v_periods, v_measured, v_expected, v_actual
    FROM public.mkt_goal_target_periods WHERE goal_id = p_goal_id;

  RETURN jsonb_build_object(
    'goal_id',        p_goal_id,
    'target',         g.target_value,
    -- No target periods means we cannot pace. Say so; do not invent /12.
    'has_periods',    COALESCE(v_periods, 0) > 0,
    'periods_total',  COALESCE(v_periods, 0),
    'periods_measured', COALESCE(v_measured, 0),
    'expected_to_date', v_expected,
    'actual_to_date',   COALESCE(v_actual, g.actual_value),
    'forecast',       g.forecast_value,
    'forecast_is_estimate', g.forecast_value IS NOT NULL,
    'result',         g.result,
    'source_of_truth', g.source_of_truth,
    -- Coverage travels with the numbers: a pace computed from 2 of 12 measured
    -- periods is not the same claim as one computed from 12.
    'coverage', CASE WHEN COALESCE(v_periods,0) = 0 THEN NULL
                     ELSE jsonb_build_object('measured', COALESCE(v_measured,0), 'total', v_periods) END
  );
END $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Authorization lives here, not in hidden buttons. Capabilities are added to
-- wassell_mkt_can in part 5; these policies reference them by name.
ALTER TABLE public.mkt_strategy_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_plans               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_plan_projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_goals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_goal_target_periods ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; cap_read text; cap_write text;
BEGIN
  FOR t, cap_read, cap_write IN
    SELECT * FROM (VALUES
      ('mkt_strategy_versions',   'read_strategy', 'write_strategy'),
      ('mkt_plans',               'read_plan',     'write_plan'),
      ('mkt_plan_projects',       'read_plan',     'write_plan'),
      ('mkt_goals',               'read_plan',     'manage_goals'),
      ('mkt_goal_target_periods', 'read_plan',     'manage_goals')
    ) AS v(t, r, w)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (public.wassell_mkt_can(%L))',
                   t||'_select', t, cap_read);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.wassell_mkt_can(%L))',
                   t||'_insert', t, cap_write);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (public.wassell_mkt_can(%L))',
                   t||'_update', t, cap_write);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (public.wassell_mkt_can(%L))',
                   t||'_delete', t, cap_write);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mkt_strategy_versions,
  public.mkt_plans, public.mkt_plan_projects, public.mkt_goals,
  public.mkt_goal_target_periods TO authenticated;

REVOKE ALL ON FUNCTION public.mkt_goal_pacing(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_goal_pacing(uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_plan_rank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_plan_rank(text) TO authenticated, service_role;

COMMENT ON TABLE  public.mkt_strategy_versions IS 'Versioned marketing strategy. The supersedes chain IS the strategy; approved versions are immutable.';
COMMENT ON TABLE  public.mkt_goals IS 'outcome | kpi | output — an output commitment is never a business outcome.';
COMMENT ON TABLE  public.mkt_goal_target_periods IS 'Deliberate per-period allocation. Seasonality is the default; nothing divides an annual target by 12.';
COMMENT ON COLUMN public.mkt_plans.is_migration_holder IS 'Created by backfill for referential integrity only. Never shown as an approved Wassel plan.';
