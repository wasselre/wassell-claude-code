-- ============================================================================
-- The goal model: three distinct classes, real units, honest baselines,
-- append-only measurements, and metric-aware allocation. (2026-08-25, part 2.)
--
-- Live data inspected before writing this — ONE goal exists:
--   "900 مهتم" · category kpi · metric "عدد المهتمين" · unit NULL
--   target 900 · baseline NULL · actual NULL · owner NULL · no dates
--   measurement_frequency NULL · source_of_truth "الإعلانات" (free text)
--   status ACTIVE
-- It is the exact problem the brief describes: a target of 900 with nothing
-- saying what 900 is, live, owned by nobody. It is NOT repaired by guessing —
-- it is flagged and left visible. Nothing here invents a unit, an owner, a
-- baseline or a source.
-- ============================================================================

-- ── 1. Classification: goal_category → goal_class ───────────────────────────
-- The brief asks for goal_class (outcome | kpi | output_commitment) AND a
-- separate thematic goal_category. The existing column held the classification
-- under the category name, so it is RENAMED rather than duplicated — leaving
-- both would guarantee the two drift and nobody knows which one means what.
-- One row exists (kpi), so the rename carries no data risk.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='mkt_goals' AND column_name='goal_category')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='mkt_goals' AND column_name='goal_class') THEN
    ALTER TABLE public.mkt_goals DROP CONSTRAINT IF EXISTS mkt_goal_category_check;
    ALTER TABLE public.mkt_goals RENAME COLUMN goal_category TO goal_class;
  END IF;
END $$;

ALTER TABLE public.mkt_goals
  -- 'output' becomes 'output_commitment': an execution promise, never mistakable
  -- for a business result.
  ADD COLUMN IF NOT EXISTS goal_category text,          -- thematic, optional
  ADD COLUMN IF NOT EXISTS baseline_date date,
  -- A missing baseline is a STATE, not a zero.
  ADD COLUMN IF NOT EXISTS baseline_state text,
  ADD COLUMN IF NOT EXISTS aggregation_method text,
  ADD COLUMN IF NOT EXISTS source_of_truth_note text,
  ADD COLUMN IF NOT EXISTS needs_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_initiative_id uuid REFERENCES public.mkt_initiatives(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_program_id    uuid REFERENCES public.mkt_programs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_campaign_id   uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE SET NULL;

UPDATE public.mkt_goals SET goal_class = 'output_commitment' WHERE goal_class = 'output';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_class_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_class_check
      CHECK (goal_class IN ('outcome','kpi','output_commitment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_baseline_state_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_baseline_state_check
      CHECK (baseline_state IS NULL OR baseline_state IN ('known','unknown','not_applicable')) NOT VALID;
    ALTER TABLE public.mkt_goals VALIDATE CONSTRAINT mkt_goal_baseline_state_check;
  END IF;
  -- A stated baseline must carry a number; "known" with no value is a lie.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_baseline_known_has_value') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_baseline_known_has_value
      CHECK (baseline_state IS DISTINCT FROM 'known' OR baseline_value IS NOT NULL) NOT VALID;
    ALTER TABLE public.mkt_goals VALIDATE CONSTRAINT mkt_goal_baseline_known_has_value;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_aggregation_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_aggregation_check
      CHECK (aggregation_method IS NULL OR aggregation_method IN
             ('sum','latest','average','rate','min','max','custom')) NOT VALID;
    ALTER TABLE public.mkt_goals VALIDATE CONSTRAINT mkt_goal_aggregation_check;
  END IF;
  -- At most ONE execution link: a goal served by "an initiative and a campaign"
  -- is really two goals, and pretending otherwise breaks roll-up.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_one_execution_link') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_one_execution_link
      CHECK ((linked_initiative_id IS NOT NULL)::int + (linked_program_id IS NOT NULL)::int
           + (linked_campaign_id IS NOT NULL)::int <= 1) NOT VALID;
    ALTER TABLE public.mkt_goals VALIDATE CONSTRAINT mkt_goal_one_execution_link;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_category_theme_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_category_theme_check
      CHECK (goal_category IS NULL OR goal_category IN
             ('acquisition','conversion','brand','reach','engagement','retention',
              'efficiency','revenue','other')) NOT VALID;
    ALTER TABLE public.mkt_goals VALIDATE CONSTRAINT mkt_goal_category_theme_check;
  END IF;
END $$;

COMMENT ON COLUMN public.mkt_goals.goal_class IS
  'outcome | kpi | output_commitment. An output commitment is what the team will produce; it is never a business result.';
COMMENT ON COLUMN public.mkt_goals.unit IS
  'What the number IS — leads, impressions, SAR per lead, percent, videos. A target of 900 with no unit is not a target.';
COMMENT ON COLUMN public.mkt_goals.baseline_state IS
  'known | unknown | not_applicable. A missing baseline is a state, never zero.';

-- ── 2. Source of truth: structured key + the old free text preserved ────────
-- source_of_truth held free text ("الإعلانات"). Rather than adding a second
-- confusable field, the free text moves to source_of_truth_note and the column
-- becomes a structured key. Nothing is discarded, and no key is guessed from
-- prose.
DO $$
DECLARE n int;
BEGIN
  UPDATE public.mkt_goals
     SET source_of_truth_note = source_of_truth, source_of_truth = NULL
   WHERE source_of_truth IS NOT NULL
     AND source_of_truth NOT IN ('crm_leads','crm_appointments','crm_sales','meta_ads',
        'tiktok_ads','snapchat_ads','google_ads','instagram_organic','tiktok_organic',
        'publication_snapshots','google_analytics','manual_verified','other');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'SOURCE OF TRUTH: % free-text value(s) moved to source_of_truth_note, key left unset', n;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_goal_source_key_check') THEN
    ALTER TABLE public.mkt_goals ADD CONSTRAINT mkt_goal_source_key_check
      CHECK (source_of_truth IS NULL OR source_of_truth IN
        ('crm_leads','crm_appointments','crm_sales','meta_ads','tiktok_ads','snapchat_ads',
         'google_ads','instagram_organic','tiktok_organic','publication_snapshots',
         'google_analytics','manual_verified','other')) NOT VALID;
    ALTER TABLE public.mkt_goals VALIDATE CONSTRAINT mkt_goal_source_key_check;
  END IF;
END $$;

-- ── 3. Effective dates: inherited from the plan unless overridden ───────────
CREATE OR REPLACE FUNCTION public.mkt_goal_effective_dates(p_goal_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'start',      COALESCE(g.start_date, p.period_start),
    'end',        COALESCE(g.end_date,   p.period_end),
    'start_overridden', g.start_date IS NOT NULL,
    'end_overridden',   g.end_date   IS NOT NULL,
    'plan_start', p.period_start,
    'plan_end',   p.period_end)
  FROM public.mkt_goals g JOIN public.mkt_plans p ON p.id = g.plan_id
  WHERE g.id = p_goal_id;
$$;

-- ── 4. Measurements: append-only, the ONLY source of an actual value ────────
CREATE TABLE IF NOT EXISTS public.mkt_goal_measurements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id        uuid NOT NULL REFERENCES public.mkt_goals(id) ON DELETE CASCADE,
  value          numeric NOT NULL,
  measured_at    date NOT NULL DEFAULT current_date,
  -- The window this reading covers. For a 'sum' goal the periods must not
  -- overlap or the total double counts; for 'latest' only measured_at matters.
  period_start   date,
  period_end     date,
  source_key     text,
  evidence       text,
  entered_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkt_gm_goal ON public.mkt_goal_measurements(goal_id, measured_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_gm_period_order') THEN
    ALTER TABLE public.mkt_goal_measurements ADD CONSTRAINT mkt_gm_period_order
      CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_gm_source_key_check') THEN
    ALTER TABLE public.mkt_goal_measurements ADD CONSTRAINT mkt_gm_source_key_check
      CHECK (source_key IS NULL OR source_key IN
        ('crm_leads','crm_appointments','crm_sales','meta_ads','tiktok_ads','snapchat_ads',
         'google_ads','instagram_organic','tiktok_organic','publication_snapshots',
         'google_analytics','manual_verified','other'));
  END IF;
END $$;

-- A measurement is evidence. Correcting one means recording a new reading, not
-- editing the old one — otherwise the history cannot be trusted at all.
CREATE OR REPLACE FUNCTION public.mkt_tg_measurements_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.mkt_goals WHERE id = OLD.goal_id) THEN
    RETURN OLD;   -- the goal itself is being deleted; this is the cascade
  END IF;
  RAISE EXCEPTION
    'goal measurements are append-only — record a NEW measurement instead of editing (attempted %)', TG_OP
    USING ERRCODE='check_violation';
END $$;

DROP TRIGGER IF EXISTS mkt_gm_append_only ON public.mkt_goal_measurements;
CREATE TRIGGER mkt_gm_append_only BEFORE UPDATE OR DELETE ON public.mkt_goal_measurements
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_measurements_append_only();

-- ── 5. The actual value, computed by aggregation method ─────────────────────
-- Summing a rate is meaningless, and taking the latest reading of a cumulative
-- lead count throws away every earlier month. The method decides.
CREATE OR REPLACE FUNCTION public.mkt_goal_actual(p_goal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE g record; v numeric; n int; v_last date;
BEGIN
  SELECT * INTO g FROM public.mkt_goals WHERE id = p_goal_id;
  IF g IS NULL THEN RETURN NULL; END IF;

  SELECT count(*), max(measured_at) INTO n, v_last
    FROM public.mkt_goal_measurements WHERE goal_id = p_goal_id;

  IF n = 0 THEN
    -- No measurements is NOT zero. Say so.
    RETURN jsonb_build_object('value', NULL, 'measurements', 0, 'is_measured', false,
      'method', g.aggregation_method, 'last_measured_at', NULL);
  END IF;

  v := CASE COALESCE(g.aggregation_method, 'latest')
    WHEN 'sum'     THEN (SELECT sum(value)  FROM public.mkt_goal_measurements WHERE goal_id=p_goal_id)
    WHEN 'average' THEN (SELECT avg(value)  FROM public.mkt_goal_measurements WHERE goal_id=p_goal_id)
    WHEN 'rate'    THEN (SELECT value FROM public.mkt_goal_measurements
                          WHERE goal_id=p_goal_id ORDER BY measured_at DESC, created_at DESC LIMIT 1)
    WHEN 'min'     THEN (SELECT min(value)  FROM public.mkt_goal_measurements WHERE goal_id=p_goal_id)
    WHEN 'max'     THEN (SELECT max(value)  FROM public.mkt_goal_measurements WHERE goal_id=p_goal_id)
    WHEN 'custom'  THEN (SELECT value FROM public.mkt_goal_measurements
                          WHERE goal_id=p_goal_id ORDER BY measured_at DESC, created_at DESC LIMIT 1)
    ELSE                (SELECT value FROM public.mkt_goal_measurements
                          WHERE goal_id=p_goal_id ORDER BY measured_at DESC, created_at DESC LIMIT 1)
  END;

  RETURN jsonb_build_object('value', v, 'measurements', n, 'is_measured', true,
    'method', COALESCE(g.aggregation_method, 'latest'), 'last_measured_at', v_last);
END $$;

-- actual_value becomes a CACHE of the computation, refreshed on every new
-- measurement. It is removed from the API's editable list, so the only way it
-- moves is by recording evidence.
CREATE OR REPLACE FUNCTION public.mkt_tg_goal_refresh_actual()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.mkt_goals
     SET actual_value = (public.mkt_goal_actual(NEW.goal_id) ->> 'value')::numeric,
         updated_at = now()
   WHERE id = NEW.goal_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_gm_refresh_actual ON public.mkt_goal_measurements;
CREATE TRIGGER mkt_gm_refresh_actual AFTER INSERT ON public.mkt_goal_measurements
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_goal_refresh_actual();

-- ── 6. Allocations, validated by metric type ────────────────────────────────
-- Leads, videos and impressions add up across months. Conversion rate, cost per
-- lead and follower count do not. Requiring the second kind to sum to the annual
-- target is the classic spreadsheet error; this refuses to make it.
CREATE OR REPLACE FUNCTION public.mkt_goal_allocation_status(p_goal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE g record; v_sum numeric; n int; v_additive boolean;
BEGIN
  SELECT * INTO g FROM public.mkt_goals WHERE id = p_goal_id;
  IF g IS NULL THEN RETURN NULL; END IF;

  SELECT count(*), sum(target_value) INTO n, v_sum
    FROM public.mkt_goal_target_periods WHERE goal_id = p_goal_id;

  v_additive := COALESCE(g.aggregation_method, 'latest') = 'sum';

  RETURN jsonb_build_object(
    'goal_id',    p_goal_id,
    'periods',    n,
    'has_allocation', n > 0,
    'is_additive', v_additive,
    'target',     g.target_value,
    'allocated',  v_sum,
    -- Only meaningful when the metric adds up. For a rate goal the periods are
    -- per-period targets in their own right, and a difference means nothing.
    'difference', CASE WHEN v_additive AND g.target_value IS NOT NULL AND n > 0
                       THEN COALESCE(v_sum,0) - g.target_value ELSE NULL END,
    'consistent', CASE WHEN NOT v_additive THEN NULL
                       WHEN n = 0 OR g.target_value IS NULL THEN NULL
                       ELSE COALESCE(v_sum,0) = g.target_value END,
    'note', CASE
      WHEN NOT v_additive THEN 'non-additive metric: periods are independent targets, they do not sum to the total'
      WHEN n = 0 THEN 'no allocation set'
      ELSE NULL END);
END $$;

-- ── 7. What a goal needs before it can go active ────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_goal_missing_requirements(p_goal_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE g record; d jsonb; missing text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO g FROM public.mkt_goals WHERE id = p_goal_id;
  IF g IS NULL THEN RETURN ARRAY['goal not found']; END IF;

  IF g.plan_id IS NULL                                THEN missing := array_append(missing,'plan'); END IF;
  IF g.goal_class IS NULL                             THEN missing := array_append(missing,'goal_class'); END IF;
  IF g.metric IS NULL OR btrim(g.metric) = ''         THEN missing := array_append(missing,'metric'); END IF;
  IF g.unit IS NULL OR btrim(g.unit) = ''             THEN missing := array_append(missing,'unit'); END IF;
  IF g.target_value IS NULL                           THEN missing := array_append(missing,'target'); END IF;
  IF g.owner_user_id IS NULL                          THEN missing := array_append(missing,'owner'); END IF;
  IF g.measurement_frequency IS NULL                  THEN missing := array_append(missing,'measurement_frequency'); END IF;
  IF g.source_of_truth IS NULL                        THEN missing := array_append(missing,'source_of_truth'); END IF;
  IF g.aggregation_method IS NULL                     THEN missing := array_append(missing,'aggregation_method'); END IF;
  -- A baseline need not have a number, but somebody must have decided which:
  -- known, unknown, or not applicable. Silence is not an answer.
  IF g.baseline_state IS NULL                         THEN missing := array_append(missing,'baseline_state'); END IF;

  d := public.mkt_goal_effective_dates(p_goal_id);
  IF d IS NULL OR d->>'start' IS NULL                 THEN missing := array_append(missing,'start_date'); END IF;
  IF d IS NULL OR d->>'end'   IS NULL                 THEN missing := array_append(missing,'end_date'); END IF;

  RETURN missing;
END $$;

REVOKE ALL ON FUNCTION public.mkt_goal_missing_requirements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_goal_missing_requirements(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_goal_actual(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_goal_actual(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_goal_allocation_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_goal_allocation_status(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_goal_effective_dates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_goal_effective_dates(uuid) TO authenticated, service_role;

-- Gate the TRANSITION to active, not the row. A CHECK would instantly
-- invalidate the one live goal, which the brief forbids repairing by invention.
CREATE OR REPLACE FUNCTION public.mkt_tg_goal_activation_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE missing text[];
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    missing := public.mkt_goal_missing_requirements(NEW.id);
    IF array_length(missing,1) > 0 THEN
      RAISE EXCEPTION
        'goal "%" cannot be activated until it is complete — missing: %',
        NEW.name_ar, array_to_string(missing, ', ') USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NULL; -- AFTER trigger: the return value is ignored
END $$;

-- AFTER, not BEFORE. mkt_goal_missing_requirements() reads the goal by id, and
-- on a BEFORE INSERT that row does not exist yet — the lookup returned
-- ARRAY['goal not found'] and every attempt to create an active goal failed with
-- a nonsense reason. AFTER runs with the row visible, and raising there still
-- aborts the statement. The zz_ prefix keeps it ordered after mkt_goal_hierarchy.
DROP TRIGGER IF EXISTS mkt_goal_zz_activation_gate ON public.mkt_goals;
CREATE TRIGGER mkt_goal_zz_activation_gate AFTER INSERT OR UPDATE ON public.mkt_goals
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_goal_activation_gate();

-- ── 8. Flag the legacy goal; invent nothing ─────────────────────────────────
DO $$
DECLARE n_flagged int; g record;
BEGIN
  UPDATE public.mkt_goals
     SET needs_classification = true
   WHERE archived_at IS NULL
     AND array_length(public.mkt_goal_missing_requirements(id), 1) > 0;
  GET DIAGNOSTICS n_flagged = ROW_COUNT;
  RAISE NOTICE 'GOALS flagged needs_classification = %', n_flagged;

  FOR g IN SELECT id, name_ar, status, public.mkt_goal_missing_requirements(id) AS m
             FROM public.mkt_goals WHERE archived_at IS NULL LOOP
    RAISE NOTICE '  goal "%" (%) missing: %', g.name_ar, g.status, array_to_string(g.m, ', ');
  END LOOP;
END $$;

-- ── 9. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_goal_measurements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_gm_select ON public.mkt_goal_measurements;
CREATE POLICY mkt_gm_select ON public.mkt_goal_measurements
  FOR SELECT USING (public.wassell_mkt_can('read_plan'));
DROP POLICY IF EXISTS mkt_gm_insert ON public.mkt_goal_measurements;
CREATE POLICY mkt_gm_insert ON public.mkt_goal_measurements
  FOR INSERT WITH CHECK (public.wassell_mkt_can('manage_goals'));
-- No UPDATE or DELETE policy: the append-only trigger refuses them anyway, and
-- the absent policy makes the intent visible in the catalog.

GRANT SELECT, INSERT ON public.mkt_goal_measurements TO authenticated;

COMMENT ON TABLE public.mkt_goal_measurements IS
  'Append-only evidence for a goal''s actual value. Correcting a reading means recording a new one.';
COMMENT ON FUNCTION public.mkt_goal_allocation_status(uuid) IS
  'Metric-aware: allocations must total the target only when aggregation_method = sum.';
