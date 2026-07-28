-- ============================================================================
-- Marketing Management v2, part 2: initiatives, programs, the extended campaign,
-- and secondary-goal relations.  Design: docs/marketing-management-v2.md
--
-- ADDITIVE. mkt_internal_campaigns is EXTENDED, never replaced: it holds two
-- live rows whose ids, codes, dates, budgets and content links must survive.
-- Its existing columns (objective, target_leads, target_revenue, target_cpl,
-- target_roas …) are left exactly as they are for compatibility; goals become
-- the authoritative target without deleting the campaign-local copies.
-- ============================================================================

-- ── Initiatives ─────────────────────────────────────────────────────────────
-- The preferred umbrella for related paid AND organic work. Paid and organic
-- campaigns hang off the SAME initiative as siblings; neither depends on the
-- other technically.
CREATE TABLE IF NOT EXISTS public.mkt_initiatives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid REFERENCES public.mkt_plans(id) ON DELETE RESTRICT,
  primary_goal_id uuid REFERENCES public.mkt_goals(id) ON DELETE RESTRICT,

  name_ar         text NOT NULL,
  name_en         text,
  problem_or_opportunity text,
  hypothesis      text,

  target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb,
  scope           text,
  locations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  property_types  jsonb NOT NULL DEFAULT '[]'::jsonb,
  channels        jsonb NOT NULL DEFAULT '[]'::jsonb,

  start_date      date,
  review_date     date,
  end_date        date,
  budget          numeric,
  owner_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'proposed',

  expected_contribution text,
  actual_contribution   text,
  results         jsonb NOT NULL DEFAULT '{}'::jsonb,
  lessons         text,
  -- The decision a review reaches about this initiative.
  decision        text,
  decision_note   text,
  decided_at      timestamptz,

  needs_classification boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

CREATE TABLE IF NOT EXISTS public.mkt_initiative_projects (
  initiative_id uuid NOT NULL REFERENCES public.mkt_initiatives(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL,          -- all_projects is JSONB in `records`; no FK possible
  PRIMARY KEY (initiative_id, project_id)
);

-- ── Programs ────────────────────────────────────────────────────────────────
-- Ongoing and repeatable. NO end date is required — the whole point is that a
-- program must not be forced into a fake permanent campaign.
CREATE TABLE IF NOT EXISTS public.mkt_programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid REFERENCES public.mkt_plans(id) ON DELETE RESTRICT,
  initiative_id   uuid REFERENCES public.mkt_initiatives(id) ON DELETE SET NULL,
  primary_goal_id uuid REFERENCES public.mkt_goals(id) ON DELETE RESTRICT,

  name_ar         text NOT NULL,
  name_en         text,
  purpose         text,
  target_audience text,

  content_pillars jsonb NOT NULL DEFAULT '[]'::jsonb,
  platforms       jsonb NOT NULL DEFAULT '[]'::jsonb,
  accounts        jsonb NOT NULL DEFAULT '[]'::jsonb,
  formats         jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- The recurring commitment, e.g. 1 per week. An alert fires when a period
  -- passes without the committed output.
  cadence         text,
  commitment_count integer,
  commitment_unit  text,

  kpi_targets     jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  review_frequency text,
  status          text NOT NULL DEFAULT 'draft',
  start_date      date,                 -- optional; no end date by design

  performance     jsonb NOT NULL DEFAULT '{}'::jsonb,
  lessons         text,
  decision        text,
  decision_note   text,
  decided_at      timestamptz,

  needs_classification boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_init_status_check') THEN
    ALTER TABLE public.mkt_initiatives ADD CONSTRAINT mkt_init_status_check
      CHECK (status IN ('proposed','active','paused','completed','cancelled','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_init_decision_check') THEN
    ALTER TABLE public.mkt_initiatives ADD CONSTRAINT mkt_init_decision_check
      CHECK (decision IS NULL OR decision IN ('continue','change','scale','pause','stop'));
  END IF;
  -- An ACTIVE initiative must have a plan, a primary goal and an owner. Draft
  -- and proposed rows may be incomplete — that is where thinking happens.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_init_active_complete') THEN
    ALTER TABLE public.mkt_initiatives ADD CONSTRAINT mkt_init_active_complete
      CHECK (status <> 'active'
             OR (plan_id IS NOT NULL AND primary_goal_id IS NOT NULL AND owner_user_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_init_date_order') THEN
    ALTER TABLE public.mkt_initiatives ADD CONSTRAINT mkt_init_date_order
      CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_prog_status_check') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_status_check
      CHECK (status IN ('draft','active','paused','retired','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_prog_decision_check') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_decision_check
      CHECK (decision IS NULL OR decision IN ('continue','change','scale','pause','stop'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_prog_active_complete') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_active_complete
      CHECK (status <> 'active'
             OR (plan_id IS NOT NULL AND primary_goal_id IS NOT NULL AND owner_user_id IS NOT NULL));
  END IF;
  -- A commitment needs both a number and a unit, or neither.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_prog_commitment_pair') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_commitment_pair
      CHECK ((commitment_count IS NULL) = (commitment_unit IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_prog_commitment_unit_check') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_commitment_unit_check
      CHECK (commitment_unit IS NULL OR commitment_unit IN ('day','week','month','quarter'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_init_plan ON public.mkt_initiatives(plan_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_init_goal ON public.mkt_initiatives(primary_goal_id);
CREATE INDEX IF NOT EXISTS idx_mkt_prog_plan ON public.mkt_programs(plan_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_prog_init ON public.mkt_programs(initiative_id);
CREATE INDEX IF NOT EXISTS idx_mkt_prog_goal ON public.mkt_programs(primary_goal_id);

-- ── Extend the EXISTING campaigns table ─────────────────────────────────────
ALTER TABLE public.mkt_internal_campaigns
  ADD COLUMN IF NOT EXISTS plan_id         uuid REFERENCES public.mkt_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS initiative_id   uuid REFERENCES public.mkt_initiatives(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS program_id      uuid REFERENCES public.mkt_programs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_goal_id uuid REFERENCES public.mkt_goals(id) ON DELETE RESTRICT,
  -- organic | paid. The distinction the brief requires at minimum. Existing
  -- campaign_type is preserved and untouched; this is the orthogonal axis.
  ADD COLUMN IF NOT EXISTS campaign_class  text,
  ADD COLUMN IF NOT EXISTS funnel_stage    text,
  ADD COLUMN IF NOT EXISTS deliverables    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS actual_results  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lessons         text,
  ADD COLUMN IF NOT EXISTS decision        text,
  ADD COLUMN IF NOT EXISTS decision_note   text,
  ADD COLUMN IF NOT EXISTS decided_at      timestamptz,
  ADD COLUMN IF NOT EXISTS needs_classification boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_camp_class_check') THEN
    ALTER TABLE public.mkt_internal_campaigns ADD CONSTRAINT mkt_camp_class_check
      CHECK (campaign_class IS NULL OR campaign_class IN ('organic','paid')) NOT VALID;
    ALTER TABLE public.mkt_internal_campaigns VALIDATE CONSTRAINT mkt_camp_class_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_camp_decision_check') THEN
    ALTER TABLE public.mkt_internal_campaigns ADD CONSTRAINT mkt_camp_decision_check
      CHECK (decision IS NULL OR decision IN ('continue','change','scale','pause','stop')) NOT VALID;
    ALTER TABLE public.mkt_internal_campaigns VALIDATE CONSTRAINT mkt_camp_decision_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_camp_funnel_check') THEN
    ALTER TABLE public.mkt_internal_campaigns ADD CONSTRAINT mkt_camp_funnel_check
      CHECK (funnel_stage IS NULL OR funnel_stage IN
             ('awareness','consideration','decision','retention')) NOT VALID;
    ALTER TABLE public.mkt_internal_campaigns VALIDATE CONSTRAINT mkt_camp_funnel_check;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_camp_plan ON public.mkt_internal_campaigns(plan_id);
CREATE INDEX IF NOT EXISTS idx_mkt_camp_init ON public.mkt_internal_campaigns(initiative_id);
CREATE INDEX IF NOT EXISTS idx_mkt_camp_goal ON public.mkt_internal_campaigns(primary_goal_id);

-- A campaign under an initiative must share that initiative's plan, and must
-- sit inside its plan's dates. Deliberately a trigger, not a CHECK: a CHECK
-- cannot reference another table.
CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_portfolio_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_init_plan uuid; v_prog_plan uuid; p record;
BEGIN
  IF NEW.initiative_id IS NOT NULL THEN
    SELECT plan_id INTO v_init_plan FROM public.mkt_initiatives WHERE id = NEW.initiative_id;
    IF NEW.plan_id IS NOT NULL AND v_init_plan IS NOT NULL AND v_init_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'campaign plan and its initiative plan must match'
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.plan_id IS NULL THEN NEW.plan_id := v_init_plan; END IF;
  END IF;

  IF NEW.program_id IS NOT NULL THEN
    SELECT plan_id INTO v_prog_plan FROM public.mkt_programs WHERE id = NEW.program_id;
    IF NEW.plan_id IS NOT NULL AND v_prog_plan IS NOT NULL AND v_prog_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'campaign plan and its related program plan must match'
        USING ERRCODE='check_violation';
    END IF;
  END IF;

  -- Campaign dates must fall inside the plan period. Flagged as an alert too,
  -- but rejected here so the data cannot be quietly wrong.
  IF NEW.plan_id IS NOT NULL AND NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL THEN
    SELECT period_start, period_end INTO p FROM public.mkt_plans WHERE id = NEW.plan_id;
    IF p IS NOT NULL AND (NEW.start_date < p.period_start OR NEW.end_date > p.period_end) THEN
      RAISE EXCEPTION 'campaign dates (% .. %) fall outside its plan period (% .. %)',
        NEW.start_date, NEW.end_date, p.period_start, p.period_end
        USING ERRCODE='check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_camp_portfolio_valid ON public.mkt_internal_campaigns;
CREATE TRIGGER mkt_camp_portfolio_valid BEFORE INSERT OR UPDATE ON public.mkt_internal_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_campaign_portfolio_valid();

-- A program under an initiative must likewise share its plan.
CREATE OR REPLACE FUNCTION public.mkt_tg_program_portfolio_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_init_plan uuid;
BEGIN
  IF NEW.initiative_id IS NOT NULL THEN
    SELECT plan_id INTO v_init_plan FROM public.mkt_initiatives WHERE id = NEW.initiative_id;
    IF NEW.plan_id IS NOT NULL AND v_init_plan IS NOT NULL AND v_init_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'program plan and its initiative plan must match' USING ERRCODE='check_violation';
    END IF;
    IF NEW.plan_id IS NULL THEN NEW.plan_id := v_init_plan; END IF;
  END IF;
  -- A goal must belong to the same plan as the activity that serves it.
  IF NEW.primary_goal_id IS NOT NULL AND NEW.plan_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.mkt_goals
                    WHERE id = NEW.primary_goal_id AND plan_id = NEW.plan_id) THEN
      RAISE EXCEPTION 'the primary goal must belong to the same plan as the program'
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_prog_portfolio_valid ON public.mkt_programs;
CREATE TRIGGER mkt_prog_portfolio_valid BEFORE INSERT OR UPDATE ON public.mkt_programs
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_program_portfolio_valid();

CREATE OR REPLACE FUNCTION public.mkt_tg_initiative_goal_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.primary_goal_id IS NOT NULL AND NEW.plan_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.mkt_goals
                    WHERE id = NEW.primary_goal_id AND plan_id = NEW.plan_id) THEN
      RAISE EXCEPTION 'the primary goal must belong to the same plan as the initiative'
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_init_goal_valid ON public.mkt_initiatives;
CREATE TRIGGER mkt_init_goal_valid BEFORE INSERT OR UPDATE ON public.mkt_initiatives
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_initiative_goal_valid();

-- ── Secondary goals: explicit relation records, no polymorphic string ───────
-- One nullable FK per activity kind + a CHECK that exactly one is set. Every
-- reference is verifiable by the database; there is no entity_type text column
-- that could point at nothing.
CREATE TABLE IF NOT EXISTS public.mkt_activity_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id       uuid NOT NULL REFERENCES public.mkt_goals(id) ON DELETE CASCADE,
  initiative_id uuid REFERENCES public.mkt_initiatives(id) ON DELETE CASCADE,
  program_id    uuid REFERENCES public.mkt_programs(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  relation      text NOT NULL DEFAULT 'secondary',
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ag_exactly_one_target') THEN
    ALTER TABLE public.mkt_activity_goals ADD CONSTRAINT mkt_ag_exactly_one_target
      CHECK ((initiative_id IS NOT NULL)::int + (program_id IS NOT NULL)::int
           + (campaign_id IS NOT NULL)::int = 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ag_relation_check') THEN
    ALTER TABLE public.mkt_activity_goals ADD CONSTRAINT mkt_ag_relation_check
      CHECK (relation IN ('secondary','contributing'));
  END IF;
END $$;

-- One relation row per (goal, target). Partial unique indexes because a NULL
-- column would otherwise defeat a composite unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ag_unique_init
  ON public.mkt_activity_goals(goal_id, initiative_id) WHERE initiative_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ag_unique_prog
  ON public.mkt_activity_goals(goal_id, program_id) WHERE program_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ag_unique_camp
  ON public.mkt_activity_goals(goal_id, campaign_id) WHERE campaign_id IS NOT NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_initiatives         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_initiative_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_programs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_activity_goals      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; cap text;
BEGIN
  FOR t, cap IN
    SELECT * FROM (VALUES
      ('mkt_initiatives',         'manage_initiatives'),
      ('mkt_initiative_projects', 'manage_initiatives'),
      ('mkt_programs',            'manage_programs'),
      ('mkt_activity_goals',      'manage_goals')
    ) AS v(t, c)
  LOOP
    -- Reading the portfolio needs only read_plan; writing needs the specific
    -- management capability, so a writer can see the plan without editing it.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (public.wassell_mkt_can(%L))',
                   t||'_select', t, 'read_plan');
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.wassell_mkt_can(%L))',
                   t||'_insert', t, cap);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (public.wassell_mkt_can(%L))',
                   t||'_update', t, cap);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (public.wassell_mkt_can(%L))',
                   t||'_delete', t, cap);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mkt_initiatives,
  public.mkt_initiative_projects, public.mkt_programs, public.mkt_activity_goals
  TO authenticated;

COMMENT ON TABLE public.mkt_programs IS 'Ongoing and repeatable. No end date required — a program must never be modelled as a permanent campaign.';
COMMENT ON TABLE public.mkt_initiatives IS 'Outcome-oriented umbrella. Paid and organic campaigns attach as siblings; neither depends on the other.';
COMMENT ON COLUMN public.mkt_internal_campaigns.campaign_class IS 'organic | paid. Orthogonal to the pre-existing campaign_type, which is preserved.';
