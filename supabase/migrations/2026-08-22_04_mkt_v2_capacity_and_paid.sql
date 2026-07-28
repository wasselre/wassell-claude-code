-- ============================================================================
-- Marketing Management v2, part 4: channel capacity + allocations (the master
-- calendar's arithmetic), and the paid campaign hierarchy.
-- Design: docs/marketing-management-v2.md
--
-- ADDITIVE. Nothing existing is altered.
-- ============================================================================

-- ── Channel plans: capacity belongs to the CHANNEL, above any campaign ──────
-- "Two videos and one image a day" is a property of the Instagram account's
-- operating plan, not of whichever campaign happens to be running.
CREATE TABLE IF NOT EXISTS public.mkt_channel_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES public.mkt_plans(id) ON DELETE CASCADE,
  platform        text NOT NULL,
  -- Free text: our own handles are not a closed set and change over time.
  account_handle  text,

  max_per_day     integer,
  max_per_week    integer,
  -- Target mix, e.g. {"video": 14, "image": 7}. Advisory, reported against.
  format_mix      jsonb NOT NULL DEFAULT '{}'::jsonb,
  pillar_mix      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Slots held back for reactive content so breaking news never has to
  -- displace a program commitment.
  reactive_reserve integer NOT NULL DEFAULT 0,
  -- Warn when the same project appears more often than this in a week.
  same_project_max_per_week integer,
  notes           text,

  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_chp_platform_check') THEN
    ALTER TABLE public.mkt_channel_plans ADD CONSTRAINT mkt_chp_platform_check
      CHECK (platform IN ('instagram','tiktok','youtube','snapchat','x','facebook',
                          'linkedin','whatsapp','website'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_chp_nonneg') THEN
    ALTER TABLE public.mkt_channel_plans ADD CONSTRAINT mkt_chp_nonneg
      CHECK (COALESCE(max_per_day,0) >= 0 AND COALESCE(max_per_week,0) >= 0
             AND reactive_reserve >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mkt_chp_unique_channel
  ON public.mkt_channel_plans(plan_id, platform, COALESCE(account_handle, ''));

-- ── Allocations: who has claimed which slots, in which week ─────────────────
CREATE TABLE IF NOT EXISTS public.mkt_capacity_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_plan_id uuid NOT NULL REFERENCES public.mkt_channel_plans(id) ON DELETE CASCADE,
  -- Monday of the ISO week. Weekly is the unit the brief's scenario uses and
  -- the unit editorial teams actually plan in.
  week_start      date NOT NULL,
  allocation_kind text NOT NULL,
  program_id      uuid REFERENCES public.mkt_programs(id) ON DELETE CASCADE,
  campaign_id     uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  slots_requested integer NOT NULL,
  -- What the calendar actually granted. Requests may exceed capacity; grants
  -- may not. Keeping both is what makes the conflict visible instead of lost.
  slots_granted   integer,
  note            text,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ca_kind_check') THEN
    ALTER TABLE public.mkt_capacity_allocations ADD CONSTRAINT mkt_ca_kind_check
      CHECK (allocation_kind IN ('program_reservation','campaign_allocation','reactive_reserve'));
  END IF;
  -- Target must match the kind: no polymorphic guesswork.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ca_target_matches_kind') THEN
    ALTER TABLE public.mkt_capacity_allocations ADD CONSTRAINT mkt_ca_target_matches_kind
      CHECK (
        (allocation_kind = 'program_reservation'  AND program_id IS NOT NULL AND campaign_id IS NULL)
     OR (allocation_kind = 'campaign_allocation' AND campaign_id IS NOT NULL AND program_id IS NULL)
     OR (allocation_kind = 'reactive_reserve'    AND program_id IS NULL AND campaign_id IS NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ca_slots_sane') THEN
    ALTER TABLE public.mkt_capacity_allocations ADD CONSTRAINT mkt_ca_slots_sane
      CHECK (slots_requested >= 0 AND (slots_granted IS NULL OR slots_granted >= 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_ca_week ON public.mkt_capacity_allocations(channel_plan_id, week_start);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ca_unique_prog
  ON public.mkt_capacity_allocations(channel_plan_id, week_start, program_id)
  WHERE program_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ca_unique_camp
  ON public.mkt_capacity_allocations(channel_plan_id, week_start, campaign_id)
  WHERE campaign_id IS NOT NULL;

-- ── The capacity answer ─────────────────────────────────────────────────────
-- Solves the brief's scenario exactly: 21 weekly slots, 7 reserved by programs,
-- 2 held for reactive, 12 left for campaigns; six campaigns asking for 25 must
-- be reported as over-allocated by 13, naming the campaigns.
CREATE OR REPLACE FUNCTION public.mkt_capacity_status(
  p_channel_plan_id uuid, p_week_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  ch record;
  v_prog int; v_camp int; v_reactive int; v_available int;
  v_requests jsonb;
BEGIN
  SELECT * INTO ch FROM public.mkt_channel_plans WHERE id = p_channel_plan_id;
  IF ch IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(slots_requested), 0) INTO v_prog
    FROM public.mkt_capacity_allocations
    WHERE channel_plan_id = p_channel_plan_id AND week_start = p_week_start
      AND allocation_kind = 'program_reservation';

  SELECT COALESCE(sum(slots_requested), 0) INTO v_camp
    FROM public.mkt_capacity_allocations
    WHERE channel_plan_id = p_channel_plan_id AND week_start = p_week_start
      AND allocation_kind = 'campaign_allocation';

  -- An explicit reactive_reserve allocation row overrides the channel default,
  -- so a single busy week can hold back more without editing the channel plan.
  SELECT COALESCE(sum(slots_requested), ch.reactive_reserve) INTO v_reactive
    FROM public.mkt_capacity_allocations
    WHERE channel_plan_id = p_channel_plan_id AND week_start = p_week_start
      AND allocation_kind = 'reactive_reserve';

  -- Capacity is only knowable when max_per_week is set. NULL means "not
  -- configured" — reported as such, never as zero.
  v_available := CASE WHEN ch.max_per_week IS NULL THEN NULL
                      ELSE ch.max_per_week - v_prog - COALESCE(v_reactive, 0) END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'campaign_id', a.campaign_id,
           'code',        c.code,
           'name_ar',     c.name_ar,
           'requested',   a.slots_requested,
           'granted',     a.slots_granted
         ) ORDER BY a.slots_requested DESC), '[]'::jsonb)
    INTO v_requests
    FROM public.mkt_capacity_allocations a
    JOIN public.mkt_internal_campaigns c ON c.id = a.campaign_id
   WHERE a.channel_plan_id = p_channel_plan_id AND a.week_start = p_week_start
     AND a.allocation_kind = 'campaign_allocation';

  RETURN jsonb_build_object(
    'channel_plan_id',  p_channel_plan_id,
    'platform',         ch.platform,
    'account_handle',   ch.account_handle,
    'week_start',       p_week_start,
    'capacity_configured', ch.max_per_week IS NOT NULL,
    'week_capacity',    ch.max_per_week,
    'program_reserved', v_prog,
    'reactive_reserved', COALESCE(v_reactive, 0),
    'campaign_available', v_available,
    'campaign_requested', v_camp,
    'over_allocated_by', CASE WHEN v_available IS NULL THEN NULL
                              WHEN v_camp > v_available THEN v_camp - v_available
                              ELSE 0 END,
    'is_over_allocated', CASE WHEN v_available IS NULL THEN NULL
                              ELSE v_camp > v_available END,
    'campaign_requests', v_requests
  );
END $$;

-- ── Paid hierarchy ──────────────────────────────────────────────────────────
-- The shared, normalized layer lives on mkt_internal_campaigns (part 2 added
-- campaign_class='paid'). Below it, platform specifics stay in jsonb behind a
-- schema version. There is deliberately NO universal form merging every Meta,
-- TikTok, Snapchat and Google setting into one table.
CREATE TABLE IF NOT EXISTS public.mkt_platform_campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  platform           text NOT NULL,
  name               text NOT NULL,
  -- Platform-specific settings. Versioned so a platform changing its options
  -- does not invalidate historical rows or require a destructive migration.
  platform_config    jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_schema_version integer NOT NULL DEFAULT 1,
  -- Normalized reporting fields, common across platforms.
  objective          text,
  budget             numeric,
  budget_kind        text,
  start_date         date,
  end_date           date,
  destination_url    text,
  conversion_event   text,
  tracking_template  text,
  status             text NOT NULL DEFAULT 'draft',
  -- Set only if a human copies it from the ad manager. No API integration
  -- exists; this is a reference, not a sync key.
  external_id        text,
  owner_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mkt_ad_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_campaign_id uuid NOT NULL REFERENCES public.mkt_platform_campaigns(id) ON DELETE CASCADE,
  name               text NOT NULL,
  targeting          jsonb NOT NULL DEFAULT '{}'::jsonb,
  targeting_schema_version integer NOT NULL DEFAULT 1,
  budget             numeric,
  bid_strategy       text,
  start_date         date,
  end_date           date,
  status             text NOT NULL DEFAULT 'draft',
  external_id        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mkt_ads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_group_id     uuid NOT NULL REFERENCES public.mkt_ad_groups(id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- The creative is a CONTENT ITEM, not a second copy of the file. Reusing an
  -- approved organic item as an ad is a usage link, never a duplicate.
  content_item_id uuid REFERENCES public.mkt_content_items(id) ON DELETE SET NULL,
  primary_text    text,
  headline        text,
  description     text,
  cta_label       text,
  destination_url text,
  status          text NOT NULL DEFAULT 'draft',
  external_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_pc_platform_check') THEN
    ALTER TABLE public.mkt_platform_campaigns ADD CONSTRAINT mkt_pc_platform_check
      CHECK (platform IN ('meta','instagram','facebook','tiktok','snapchat','google',
                          'youtube','x','linkedin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_pc_status_check') THEN
    ALTER TABLE public.mkt_platform_campaigns ADD CONSTRAINT mkt_pc_status_check
      CHECK (status IN ('draft','scheduled','active','paused','completed','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_pc_budget_kind_check') THEN
    ALTER TABLE public.mkt_platform_campaigns ADD CONSTRAINT mkt_pc_budget_kind_check
      CHECK (budget_kind IS NULL OR budget_kind IN ('daily','lifetime'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_pc_date_order') THEN
    ALTER TABLE public.mkt_platform_campaigns ADD CONSTRAINT mkt_pc_date_order
      CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_adg_status_check') THEN
    ALTER TABLE public.mkt_ad_groups ADD CONSTRAINT mkt_adg_status_check
      CHECK (status IN ('draft','active','paused','completed','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ads_status_check') THEN
    ALTER TABLE public.mkt_ads ADD CONSTRAINT mkt_ads_status_check
      CHECK (status IN ('draft','in_review','active','paused','rejected','completed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_pc_campaign ON public.mkt_platform_campaigns(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_agr_pc ON public.mkt_ad_groups(platform_campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ads_group ON public.mkt_ads(ad_group_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ads_content ON public.mkt_ads(content_item_id);

-- A platform campaign may only hang off a PAID campaign. Otherwise the paid
-- hierarchy could quietly grow under an organic push.
CREATE OR REPLACE FUNCTION public.mkt_tg_platform_campaign_valid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_class text;
BEGIN
  SELECT campaign_class INTO v_class FROM public.mkt_internal_campaigns WHERE id = NEW.campaign_id;
  IF v_class IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION
      'a platform campaign requires a paid parent campaign (campaign_class is %)',
      COALESCE(v_class, 'not set') USING ERRCODE='check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_pc_valid ON public.mkt_platform_campaigns;
CREATE TRIGGER mkt_pc_valid BEFORE INSERT OR UPDATE ON public.mkt_platform_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_platform_campaign_valid();

-- An ad's creative must be an APPROVED content item. Running an unapproved
-- creative is the paid equivalent of publishing without approval.
CREATE OR REPLACE FUNCTION public.mkt_tg_ad_creative_approved()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_status text;
BEGIN
  IF NEW.status IN ('active','in_review') AND NEW.content_item_id IS NOT NULL THEN
    SELECT status INTO v_status FROM public.mkt_content_items WHERE id = NEW.content_item_id;
    IF v_status NOT IN ('approved','ready_to_publish','scheduled','published') THEN
      RAISE EXCEPTION
        'ad creative must be approved content before the ad goes %; creative status is %',
        NEW.status, v_status USING ERRCODE='check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_ads_creative_approved ON public.mkt_ads;
CREATE TRIGGER mkt_ads_creative_approved BEFORE INSERT OR UPDATE ON public.mkt_ads
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_ad_creative_approved();

-- Platform config validation. Deliberately PERMISSIVE and honest: the exact
-- field vocabulary for each network has NOT been verified against current
-- official documentation in this pass, so this validates shape and records the
-- schema version rather than pretending to know Meta's or TikTok's option
-- lists. Tighten per platform only once the docs have actually been checked.
CREATE OR REPLACE FUNCTION public.mkt_platform_config_issues(
  p_platform text, p_config jsonb, p_schema_version integer DEFAULT 1)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE issues text[] := ARRAY[]::text[];
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RETURN ARRAY['platform_config must be a JSON object'];
  END IF;
  IF p_schema_version < 1 THEN issues := issues || 'config_schema_version must be >= 1'; END IF;
  -- Shape-only checks that hold regardless of platform vocabulary.
  IF p_config ? 'daily_budget' AND jsonb_typeof(p_config->'daily_budget') <> 'number' THEN
    issues := issues || 'daily_budget must be a number'; END IF;
  IF p_config ? 'placements' AND jsonb_typeof(p_config->'placements') <> 'array' THEN
    issues := issues || 'placements must be an array'; END IF;
  RETURN issues;
END $$;

COMMENT ON FUNCTION public.mkt_platform_config_issues(text, jsonb, integer) IS
  'Shape-only validation. Platform option vocabularies are UNVERIFIED against official docs as of 2026-07-28; do not treat this as platform parity.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_channel_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_capacity_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_platform_campaigns   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_ad_groups            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_ads                  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; cap text;
BEGIN
  FOR t, cap IN
    SELECT * FROM (VALUES
      ('mkt_channel_plans',        'manage_capacity'),
      ('mkt_capacity_allocations', 'manage_capacity'),
      ('mkt_platform_campaigns',   'manage_paid_structure'),
      ('mkt_ad_groups',            'manage_paid_structure'),
      ('mkt_ads',                  'manage_paid_structure')
    ) AS v(t, c)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (public.wassell_mkt_can(%L))',
                   t||'_select', t, 'read_plan');
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (public.wassell_mkt_can(%L)) '
                   'WITH CHECK (public.wassell_mkt_can(%L))', t||'_write', t, cap, cap);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mkt_channel_plans,
  public.mkt_capacity_allocations, public.mkt_platform_campaigns,
  public.mkt_ad_groups, public.mkt_ads TO authenticated;

REVOKE ALL ON FUNCTION public.mkt_capacity_status(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_capacity_status(uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_platform_config_issues(text, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_platform_config_issues(text, jsonb, integer) TO authenticated, service_role;

COMMENT ON TABLE public.mkt_channel_plans IS 'Per-channel operating capacity. Sits ABOVE programs and campaigns; a campaign requests slots, the channel decides.';
COMMENT ON TABLE public.mkt_capacity_allocations IS 'slots_requested may exceed capacity; slots_granted may not. Keeping both makes over-allocation visible.';
