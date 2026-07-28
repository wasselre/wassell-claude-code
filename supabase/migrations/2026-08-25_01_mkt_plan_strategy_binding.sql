-- ============================================================================
-- A plan is bound to an EXACT strategy version, permanently, and can only go
-- live under an APPROVED one. (2026-08-25, part 1 of 2.)
--
-- What was already true, verified before writing this:
--   * mkt_plans.strategy_version_id is already an FK to a specific immutable
--     version (ON DELETE RESTRICT), so the "exact version, not a general
--     strategy record" requirement is structurally met.
--   * mkt_plan_active_needs_strategy requires the FK to be non-null when a plan
--     is approved or active — but NOT that the referenced version is approved.
--     That is the real hole: a plan could go active under a DRAFT strategy.
--   * Live data: 2 plans, both draft, both strategy_version_id = NULL.
--     2 strategy versions, BOTH draft, zero approved.
--
-- ARCHITECTURE CHOICE — append-only link history, not plan revisions.
-- The brief asks for either a new plan revision per strategy change, or a
-- complete append-only history. Revisions were rejected: goals, initiatives,
-- programs, campaigns, channel plans and reviews all carry plan_id foreign
-- keys, so forking a plan's identity would either orphan them or require
-- duplicating the whole subtree — a much larger blast radius than the problem.
-- An append-only link log preserves exactly what the requirement is for (what
-- was this plan executing under, and when did that change, and who changed it)
-- without touching plan identity. This also matches the existing versioning
-- model, which records history in side tables (mkt_content_status_history)
-- rather than by cloning rows.
-- ============================================================================

-- ── 1. Append-only history of every plan → strategy binding ─────────────────
CREATE TABLE IF NOT EXISTS public.mkt_plan_strategy_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES public.mkt_plans(id) ON DELETE CASCADE,
  -- RESTRICT: the history must keep pointing at the version that was actually
  -- in force. Deleting a strategy version out from under an audit record would
  -- destroy the answer to "what was this plan executing under".
  from_strategy_version_id uuid REFERENCES public.mkt_strategy_versions(id) ON DELETE RESTRICT,
  to_strategy_version_id   uuid REFERENCES public.mkt_strategy_versions(id) ON DELETE RESTRICT,
  -- The plan's status at the moment of the change: rebasing a draft is routine,
  -- rebasing an ACTIVE plan is a decision someone should be able to find later.
  plan_status_at_change text,
  reason              text,
  changed_by_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkt_psl_plan ON public.mkt_plan_strategy_links(plan_id, changed_at DESC);

-- Append-only. The whole value of this table is that it cannot be tidied up
-- after the fact.
CREATE OR REPLACE FUNCTION public.mkt_tg_plan_strategy_links_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  RAISE EXCEPTION 'mkt_plan_strategy_links is append-only (attempted %)', TG_OP
    USING ERRCODE='check_violation';
END $$;

DROP TRIGGER IF EXISTS mkt_psl_append_only ON public.mkt_plan_strategy_links;
CREATE TRIGGER mkt_psl_append_only BEFORE UPDATE OR DELETE ON public.mkt_plan_strategy_links
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_plan_strategy_links_append_only();

-- ── 2. Record every binding change automatically ────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_tg_plan_strategy_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.strategy_version_id IS NOT NULL THEN
      INSERT INTO public.mkt_plan_strategy_links
        (plan_id, from_strategy_version_id, to_strategy_version_id,
         plan_status_at_change, reason, changed_by_user_id)
      VALUES (NEW.id, NULL, NEW.strategy_version_id, NEW.status, 'created',
              COALESCE(NEW.created_by_user_id, public.wassell_app_user_id(auth.uid())));
    END IF;
  ELSIF NEW.strategy_version_id IS DISTINCT FROM OLD.strategy_version_id THEN
    INSERT INTO public.mkt_plan_strategy_links
      (plan_id, from_strategy_version_id, to_strategy_version_id,
       plan_status_at_change, reason, changed_by_user_id)
    VALUES (NEW.id, OLD.strategy_version_id, NEW.strategy_version_id, NEW.status,
            -- mkt_plan_rebase_strategy sets this GUC so the deliberate action is
            -- distinguishable from an ordinary edit that happened to touch it.
            NULLIF(current_setting('wassell.rebase_reason', true), ''),
            public.wassell_app_user_id(auth.uid()));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_plan_strategy_history ON public.mkt_plans;
CREATE TRIGGER mkt_plan_strategy_history AFTER INSERT OR UPDATE ON public.mkt_plans
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_plan_strategy_history();

-- ── 3. A live plan needs an APPROVED strategy version ───────────────────────
-- A CHECK cannot see another table, so this is a trigger. The message names the
-- requirement rather than saying "violates constraint", because the API surfaces
-- it verbatim and a person has to act on it.
CREATE OR REPLACE FUNCTION public.mkt_tg_plan_needs_approved_strategy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_status text; v_name text; v_ver int;
BEGIN
  IF NEW.status IN ('approved','active')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.strategy_version_id IS DISTINCT FROM OLD.strategy_version_id) THEN
    IF NEW.strategy_version_id IS NULL THEN
      RAISE EXCEPTION
        'plan "%" cannot be % without a strategy version — link one first', NEW.name_ar, NEW.status
        USING ERRCODE='check_violation';
    END IF;
    SELECT status, name_ar, version_number INTO v_status, v_name, v_ver
      FROM public.mkt_strategy_versions WHERE id = NEW.strategy_version_id;
    IF v_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION
        'plan "%" cannot be % — its strategy version (% v%) is %, not approved',
        NEW.name_ar, NEW.status, v_name, v_ver, COALESCE(v_status, 'missing')
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- zz_ so it runs after mkt_plan_hierarchy, whose defaults it may depend on.
DROP TRIGGER IF EXISTS mkt_plan_zz_approved_strategy ON public.mkt_plans;
CREATE TRIGGER mkt_plan_zz_approved_strategy BEFORE INSERT OR UPDATE ON public.mkt_plans
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_plan_needs_approved_strategy();

-- ── 4. Deliberate rebase ────────────────────────────────────────────────────
-- Never automatic. Approving a new strategy version does NOT move any plan; a
-- plan written under v1 stays on v1 until a person with write_plan says
-- otherwise, and the reason is recorded with them and the timestamp.
CREATE OR REPLACE FUNCTION public.mkt_plan_rebase_strategy(
  p_plan_id uuid, p_new_version_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p record; v record; v_old_id uuid;
BEGIN
  -- auth.uid() is NULL in a plain SQL session (a migration, a maintenance
  -- script), and wassell_mkt_can() resolves that to the 'none' role — so an
  -- unconditional check makes this function refuse to run for the DBA who
  -- installed it. Gate on the caller only when there IS a caller. Same posture
  -- as mkt_asset_enqueue_processing. A real end user always arrives with a JWT.
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mkt_can('write_plan') THEN
    RAISE EXCEPTION 'your marketing role does not permit changing a plan''s strategy version'
      USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT * INTO p FROM public.mkt_plans WHERE id = p_plan_id;
  IF p IS NULL THEN RAISE EXCEPTION 'plan not found' USING ERRCODE='no_data_found'; END IF;

  SELECT * INTO v FROM public.mkt_strategy_versions WHERE id = p_new_version_id;
  IF v IS NULL THEN
    RAISE EXCEPTION 'strategy version not found' USING ERRCODE='foreign_key_violation';
  END IF;

  -- A live plan may only move BETWEEN approved versions. A draft may be pointed
  -- at a draft strategy while both are being written.
  IF p.status IN ('approved','active') AND v.status <> 'approved' THEN
    RAISE EXCEPTION
      'plan "%" is % — it can only be rebased onto an APPROVED strategy version (target is %)',
      p.name_ar, p.status, v.status USING ERRCODE='check_violation';
  END IF;

  IF p.strategy_version_id = p_new_version_id THEN
    RETURN jsonb_build_object('changed', false, 'reason', 'already bound to this version');
  END IF;

  v_old_id := p.strategy_version_id;
  -- Read by the history trigger so a rebase is distinguishable from an edit.
  PERFORM set_config('wassell.rebase_reason',
                     COALESCE(p_reason, 'rebased without a stated reason'), true);
  UPDATE public.mkt_plans SET strategy_version_id = p_new_version_id, updated_at = now()
   WHERE id = p_plan_id;
  PERFORM set_config('wassell.rebase_reason', '', true);

  RETURN jsonb_build_object(
    'changed', true, 'plan_id', p_plan_id,
    'from_version_id', v_old_id, 'to_version_id', p_new_version_id,
    'to_version_number', v.version_number, 'to_status', v.status);
END $$;

REVOKE ALL ON FUNCTION public.mkt_plan_rebase_strategy(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_plan_rebase_strategy(uuid, uuid, text) TO authenticated, service_role;

-- ── 5. What is missing before a plan can go live ────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_plan_missing_requirements(p_plan_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE p record; v_status text; missing text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO p FROM public.mkt_plans WHERE id = p_plan_id;
  IF p IS NULL THEN RETURN ARRAY['plan not found']; END IF;

  IF p.strategy_version_id IS NULL THEN
    missing := array_append(missing, 'strategy_version');
  ELSE
    SELECT status INTO v_status FROM public.mkt_strategy_versions WHERE id = p.strategy_version_id;
    IF v_status IS DISTINCT FROM 'approved' THEN
      missing := array_append(missing, 'approved_strategy_version');
    END IF;
  END IF;

  IF p.owner_user_id IS NULL THEN missing := array_append(missing, 'owner'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mkt_goals g
                  WHERE g.plan_id = p_plan_id AND g.archived_at IS NULL) THEN
    missing := array_append(missing, 'at_least_one_goal');
  END IF;

  RETURN missing;
END $$;

REVOKE ALL ON FUNCTION public.mkt_plan_missing_requirements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_plan_missing_requirements(uuid) TO authenticated, service_role;

-- ── 6. Legacy plans: flag, never fabricate ──────────────────────────────────
-- Both live plans have no strategy version. They are NOT given one: inventing a
-- link would assert that work was executed under a strategy nobody approved.
-- They stay draft, visible, and flagged.
DO $$
DECLARE n_flagged int; n_plans int; n_linked int;
BEGIN
  SELECT count(*) INTO n_plans FROM public.mkt_plans;
  SELECT count(*) INTO n_linked FROM public.mkt_plans WHERE strategy_version_id IS NOT NULL;

  UPDATE public.mkt_plans
     SET needs_classification = true
   WHERE strategy_version_id IS NULL AND archived_at IS NULL;
  GET DIAGNOSTICS n_flagged = ROW_COUNT;

  RAISE NOTICE 'PLANS total=% with_strategy=% flagged_needs_classification=%',
    n_plans, n_linked, n_flagged;

  -- Seed history for any plan that already had a binding, so the log is not
  -- silently missing the first link. (Currently none — kept for replay safety.)
  INSERT INTO public.mkt_plan_strategy_links
    (plan_id, from_strategy_version_id, to_strategy_version_id, plan_status_at_change, reason, changed_by_user_id)
  SELECT p.id, NULL, p.strategy_version_id, p.status, 'backfilled: pre-existing binding', p.created_by_user_id
    FROM public.mkt_plans p
   WHERE p.strategy_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.mkt_plan_strategy_links l WHERE l.plan_id = p.id);
END $$;

-- ── 7. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_plan_strategy_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_psl_select ON public.mkt_plan_strategy_links;
CREATE POLICY mkt_psl_select ON public.mkt_plan_strategy_links
  FOR SELECT USING (public.wassell_mkt_can('read_plan'));
-- No INSERT policy for end users: rows appear only via the trigger, which is
-- SECURITY DEFINER. A hand-written history entry would defeat the point.

GRANT SELECT ON public.mkt_plan_strategy_links TO authenticated;

COMMENT ON TABLE public.mkt_plan_strategy_links IS
  'Append-only history of which strategy version each plan was executing under. Written by trigger only.';
COMMENT ON FUNCTION public.mkt_plan_rebase_strategy(uuid, uuid, text) IS
  'The ONLY deliberate way to move a plan between strategy versions. Never runs automatically when a strategy is approved.';
