-- ============================================================================
-- Marketing Management v2, part 5: the extended capability matrix, a way to
-- grant marketing roles, and structured reviews.
-- Design: docs/marketing-management-v2.md
--
-- wassell_mkt_can is REPLACED, not edited in place, and every pre-existing
-- capability mapping is reproduced verbatim below. Verified against the live
-- definition before writing: administrator and marketing_manager return true
-- for everything; content_manager held read/write_content/write_campaign/
-- comment/assign/schedule/approve_content; writer, designer and video_editor
-- held read/write_content/comment; publisher held read/comment/schedule/
-- publish; reviewer held read/comment/approve_content; sales held read/comment;
-- viewer held read only. Those stay exactly as they were.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.wassell_mkt_can(
  p_capability text, p_auth_uid uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE public.wassell_mkt_role(p_auth_uid)
    WHEN 'administrator'     THEN true
    WHEN 'marketing_manager' THEN true
    -- A content manager runs the portfolio and the calendar, but does NOT set
    -- or approve strategy, does not approve plans, and does not touch the paid
    -- structure. Those are the boundaries the brief requires.
    WHEN 'content_manager'   THEN p_capability IN (
        'read','write_content','write_campaign','comment','assign','schedule','approve_content',
        'read_strategy','read_plan','manage_goals','manage_initiatives','manage_programs',
        'manage_campaigns','manage_capacity','review_performance')
    -- Producers can read the plan they are working against and nothing more at
    -- the planning layer. A writer cannot approve a strategy.
    WHEN 'writer'            THEN p_capability IN ('read','write_content','comment','read_strategy','read_plan')
    WHEN 'designer'          THEN p_capability IN ('read','write_content','comment','read_strategy','read_plan')
    WHEN 'video_editor'      THEN p_capability IN ('read','write_content','comment','read_strategy','read_plan')
    WHEN 'publisher'         THEN p_capability IN ('read','comment','schedule','publish','read_strategy','read_plan')
    WHEN 'reviewer'          THEN p_capability IN ('read','comment','approve_content','read_strategy','read_plan','review_performance')
    WHEN 'sales'             THEN p_capability IN ('read','comment','read_strategy','read_plan')
    WHEN 'viewer'            THEN p_capability IN ('read','read_strategy','read_plan')
    ELSE false
  END;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_mkt_can(text, uuid) TO authenticated, service_role;

-- ── Granting marketing roles ────────────────────────────────────────────────
-- mkt_role_grants had ZERO rows in production, and nothing in the app could
-- write it: app admins fell through to 'administrator' and everyone else to
-- 'viewer', so the ten-role matrix had never been exercised. This RPC is the
-- missing surface. Gated on manage_roles, which only administrators and
-- marketing managers hold.
CREATE OR REPLACE FUNCTION public.mkt_set_role_grant(p_user_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.wassell_mkt_can('manage_roles') THEN
    RAISE EXCEPTION 'your marketing role does not permit granting marketing roles'
      USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_role IS NULL THEN
    DELETE FROM public.mkt_role_grants WHERE user_id = p_user_id;
    RETURN;
  END IF;
  IF p_role NOT IN ('administrator','marketing_manager','content_manager','writer','designer',
                    'video_editor','publisher','reviewer','sales','viewer') THEN
    RAISE EXCEPTION 'unknown marketing role: %', p_role USING ERRCODE='check_violation';
  END IF;
  INSERT INTO public.mkt_role_grants (user_id, mkt_role, granted_by_user_id)
  VALUES (p_user_id, p_role, public.wassell_app_user_id(auth.uid()))
  ON CONFLICT (user_id) DO UPDATE
    SET mkt_role = EXCLUDED.mkt_role,
        granted_by_user_id = EXCLUDED.granted_by_user_id;
END $$;

REVOKE ALL ON FUNCTION public.mkt_set_role_grant(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_set_role_grant(uuid, text) TO authenticated, service_role;

-- ── Reviews ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL REFERENCES public.mkt_plans(id) ON DELETE CASCADE,
  review_type   text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  summary       text,
  what_worked   text,
  what_did_not  text,
  lessons       text,
  status        text NOT NULL DEFAULT 'draft',
  reviewer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  held_at       timestamptz,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One decision row per subject, so "continue / change / scale / pause / stop"
-- is a queryable record rather than a sentence buried in a summary.
CREATE TABLE IF NOT EXISTS public.mkt_review_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id     uuid NOT NULL REFERENCES public.mkt_reviews(id) ON DELETE CASCADE,
  -- One nullable FK per subject kind + a CHECK that exactly one is set.
  initiative_id uuid REFERENCES public.mkt_initiatives(id) ON DELETE CASCADE,
  program_id    uuid REFERENCES public.mkt_programs(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  goal_id       uuid REFERENCES public.mkt_goals(id) ON DELETE CASCADE,
  decision      text NOT NULL,
  rationale     text,
  -- A review may revise a forecast or move budget/capacity. Recorded here so
  -- the reason for a changed number survives next to the number.
  goal_forecast_before numeric,
  goal_forecast_after  numeric,
  budget_change   numeric,
  capacity_change integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_rev_type_check') THEN
    ALTER TABLE public.mkt_reviews ADD CONSTRAINT mkt_rev_type_check
      CHECK (review_type IN ('weekly','monthly','quarterly','annual','ad_hoc'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_rev_status_check') THEN
    ALTER TABLE public.mkt_reviews ADD CONSTRAINT mkt_rev_status_check
      CHECK (status IN ('draft','held','published'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_rev_period_order') THEN
    ALTER TABLE public.mkt_reviews ADD CONSTRAINT mkt_rev_period_order
      CHECK (period_end >= period_start);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_rd_decision_check') THEN
    ALTER TABLE public.mkt_review_decisions ADD CONSTRAINT mkt_rd_decision_check
      CHECK (decision IN ('continue','change','scale','pause','stop','revise_forecast'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_rd_exactly_one_subject') THEN
    ALTER TABLE public.mkt_review_decisions ADD CONSTRAINT mkt_rd_exactly_one_subject
      CHECK ((initiative_id IS NOT NULL)::int + (program_id IS NOT NULL)::int
           + (campaign_id IS NOT NULL)::int + (goal_id IS NOT NULL)::int = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_rev_plan ON public.mkt_reviews(plan_id, period_start);
CREATE INDEX IF NOT EXISTS idx_mkt_rd_review ON public.mkt_review_decisions(review_id);

-- Applying a decision writes it onto the subject too, so the portfolio shows
-- the current decision without joining every review. The review stays the
-- audit record; the subject carries the latest state.
CREATE OR REPLACE FUNCTION public.mkt_tg_review_decision_apply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.decision IN ('continue','change','scale','pause','stop') THEN
    IF NEW.initiative_id IS NOT NULL THEN
      UPDATE public.mkt_initiatives
         SET decision = NEW.decision, decision_note = NEW.rationale, decided_at = now()
       WHERE id = NEW.initiative_id;
    ELSIF NEW.program_id IS NOT NULL THEN
      UPDATE public.mkt_programs
         SET decision = NEW.decision, decision_note = NEW.rationale, decided_at = now()
       WHERE id = NEW.program_id;
    ELSIF NEW.campaign_id IS NOT NULL THEN
      UPDATE public.mkt_internal_campaigns
         SET decision = NEW.decision, decision_note = NEW.rationale, decided_at = now()
       WHERE id = NEW.campaign_id;
    END IF;
  END IF;
  -- A revised forecast is written to the goal AND kept here with its before
  -- value, so a changed number never loses its justification.
  IF NEW.goal_id IS NOT NULL AND NEW.goal_forecast_after IS NOT NULL THEN
    UPDATE public.mkt_goals SET forecast_value = NEW.goal_forecast_after, updated_at = now()
     WHERE id = NEW.goal_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_rd_apply ON public.mkt_review_decisions;
CREATE TRIGGER mkt_rd_apply AFTER INSERT ON public.mkt_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_review_decision_apply();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_reviews          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_review_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_reviews_select ON public.mkt_reviews;
CREATE POLICY mkt_reviews_select ON public.mkt_reviews
  FOR SELECT USING (public.wassell_mkt_can('read_plan'));
DROP POLICY IF EXISTS mkt_reviews_write ON public.mkt_reviews;
CREATE POLICY mkt_reviews_write ON public.mkt_reviews
  FOR ALL USING (public.wassell_mkt_can('review_performance'))
  WITH CHECK (public.wassell_mkt_can('review_performance'));

DROP POLICY IF EXISTS mkt_review_decisions_select ON public.mkt_review_decisions;
CREATE POLICY mkt_review_decisions_select ON public.mkt_review_decisions
  FOR SELECT USING (public.wassell_mkt_can('read_plan'));
DROP POLICY IF EXISTS mkt_review_decisions_write ON public.mkt_review_decisions;
CREATE POLICY mkt_review_decisions_write ON public.mkt_review_decisions
  FOR ALL USING (public.wassell_mkt_can('review_performance'))
  WITH CHECK (public.wassell_mkt_can('review_performance'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mkt_reviews,
  public.mkt_review_decisions TO authenticated;

COMMENT ON FUNCTION public.mkt_set_role_grant(uuid, text) IS
  'The missing surface for mkt_role_grants, which had 0 rows in production. Gated on manage_roles.';
COMMENT ON TABLE public.mkt_review_decisions IS
  'continue | change | scale | pause | stop as a queryable record, applied onto the subject by trigger.';
