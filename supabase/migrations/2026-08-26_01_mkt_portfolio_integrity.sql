-- ============================================================================
-- Marketing Portfolio — integrity, identity and completion rules.
--
-- WHY THIS EXISTS
--
-- Creating a campaign from the portfolio failed with a raw Postgres message:
--
--   null value in column "code" of relation "mkt_internal_campaigns"
--   violates not-null constraint
--
-- `code` is NOT NULL with no default, so every creation path had to invent a
-- code by hand. The portfolio's create form only rendered a code box for the
-- organic and paid tabs, while its submit function treated EVERY non-initiative,
-- non-program kind as a campaign — so the "Unclassified" tab posted a campaign
-- with no code at all. The fix is not a code box on one more form: an identifier
-- the user has to invent is a bug in the schema, and "Unclassified" is not a
-- thing you can create.
--
-- WHAT THIS MIGRATION ESTABLISHES
--
--  1. A campaign code is issued by the DATABASE, from a sequence. nextval is
--     atomic and does not roll back, so two concurrent creates can never receive
--     the same code. No MAX+1, no browser-side counter.
--  2. A NEW campaign must say whether it is organic or paid. Legacy rows keep
--     their null class — they are classified through a dedicated action, never
--     reclassified silently by a migration.
--  3. A primary goal must belong to the campaign's own plan (initiatives and
--     programs already enforced this; campaigns did not).
--  4. Campaign dates outside the plan period need a RECORDED override, not a
--     silent exception.
--  5. Activation is gated on a completion checklist, in the database — a hidden
--     button is not a rule.
--  6. A program's recurring commitment is four explicit fields, so "3 project
--     videos every week" is data rather than prose.
--  7. Deleting a record that carries content, ads, publications, measurements or
--     attribution is refused with a reason. Archive is the supported path.
--  8. needs_classification stops being a one-time backfill flag and becomes what
--     it claims to be: "this record has no plan or no primary goal". It is
--     recomputed on every write, so it can never drift away from the truth.
--
-- Every deliberate rejection raises a STABLE TOKEN (`MKT:<reason>`) rather than
-- prose. The API maps tokens to bilingual sentences; nothing internal reaches a
-- user, and an unmapped token still logs with full context server-side.
--
-- Idempotent. Safe to re-run.
-- ============================================================================
BEGIN;

-- ── 1. Campaign codes are issued, not typed ────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.mkt_campaign_code_seq AS bigint START 1;

/** Next free CMP-nnnn. SECURITY DEFINER so the uniqueness probe sees every
 *  existing code regardless of the caller's RLS — a code that looks free only
 *  because a row is invisible is not free. The loop matters because historic
 *  codes were hand-typed and one of them could be a CMP-nnnn. */
CREATE OR REPLACE FUNCTION public.mkt_next_campaign_code()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_code text; v_guard int := 0;
BEGIN
  LOOP
    v_code := 'CMP-' || lpad(nextval('public.mkt_campaign_code_seq')::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.mkt_internal_campaigns WHERE code = v_code);
    v_guard := v_guard + 1;
    IF v_guard > 10000 THEN
      RAISE EXCEPTION 'MKT:campaign_code_unavailable' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN v_code;
END $$;

-- Start above any CMP-nnnn that already exists. Hand-typed codes that are not
-- of that shape ('k', 'z', 'مينا 52') are left completely alone.
SELECT setval(
  'public.mkt_campaign_code_seq',
  GREATEST(1, COALESCE((
    SELECT MAX((substring(code FROM '^CMP-([0-9]+)$'))::bigint)
    FROM public.mkt_internal_campaigns
    WHERE code ~ '^CMP-[0-9]+$'
  ), 0)),
  true
);

ALTER TABLE public.mkt_internal_campaigns
  ALTER COLUMN code SET DEFAULT public.mkt_next_campaign_code();

-- ── 2. Recorded override for a campaign that must sit outside its plan ─────
ALTER TABLE public.mkt_internal_campaigns
  ADD COLUMN IF NOT EXISTS period_override_reason text,
  ADD COLUMN IF NOT EXISTS period_override_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS period_override_at timestamptz;

-- ── 3. A program's recurring commitment, as data ───────────────────────────
-- commitment_count = how many outputs, commitment_unit = the period, and the two
-- new columns say WHAT is produced and how often the period repeats. Together
-- they express "1 analytics report every 1 week" and "3 project videos every
-- 1 week" without a sentence anyone has to parse.
ALTER TABLE public.mkt_programs
  ADD COLUMN IF NOT EXISTS output_type text,
  ADD COLUMN IF NOT EXISTS every_n_periods integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_prog_commitment_positive') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_commitment_positive
      CHECK (commitment_count IS NULL OR commitment_count > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_prog_every_n_positive') THEN
    ALTER TABLE public.mkt_programs ADD CONSTRAINT mkt_prog_every_n_positive
      CHECK (every_n_periods IS NULL OR every_n_periods > 0);
  END IF;
END $$;

-- ── 4. Campaign activation completeness ────────────────────────────────────
-- Mirrors mkt_init_active_complete / mkt_prog_active_complete, which campaigns
-- never had. A campaign is also time-bound, so its dates are part of being
-- runnable — and it must know whether it is organic or paid.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_camp_active_complete') THEN
    ALTER TABLE public.mkt_internal_campaigns ADD CONSTRAINT mkt_camp_active_complete
      CHECK (
        status <> 'active' OR (
          plan_id IS NOT NULL AND primary_goal_id IS NOT NULL
          AND owner_user_id IS NOT NULL AND campaign_class IS NOT NULL
          AND start_date IS NOT NULL AND end_date IS NOT NULL
        )
      );
  END IF;
END $$;

-- ── 5. The campaign write gate ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_portfolio_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_init_plan uuid; v_prog_plan uuid; p record;
BEGIN
  -- Identity. A blank string is as unusable as a null, so both are refilled.
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
    NEW.code := public.mkt_next_campaign_code();
  END IF;

  -- Organic or paid is a decision made AT CREATION. It is not defaulted,
  -- because defaulting it would put a classification nobody made onto a record
  -- and make the "type missing" queue permanently empty.
  IF TG_OP = 'INSERT' AND NEW.campaign_class IS NULL THEN
    RAISE EXCEPTION 'MKT:campaign_class_required' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.initiative_id IS NOT NULL THEN
    SELECT plan_id INTO v_init_plan FROM public.mkt_initiatives WHERE id = NEW.initiative_id;
    IF NEW.plan_id IS NOT NULL AND v_init_plan IS NOT NULL AND v_init_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'MKT:initiative_other_plan' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.plan_id IS NULL THEN NEW.plan_id := v_init_plan; END IF;
  END IF;

  IF NEW.program_id IS NOT NULL THEN
    SELECT plan_id INTO v_prog_plan FROM public.mkt_programs WHERE id = NEW.program_id;
    IF NEW.plan_id IS NOT NULL AND v_prog_plan IS NOT NULL AND v_prog_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'MKT:program_other_plan' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Initiatives and programs have always enforced this; campaigns had the gap,
  -- so a campaign could be attached to a goal belonging to a different plan and
  -- every roll-up under that plan would quietly count someone else's work.
  IF NEW.primary_goal_id IS NOT NULL AND NEW.plan_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.mkt_goals
                    WHERE id = NEW.primary_goal_id AND plan_id = NEW.plan_id) THEN
      RAISE EXCEPTION 'MKT:goal_other_plan' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Dates outside the plan window are allowed only with a reason on the record.
  -- Previously this was a flat refusal, which real campaigns (a launch that
  -- starts a week before the quarter) simply could not express.
  IF NEW.plan_id IS NOT NULL AND NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL THEN
    SELECT period_start, period_end INTO p FROM public.mkt_plans WHERE id = NEW.plan_id;
    IF p IS NOT NULL AND (NEW.start_date < p.period_start OR NEW.end_date > p.period_end)
       AND COALESCE(btrim(NEW.period_override_reason), '') = '' THEN
      RAISE EXCEPTION 'MKT:dates_outside_plan' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Stamp the override the moment a reason first appears, so "who allowed this"
  -- is answerable later without a separate audit write the UI could forget.
  IF COALESCE(btrim(NEW.period_override_reason), '') <> ''
     AND (TG_OP = 'INSERT' OR COALESCE(btrim(OLD.period_override_reason), '') = '') THEN
    NEW.period_override_at := now();
    IF NEW.period_override_by_user_id IS NULL THEN
      NEW.period_override_by_user_id := public.wassell_app_user_id(auth.uid());
    END IF;
  END IF;

  -- Derived, never hand-set: a record with no plan or no primary goal has an
  -- incomplete STRATEGIC CONTEXT. This is a different statement from "we do not
  -- know if it is organic or paid" (campaign_class IS NULL), and conflating the
  -- two is what made an explicitly organic campaign read as type-unknown.
  NEW.needs_classification := (NEW.plan_id IS NULL OR NEW.primary_goal_id IS NULL);

  RETURN NEW;
END $$;

-- Programs and initiatives get the same derived flag, from their own triggers.
CREATE OR REPLACE FUNCTION public.mkt_tg_program_portfolio_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_init_plan uuid;
BEGIN
  IF NEW.initiative_id IS NOT NULL THEN
    SELECT plan_id INTO v_init_plan FROM public.mkt_initiatives WHERE id = NEW.initiative_id;
    IF NEW.plan_id IS NOT NULL AND v_init_plan IS NOT NULL AND v_init_plan <> NEW.plan_id THEN
      RAISE EXCEPTION 'MKT:initiative_other_plan' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.plan_id IS NULL THEN NEW.plan_id := v_init_plan; END IF;
  END IF;
  IF NEW.primary_goal_id IS NOT NULL AND NEW.plan_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.mkt_goals
                    WHERE id = NEW.primary_goal_id AND plan_id = NEW.plan_id) THEN
      RAISE EXCEPTION 'MKT:goal_other_plan' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.needs_classification := (NEW.plan_id IS NULL OR NEW.primary_goal_id IS NULL);
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_tg_initiative_goal_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.primary_goal_id IS NOT NULL AND NEW.plan_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.mkt_goals
                    WHERE id = NEW.primary_goal_id AND plan_id = NEW.plan_id) THEN
      RAISE EXCEPTION 'MKT:goal_other_plan' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.needs_classification := (NEW.plan_id IS NULL OR NEW.primary_goal_id IS NULL);
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ── 6. Deleting something that carries evidence is refused ─────────────────
/** A campaign's FKs are a mixture of CASCADE (ads, performance, capacity) and
 *  SET NULL (content, publications, raw assets). Deleting one therefore both
 *  destroys measurement history and silently unlinks content that was made for
 *  it — with no message. Refuse instead, and name what is in the way. */
CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_block_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.mkt_content_items      WHERE campaign_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_publications       WHERE campaign_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_platform_campaigns WHERE campaign_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_performance_snapshots WHERE campaign_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_lead_attributions  WHERE campaign_id = OLD.id)
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'MKT:has_dependents' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_tg_program_block_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE program_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_content_items      WHERE origin_program_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_content_usage      WHERE program_id = OLD.id)
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'MKT:has_dependents' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_tg_initiative_block_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE initiative_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_programs           WHERE initiative_id = OLD.id)
  + (SELECT count(*) FROM public.mkt_content_usage      WHERE initiative_id = OLD.id)
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'MKT:has_dependents' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS mkt_camp_block_delete ON public.mkt_internal_campaigns;
CREATE TRIGGER mkt_camp_block_delete BEFORE DELETE ON public.mkt_internal_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_campaign_block_delete();

DROP TRIGGER IF EXISTS mkt_prog_block_delete ON public.mkt_programs;
CREATE TRIGGER mkt_prog_block_delete BEFORE DELETE ON public.mkt_programs
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_program_block_delete();

DROP TRIGGER IF EXISTS mkt_init_block_delete ON public.mkt_initiatives;
CREATE TRIGGER mkt_init_block_delete BEFORE DELETE ON public.mkt_initiatives
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_initiative_block_delete();

-- ── 7. What a record still needs before it can be activated ────────────────
-- The UI renders these lists; the CHECK constraints refuse the activation. Two
-- expressions of one rule, so the checklist can never promise something the
-- database will then reject.
CREATE OR REPLACE FUNCTION public.mkt_campaign_missing_requirements(p_campaign_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c record; missing text[] := '{}';
BEGIN
  SELECT * INTO c FROM public.mkt_internal_campaigns WHERE id = p_campaign_id;
  IF c IS NULL THEN RETURN ARRAY['not_found']; END IF;
  IF c.campaign_class IS NULL       THEN missing := array_append(missing, 'campaign_class'); END IF;
  IF c.plan_id IS NULL              THEN missing := array_append(missing, 'plan'); END IF;
  IF c.primary_goal_id IS NULL      THEN missing := array_append(missing, 'primary_goal'); END IF;
  IF c.owner_user_id IS NULL        THEN missing := array_append(missing, 'owner'); END IF;
  IF c.start_date IS NULL           THEN missing := array_append(missing, 'start_date'); END IF;
  IF c.end_date IS NULL             THEN missing := array_append(missing, 'end_date'); END IF;
  IF c.objective IS NULL OR btrim(c.objective) = ''
                                    THEN missing := array_append(missing, 'objective'); END IF;
  -- jsonb_array_length raises on a non-array, and this column is free-form
  -- jsonb, so the shape is checked before the length is asked for.
  IF COALESCE(CASE WHEN jsonb_typeof(c.deliverables) = 'array'
                   THEN jsonb_array_length(c.deliverables) END, 0) = 0
                                    THEN missing := array_append(missing, 'deliverables'); END IF;
  RETURN missing;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_program_missing_requirements(p_program_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE g record; missing text[] := '{}';
BEGIN
  SELECT * INTO g FROM public.mkt_programs WHERE id = p_program_id;
  IF g IS NULL THEN RETURN ARRAY['not_found']; END IF;
  IF g.plan_id IS NULL         THEN missing := array_append(missing, 'plan'); END IF;
  IF g.primary_goal_id IS NULL THEN missing := array_append(missing, 'primary_goal'); END IF;
  IF g.owner_user_id IS NULL   THEN missing := array_append(missing, 'owner'); END IF;
  -- A program with no commitment is a name, not an operating rhythm.
  IF g.commitment_count IS NULL OR g.commitment_unit IS NULL
                               THEN missing := array_append(missing, 'commitment'); END IF;
  IF g.output_type IS NULL OR btrim(g.output_type) = ''
                               THEN missing := array_append(missing, 'output_type'); END IF;
  IF g.purpose IS NULL OR btrim(g.purpose) = ''
                               THEN missing := array_append(missing, 'purpose'); END IF;
  RETURN missing;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_initiative_missing_requirements(p_initiative_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE i record; missing text[] := '{}'; n_exec int;
BEGIN
  SELECT * INTO i FROM public.mkt_initiatives WHERE id = p_initiative_id;
  IF i IS NULL THEN RETURN ARRAY['not_found']; END IF;
  IF i.plan_id IS NULL         THEN missing := array_append(missing, 'plan'); END IF;
  IF i.primary_goal_id IS NULL THEN missing := array_append(missing, 'primary_goal'); END IF;
  IF i.owner_user_id IS NULL   THEN missing := array_append(missing, 'owner'); END IF;
  IF i.hypothesis IS NULL OR btrim(i.hypothesis) = ''
                               THEN missing := array_append(missing, 'hypothesis'); END IF;
  IF i.expected_contribution IS NULL OR btrim(i.expected_contribution) = ''
                               THEN missing := array_append(missing, 'expected_contribution'); END IF;
  SELECT (SELECT count(*) FROM public.mkt_programs WHERE initiative_id = i.id AND archived_at IS NULL)
       + (SELECT count(*) FROM public.mkt_internal_campaigns WHERE initiative_id = i.id AND archived_at IS NULL)
    INTO n_exec;
  IF n_exec = 0 THEN missing := array_append(missing, 'execution'); END IF;
  RETURN missing;
END $$;

-- ── 8. Classifying a legacy record is an explicit, authorised action ───────
/** The ONLY supported way a null campaign_class becomes organic or paid. It is
 *  a separate verb from "edit the campaign" because the whole point is that the
 *  system never guessed: someone decided.
 *
 *  auth.uid() is NULL for a server-side caller (a job, a migration, psql). The
 *  capability check therefore applies only when there IS a caller to check —
 *  the same posture as every other mkt_* SECURITY DEFINER routine here. RLS on
 *  the table remains the boundary for browser callers. */
CREATE OR REPLACE FUNCTION public.mkt_campaign_classify(
  p_campaign_id uuid,
  p_class text,
  p_plan_id uuid DEFAULT NULL,
  p_goal_id uuid DEFAULT NULL,
  p_initiative_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c record; v_before text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mkt_can('write_campaign') THEN
    RAISE EXCEPTION 'MKT:not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_class IS NULL OR p_class NOT IN ('organic', 'paid') THEN
    RAISE EXCEPTION 'MKT:campaign_class_required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO c FROM public.mkt_internal_campaigns WHERE id = p_campaign_id;
  IF c IS NULL THEN RAISE EXCEPTION 'MKT:not_found' USING ERRCODE = 'no_data_found'; END IF;
  v_before := c.campaign_class;

  UPDATE public.mkt_internal_campaigns SET
    campaign_class  = p_class,
    -- channel_mix is the v1 field the older screens read. Keeping it in step
    -- means the Campaigns section and the Portfolio cannot disagree about what
    -- kind of campaign this is.
    channel_mix     = CASE WHEN channel_mix = 'both' THEN channel_mix ELSE p_class END,
    plan_id         = COALESCE(p_plan_id, plan_id),
    primary_goal_id = COALESCE(p_goal_id, primary_goal_id),
    initiative_id   = COALESCE(p_initiative_id, initiative_id)
  WHERE id = p_campaign_id;

  SELECT * INTO c FROM public.mkt_internal_campaigns WHERE id = p_campaign_id;
  RETURN jsonb_build_object(
    'campaign_id', p_campaign_id,
    'class_before', v_before,
    'class_after', c.campaign_class,
    'needs_classification', c.needs_classification,
    'missing', to_jsonb(public.mkt_campaign_missing_requirements(p_campaign_id))
  );
END $$;

GRANT EXECUTE ON FUNCTION public.mkt_campaign_classify(uuid, text, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_missing_requirements(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_program_missing_requirements(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_initiative_missing_requirements(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_next_campaign_code() TO authenticated;

-- ── 9. Reconcile the derived flag with reality, and report ────────────────
-- No campaign_class is invented here and no missing field becomes a value. The
-- ONLY thing that changes is needs_classification, which becomes true wherever
-- a record genuinely has no plan or no primary goal — which is what the flag
-- has always claimed to mean.
DO $$
DECLARE
  n_camp int; n_prog int; n_init int;
  n_class_null int; n_code_null int; n_code_dup int;
BEGIN
  SELECT count(*) INTO n_code_null FROM public.mkt_internal_campaigns WHERE code IS NULL;
  SELECT count(*) INTO n_code_dup  FROM (
    SELECT code FROM public.mkt_internal_campaigns GROUP BY code HAVING count(*) > 1) d;
  SELECT count(*) INTO n_class_null FROM public.mkt_internal_campaigns WHERE campaign_class IS NULL;

  RAISE NOTICE 'BEFORE campaigns=% organic=% paid=% class_null=% needs_class=% code_null=% code_dup=%',
    (SELECT count(*) FROM public.mkt_internal_campaigns),
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE campaign_class = 'organic'),
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE campaign_class = 'paid'),
    n_class_null,
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE needs_classification),
    n_code_null, n_code_dup;

  UPDATE public.mkt_internal_campaigns
     SET needs_classification = (plan_id IS NULL OR primary_goal_id IS NULL)
   WHERE needs_classification IS DISTINCT FROM (plan_id IS NULL OR primary_goal_id IS NULL);
  GET DIAGNOSTICS n_camp = ROW_COUNT;

  UPDATE public.mkt_programs
     SET needs_classification = (plan_id IS NULL OR primary_goal_id IS NULL)
   WHERE needs_classification IS DISTINCT FROM (plan_id IS NULL OR primary_goal_id IS NULL);
  GET DIAGNOSTICS n_prog = ROW_COUNT;

  UPDATE public.mkt_initiatives
     SET needs_classification = (plan_id IS NULL OR primary_goal_id IS NULL)
   WHERE needs_classification IS DISTINCT FROM (plan_id IS NULL OR primary_goal_id IS NULL);
  GET DIAGNOSTICS n_init = ROW_COUNT;

  RAISE NOTICE 'RECONCILED needs_classification: campaigns=% programs=% initiatives=%',
    n_camp, n_prog, n_init;
  RAISE NOTICE 'AFTER class_null=% (unchanged by design) needs_class=%',
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE campaign_class IS NULL),
    (SELECT count(*) FROM public.mkt_internal_campaigns WHERE needs_classification);

  -- Cross-plan relationships that predate the campaign goal check. Reported,
  -- never rewritten: a wrong link is a decision for a human.
  RAISE NOTICE 'CROSS-PLAN campaigns_goal_mismatch=% campaigns_init_mismatch=%',
    (SELECT count(*) FROM public.mkt_internal_campaigns c JOIN public.mkt_goals g ON g.id = c.primary_goal_id
      WHERE c.plan_id IS NOT NULL AND g.plan_id IS DISTINCT FROM c.plan_id),
    (SELECT count(*) FROM public.mkt_internal_campaigns c JOIN public.mkt_initiatives i ON i.id = c.initiative_id
      WHERE c.plan_id IS NOT NULL AND i.plan_id IS DISTINCT FROM c.plan_id);
END $$;

COMMIT;
