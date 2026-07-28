-- ============================================================================
-- Campaigns: separate the taxonomy, count content honestly, and make status a
-- machine instead of a free-text column.
--
-- Four things are wrong today and this migration fixes all four in the database
-- so the API and the UI cannot drift from them:
--
--   1. campaign_type doubles as a CLASS ('organic', 'paid') and a PURPOSE
--      ('project_launch', 'awareness', …). Two different questions in one
--      column, which is why the creation form could ask "type" and still leave
--      campaign_class NULL — the defect users hit as MKT:campaign_class_required.
--
--   2. channel_mix is a third spelling of the same class, and it can say 'both',
--      which the approved architecture does not have: organic and paid are
--      sibling campaigns under one initiative, not one campaign with a mixed
--      channel. It is kept as a derived legacy column, never asked for.
--
--   3. "Campaign content" has four different meanings (produced here, reused
--      here, legacy-linked, used by an ad) that were collapsed into one count,
--      and a single completion percentage that reads 0% whether nothing is
--      planned, nothing is measured, or the real answer is zero.
--
--   4. status accepts any value from any other value through the generic save
--      endpoint. There is no legal-transition rule anywhere.
--
-- Nothing here fabricates data. The only backfill is where the OLD column
-- literally states the class ('paid' → paid); everything else is flagged.
-- ============================================================================
BEGIN;

-- ── 1. Split class from purpose ─────────────────────────────────────────────

-- Explicit evidence only: campaign_type = 'paid'/'organic' IS a statement about
-- the class, so it may be read as one. It is NOT a statement about purpose, so
-- purpose becomes NULL rather than a guess, and the row is flagged.
UPDATE public.mkt_internal_campaigns
   SET campaign_class = campaign_type
 WHERE campaign_class IS NULL
   AND campaign_type IN ('organic', 'paid');

ALTER TABLE public.mkt_internal_campaigns ALTER COLUMN campaign_type DROP DEFAULT;
ALTER TABLE public.mkt_internal_campaigns ALTER COLUMN campaign_type DROP NOT NULL;

UPDATE public.mkt_internal_campaigns
   SET campaign_type = NULL
 WHERE campaign_type IN ('organic', 'paid');

ALTER TABLE public.mkt_internal_campaigns
  DROP CONSTRAINT IF EXISTS mkt_internal_campaigns_campaign_type_check;
ALTER TABLE public.mkt_internal_campaigns
  ADD CONSTRAINT mkt_internal_campaigns_campaign_type_check
  CHECK (campaign_type IS NULL OR campaign_type = ANY (ARRAY[
    'project_launch', 'promotional_offer', 'awareness', 'lead_generation',
    'retargeting', 'construction_update', 'investor', 'seasonal', 'custom']));

COMMENT ON COLUMN public.mkt_internal_campaigns.campaign_type IS
  'PURPOSE — what the campaign is for. Never organic/paid; that is campaign_class.';
COMMENT ON COLUMN public.mkt_internal_campaigns.campaign_class IS
  'organic | paid. The operating structure. Required on every new campaign.';
COMMENT ON COLUMN public.mkt_internal_campaigns.channel_mix IS
  'LEGACY, derived from campaign_class by trigger. Never collected from a user. '
  'Pre-existing ''both'' rows are preserved and flagged, never auto-split.';

-- ── 2. Campaign status history — append-only ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_campaign_status_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  from_status   text,
  to_status     text NOT NULL,
  reason        text,
  changed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- clock_timestamp(), not now(): now() is the transaction start time, so two
  -- entries written together would be indistinguishable and an audit trail whose
  -- rows cannot be ordered is not an audit trail.
  changed_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_mkt_csh_campaign
  ON public.mkt_campaign_status_history(campaign_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_history_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  -- The campaign-delete cascade is the one legitimate DELETE.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
       SELECT 1 FROM public.mkt_internal_campaigns WHERE id = OLD.campaign_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'MKT:history_append_only' USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS mkt_csh_append_only ON public.mkt_campaign_status_history;
CREATE TRIGGER mkt_csh_append_only BEFORE UPDATE OR DELETE
  ON public.mkt_campaign_status_history
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_campaign_history_append_only();

ALTER TABLE public.mkt_campaign_status_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_csh_read ON public.mkt_campaign_status_history;
CREATE POLICY mkt_csh_read ON public.mkt_campaign_status_history
  FOR SELECT USING (public.wassell_mkt_can('read'));
DROP POLICY IF EXISTS mkt_csh_ins ON public.mkt_campaign_status_history;
CREATE POLICY mkt_csh_ins ON public.mkt_campaign_status_history
  FOR INSERT WITH CHECK (public.wassell_mkt_can('write_campaign'));

-- ── 3. The legal transitions ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_campaign_status_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from IS NULL       THEN p_to = 'draft'
    WHEN p_from = p_to        THEN true
    WHEN p_from = 'draft'     THEN p_to IN ('planned', 'cancelled')
    WHEN p_from = 'planned'   THEN p_to IN ('active', 'draft', 'cancelled')
    WHEN p_from = 'active'    THEN p_to IN ('paused', 'completed', 'cancelled')
    WHEN p_from = 'paused'    THEN p_to IN ('active', 'completed', 'cancelled')
    WHEN p_from = 'completed' THEN p_to = 'archived'
    WHEN p_from = 'cancelled' THEN p_to = 'archived'
    WHEN p_from = 'archived'  THEN false   -- terminal
    ELSE false
  END;
$$;

-- What a campaign still needs before it may go PLANNED or ACTIVE. Structural
-- readiness differs by class, which is the point of having a class at all: a
-- paid campaign with no platform campaign has nowhere to spend, and an organic
-- campaign with no deliverables has agreed to produce nothing.
CREATE OR REPLACE FUNCTION public.mkt_campaign_activation_blockers(p_campaign_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE c record; missing text[];
BEGIN
  SELECT * INTO c FROM public.mkt_internal_campaigns WHERE id = p_campaign_id;
  IF c IS NULL THEN RETURN ARRAY['not_found']; END IF;

  missing := public.mkt_campaign_missing_requirements(p_campaign_id);

  IF c.campaign_class = 'paid' AND NOT EXISTS (
       SELECT 1 FROM public.mkt_platform_campaigns WHERE campaign_id = p_campaign_id) THEN
    missing := array_append(missing, 'platform_campaign');
  END IF;

  RETURN missing;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_campaign_next_statuses(p_campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE c record; s text; out jsonb := '[]'::jsonb; blockers text[];
BEGIN
  SELECT * INTO c FROM public.mkt_internal_campaigns WHERE id = p_campaign_id;
  IF c IS NULL THEN RETURN out; END IF;
  blockers := public.mkt_campaign_activation_blockers(p_campaign_id);

  FOREACH s IN ARRAY ARRAY['draft','planned','active','paused','completed','cancelled','archived'] LOOP
    CONTINUE WHEN s = c.status;
    CONTINUE WHEN NOT public.mkt_campaign_status_allowed(c.status, s);
    -- A transition the UI may offer, plus WHY it is unavailable when it is not.
    -- Hiding the blocked action entirely leaves the user with no idea what to fix.
    out := out || jsonb_build_object(
      'status', s,
      'allowed', CASE WHEN s IN ('planned','active') THEN array_length(blockers,1) IS NULL ELSE true END,
      'blockers', CASE WHEN s IN ('planned','active')
                       THEN to_jsonb(COALESCE(blockers, ARRAY[]::text[]))
                       ELSE '[]'::jsonb END);
  END LOOP;
  RETURN out;
END $$;

-- ── 4. Enforce it ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_status_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE blockers text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.mkt_campaign_status_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'MKT:invalid_status_transition' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('planned', 'active') THEN
      blockers := public.mkt_campaign_activation_blockers(NEW.id);
      IF array_length(blockers, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'MKT:campaign_incomplete:%', array_to_string(blockers, ',')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- AFTER, so the blockers check above reads the row as it will exist, and so a
-- rejected transition leaves no history entry behind.
DROP TRIGGER IF EXISTS mkt_camp_zz_status ON public.mkt_internal_campaigns;
CREATE TRIGGER mkt_camp_zz_status BEFORE UPDATE ON public.mkt_internal_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_campaign_status_machine();

CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_status_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.mkt_campaign_status_history
      (campaign_id, from_status, to_status, changed_by_user_id)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            public.wassell_app_user_id(auth.uid()));
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mkt_camp_zzz_status_log ON public.mkt_internal_campaigns;
CREATE TRIGGER mkt_camp_zzz_status_log AFTER INSERT OR UPDATE
  ON public.mkt_internal_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_campaign_status_log();

-- ── 5. Derive channel_mix; never ask for it ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_tg_campaign_channel_mix()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.campaign_class IS NOT NULL THEN
    -- A pre-existing 'both' row is left exactly as it is until somebody
    -- classifies it deliberately; splitting it automatically would invent a
    -- campaign that nobody planned.
    IF TG_OP = 'INSERT' OR COALESCE(OLD.channel_mix, '') <> 'both' THEN
      NEW.channel_mix := NEW.campaign_class;
    END IF;
  END IF;

  NEW.needs_classification := (
    NEW.plan_id IS NULL OR NEW.primary_goal_id IS NULL
    OR NEW.campaign_class IS NULL OR NEW.campaign_type IS NULL
    OR NEW.channel_mix = 'both');

  RETURN NEW;
END $$;

-- Runs after mkt_camp_portfolio_valid (which sets needs_classification from the
-- portfolio fields only) and widens that flag to the taxonomy gaps as well.
DROP TRIGGER IF EXISTS mkt_camp_y_channel_mix ON public.mkt_internal_campaigns;
CREATE TRIGGER mkt_camp_y_channel_mix BEFORE INSERT OR UPDATE
  ON public.mkt_internal_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_campaign_channel_mix();

-- ── 6. What "campaign content" actually means ───────────────────────────────
-- Four distinct relationships, counted separately and then deduplicated by
-- content id. The same item reached through three paths is ONE item.
CREATE OR REPLACE FUNCTION public.mkt_campaign_content_counts(p_campaign_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH produced AS (
    SELECT id FROM public.mkt_content_items
     WHERE origin_campaign_id = p_campaign_id AND archived_at IS NULL),
  reused AS (
    SELECT DISTINCT u.content_item_id AS id
      FROM public.mkt_content_usage u
      JOIN public.mkt_content_items ci ON ci.id = u.content_item_id AND ci.archived_at IS NULL
     WHERE u.campaign_id = p_campaign_id
       AND u.content_item_id NOT IN (SELECT id FROM produced)),
  legacy AS (
    SELECT id FROM public.mkt_content_items
     WHERE campaign_id = p_campaign_id AND archived_at IS NULL
       AND (origin_campaign_id IS NULL OR origin_campaign_id <> p_campaign_id)
       AND id NOT IN (SELECT id FROM reused)),
  paid_creative AS (
    SELECT DISTINCT a.content_item_id AS id
      FROM public.mkt_ads a
      JOIN public.mkt_ad_groups g ON g.id = a.ad_group_id
      JOIN public.mkt_platform_campaigns pc ON pc.id = g.platform_campaign_id
     WHERE pc.campaign_id = p_campaign_id AND a.content_item_id IS NOT NULL),
  uniq AS (
    SELECT id FROM produced
    UNION SELECT id FROM reused
    UNION SELECT id FROM legacy
    UNION SELECT id FROM paid_creative)
  SELECT jsonb_build_object(
    'produced_content_count',  (SELECT count(*) FROM produced),
    'reused_content_count',    (SELECT count(*) FROM reused),
    'legacy_content_count',    (SELECT count(*) FROM legacy),
    'paid_creative_count',     (SELECT count(*) FROM paid_creative),
    'unique_content_count',    (SELECT count(*) FROM uniq),
    -- "Approved" means signed off and onward, so already-published items still
    -- count as approved. Otherwise publishing an item would REDUCE the
    -- denominator and publication progress would move backwards.
    'approved_content_count',  (SELECT count(*) FROM public.mkt_content_items
                                 WHERE id IN (SELECT id FROM uniq)
                                   AND status IN ('approved','ready_to_publish','scheduled','published')),
    'published_content_count', (SELECT count(*) FROM public.mkt_content_items
                                 WHERE id IN (SELECT id FROM uniq) AND status = 'published'));
$$;

-- ── 7. Three progress measures, and three kinds of "nothing" ────────────────
-- "No target configured", "awaiting performance data" and "the result is zero"
-- are different statements. A single percentage renders all three as 0%, which
-- is why it is gone.
CREATE OR REPLACE FUNCTION public.mkt_campaign_progress(p_campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE c record; counts jsonb; req int; done int; tgt numeric; act numeric;
        deliv jsonb; pub jsonb; outcome jsonb;
BEGIN
  SELECT * INTO c FROM public.mkt_internal_campaigns WHERE id = p_campaign_id;
  IF c IS NULL THEN RETURN NULL; END IF;
  counts := public.mkt_campaign_content_counts(p_campaign_id);

  -- (a) deliverables: agreed units of work, from the campaign's own plan
  SELECT COALESCE(sum(COALESCE((d->>'required')::int, 0)), 0),
         COALESCE(sum(COALESCE((d->>'completed')::int, 0)), 0)
    INTO req, done
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.deliverables) = 'array'
                                   THEN c.deliverables ELSE '[]'::jsonb END) d;
  deliv := CASE WHEN COALESCE(req, 0) = 0
                THEN jsonb_build_object('state', 'no_target')
                ELSE jsonb_build_object('state', 'measured', 'done', done, 'total', req) END;

  -- (b) publication: of the content that IS approved, how much went out
  pub := CASE WHEN (counts->>'approved_content_count')::int = 0
              THEN jsonb_build_object('state', 'no_target')
              ELSE jsonb_build_object('state', 'measured',
                     'done',  (counts->>'published_content_count')::int,
                     'total', (counts->>'approved_content_count')::int) END;

  -- (c) outcome: the campaign's own target versus what was actually recorded.
  -- A target with no measurement is NOT zero progress; it is unmeasured.
  tgt := c.target_leads;
  act := NULLIF(c.actual_results->>'leads', '')::numeric;
  outcome := CASE
    WHEN tgt IS NULL THEN jsonb_build_object('state', 'no_target')
    WHEN act IS NULL THEN jsonb_build_object('state', 'awaiting_data', 'total', tgt)
    ELSE jsonb_build_object('state', 'measured', 'done', act, 'total', tgt) END;

  RETURN jsonb_build_object(
    'deliverables', deliv, 'publication', pub, 'outcome', outcome,
    'metric', 'leads', 'counts', counts);
END $$;

-- ── 8. Recompute the derived columns on rows written before the triggers ────
-- channel_mix and needs_classification are maintained by BEFORE triggers, so
-- rows that have not been written since the triggers were installed still carry
-- their old values — the paid campaign backfilled above was still labelled
-- channel_mix='organic'. A no-op write fires the triggers and settles them.
-- Status is untouched, so neither the status machine nor the history log reacts.
UPDATE public.mkt_internal_campaigns SET updated_at = updated_at;

COMMIT;
