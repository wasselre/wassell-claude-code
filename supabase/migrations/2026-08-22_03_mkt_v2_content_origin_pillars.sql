-- ============================================================================
-- Marketing Management v2, part 3: content pillars, primary production origin,
-- usage links, and the strategic-context approval gate.
-- Design: docs/marketing-management-v2.md
--
-- PREREQUISITE: 2026-08-21_mkt_content_marketing_fields.sql must be applied
-- first (filename order does this on a sequential replay). The gate below reads
-- cta_destination from that migration. Rather than silently building a gate
-- that cannot see one of its inputs, this file FAILS LOUDLY if the prerequisite
-- is missing — a half-applied gate is a correctness bug that looks like success.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='mkt_content_items'
      AND column_name='cta_destination'
  ) THEN
    RAISE EXCEPTION
      'prerequisite missing: apply 2026-08-21_mkt_content_marketing_fields.sql before this file '
      '(mkt_content_items.cta_destination does not exist)';
  END IF;
END $$;

-- ── Content pillars: classification, never a container ──────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_pillars (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug      text NOT NULL UNIQUE,
  name_ar   text NOT NULL,
  name_en   text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seeded, not hardcoded in the app: pillars are business vocabulary the team
-- should be able to extend without a deploy. ON CONFLICT DO NOTHING so a replay
-- never duplicates and never overwrites a renamed pillar.
INSERT INTO public.mkt_content_pillars (slug, name_ar, name_en, sort_order) VALUES
  ('project_discovery',   'استكشاف المشاريع',      'Project discovery',   10),
  ('project_walkthrough', 'جولات المشاريع',        'Project walkthroughs',20),
  ('market_intelligence', 'ذكاء السوق',            'Market intelligence', 30),
  ('financing_education', 'التثقيف التمويلي',      'Financing education', 40),
  ('buying_education',    'التثقيف الشرائي',       'Buying education',    50),
  ('investment_analysis', 'التحليل الاستثماري',    'Investment analysis', 60),
  ('developer_credibility','مصداقية المطوّر',      'Developer credibility',70),
  ('social_proof',        'آراء العملاء',          'Social proof',        80),
  ('wassel_brand',        'علامة وصل',             'Wassel brand',        90),
  ('objection_handling',  'معالجة الاعتراضات',     'Objection handling',  100),
  ('lifestyle_locations', 'نمط الحياة والمواقع',   'Lifestyle & locations',110),
  ('direct_conversion',   'عروض التحويل المباشر',  'Direct conversion offers',120)
ON CONFLICT (slug) DO NOTHING;

-- ── Content: strategic context + primary origin ─────────────────────────────
ALTER TABLE public.mkt_content_items
  ADD COLUMN IF NOT EXISTS plan_id          uuid REFERENCES public.mkt_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_goal_id  uuid REFERENCES public.mkt_goals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_pillar_id uuid REFERENCES public.mkt_content_pillars(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS strategic_purpose text,
  -- Exactly one production origin, fixed at creation. Reuse never rewrites it.
  ADD COLUMN IF NOT EXISTS origin_kind      text,
  ADD COLUMN IF NOT EXISTS origin_program_id  uuid REFERENCES public.mkt_programs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_campaign_id uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE SET NULL,
  -- Why a reactive item was made now. Meaningless for other origins.
  ADD COLUMN IF NOT EXISTS reactive_trigger text,
  ADD COLUMN IF NOT EXISTS needs_classification boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_origin_kind_check') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_origin_kind_check
      CHECK (origin_kind IS NULL OR origin_kind IN
             ('program','campaign','reactive','standalone')) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_origin_kind_check;
  END IF;
  -- The kind and the populated FK must agree. This is what replaces an unsafe
  -- entity_type/entity_id pair: every reference is a real, verifiable FK, and
  -- the CHECK guarantees the label matches the target.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_ci_origin_matches_kind') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_origin_matches_kind
      CHECK (
        origin_kind IS NULL
        OR (origin_kind = 'program'    AND origin_program_id IS NOT NULL AND origin_campaign_id IS NULL)
        OR (origin_kind = 'campaign'   AND origin_campaign_id IS NOT NULL AND origin_program_id IS NULL)
        OR (origin_kind IN ('reactive','standalone')
            AND origin_program_id IS NULL AND origin_campaign_id IS NULL)
      ) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_origin_matches_kind;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_ci_plan   ON public.mkt_content_items(plan_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_goal   ON public.mkt_content_items(primary_goal_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_origin_prog ON public.mkt_content_items(origin_program_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_origin_camp ON public.mkt_content_items(origin_campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_ci_pillar ON public.mkt_content_items(primary_pillar_id);

-- Additional pillars. One primary (column) + many secondary (junction), so
-- content-mix reporting can count a primary pillar without double counting.
CREATE TABLE IF NOT EXISTS public.mkt_content_item_pillars (
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  pillar_id       uuid NOT NULL REFERENCES public.mkt_content_pillars(id) ON DELETE CASCADE,
  PRIMARY KEY (content_item_id, pillar_id)
);

-- ── Back-compatibility: keep campaign_id in step with origin_campaign_id ────
-- The existing UI, the 30 API actions and mkt_mgmt_overview all read
-- campaign_id. Rather than a risky rename, the legacy column is kept as a
-- mirror so nothing breaks between migration and deployment. It is written by
-- the trigger only; a later cleanup migration may drop it once no reader
-- remains. Whichever side the caller sets, both end up equal.
CREATE OR REPLACE FUNCTION public.mkt_tg_content_origin_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin_campaign_id IS NULL AND NEW.campaign_id IS NOT NULL THEN
      NEW.origin_campaign_id := NEW.campaign_id;
      IF NEW.origin_kind IS NULL THEN NEW.origin_kind := 'campaign'; END IF;
    ELSIF NEW.origin_campaign_id IS NOT NULL THEN
      NEW.campaign_id := NEW.origin_campaign_id;
    END IF;
  ELSE
    -- Follow whichever side actually changed this statement.
    IF NEW.origin_campaign_id IS DISTINCT FROM OLD.origin_campaign_id THEN
      NEW.campaign_id := NEW.origin_campaign_id;
    ELSIF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
      NEW.origin_campaign_id := NEW.campaign_id;
      IF NEW.campaign_id IS NOT NULL AND NEW.origin_kind IS NULL THEN
        NEW.origin_kind := 'campaign';
      END IF;
    END IF;
  END IF;

  -- Mirror the legacy free-text pillar into the FK when it matches a slug, so
  -- existing rows classify themselves instead of needing hand re-entry.
  IF NEW.primary_pillar_id IS NULL AND NEW.content_pillar IS NOT NULL THEN
    SELECT id INTO NEW.primary_pillar_id FROM public.mkt_content_pillars
      WHERE slug = NEW.content_pillar OR name_en = NEW.content_pillar OR name_ar = NEW.content_pillar
      LIMIT 1;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_ci_origin_sync ON public.mkt_content_items;
-- Ordered to run before the existing status trigger by name (mkt_ci_ < mkt_tg_).
CREATE TRIGGER mkt_ci_origin_sync BEFORE INSERT OR UPDATE ON public.mkt_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_content_origin_sync();

-- ── Usage: reuse without rewriting origin ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL REFERENCES public.mkt_content_items(id) ON DELETE CASCADE,
  usage_kind      text NOT NULL,
  -- One nullable FK per target kind; the CHECK below allows exactly one.
  campaign_id     uuid REFERENCES public.mkt_internal_campaigns(id) ON DELETE CASCADE,
  program_id      uuid REFERENCES public.mkt_programs(id) ON DELETE CASCADE,
  initiative_id   uuid REFERENCES public.mkt_initiatives(id) ON DELETE CASCADE,
  publication_id  uuid REFERENCES public.mkt_publications(id) ON DELETE CASCADE,
  note            text,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_cu_kind_check') THEN
    ALTER TABLE public.mkt_content_usage ADD CONSTRAINT mkt_cu_kind_check
      CHECK (usage_kind IN ('organic_publication','paid_ad','campaign','program','initiative'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_cu_exactly_one_target') THEN
    ALTER TABLE public.mkt_content_usage ADD CONSTRAINT mkt_cu_exactly_one_target
      CHECK ((campaign_id IS NOT NULL)::int + (program_id IS NOT NULL)::int
           + (initiative_id IS NOT NULL)::int + (publication_id IS NOT NULL)::int = 1);
  END IF;
END $$;

-- No duplicate usage links: reuse must never multiply a lead or a view when
-- performance rolls up. This is the constraint that makes roll-up honest.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_cu_unique_camp
  ON public.mkt_content_usage(content_item_id, usage_kind, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_cu_unique_prog
  ON public.mkt_content_usage(content_item_id, usage_kind, program_id) WHERE program_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_cu_unique_init
  ON public.mkt_content_usage(content_item_id, usage_kind, initiative_id) WHERE initiative_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_cu_unique_pub
  ON public.mkt_content_usage(content_item_id, usage_kind, publication_id) WHERE publication_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_cu_content ON public.mkt_content_usage(content_item_id);

-- ── The approval gate ───────────────────────────────────────────────────────
-- Draft content may be unclassified: that is where thinking happens. But it may
-- not be approved, scheduled, advertised or published without strategic
-- context. Returns ONE message listing exactly what is missing so the UI can
-- show the same list — a silent block would be worse than no gate.
CREATE OR REPLACE FUNCTION public.mkt_content_missing_context(p_content_item_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE c record; missing text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO c FROM public.mkt_content_items WHERE id = p_content_item_id;
  IF c IS NULL THEN RETURN ARRAY['content item not found']; END IF;

  IF c.strategic_purpose IS NULL OR btrim(c.strategic_purpose) = '' THEN
    missing := array_append(missing, 'strategic_purpose'); END IF;
  IF c.plan_id IS NULL          THEN missing := array_append(missing, 'plan'); END IF;
  IF c.primary_goal_id IS NULL  THEN missing := array_append(missing, 'primary_goal'); END IF;
  IF c.origin_kind IS NULL      THEN missing := array_append(missing, 'origin'); END IF;
  IF c.primary_pillar_id IS NULL THEN missing := array_append(missing, 'primary_pillar'); END IF;
  IF c.target_audience IS NULL OR btrim(c.target_audience) = '' THEN
    missing := array_append(missing, 'audience'); END IF;
  -- Either a CTA destination or CTA text satisfies "intended result". Choosing
  -- 'none' is itself a deliberate answer and passes; saying nothing at all does
  -- not. This is why the check is on absence, not on the value.
  IF c.cta_destination IS NULL AND (c.cta IS NULL OR btrim(c.cta) = '') THEN
    missing := array_append(missing, 'intended_result_or_cta'); END IF;

  RETURN missing;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_tg_content_context_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE gated text[] := ARRAY['awaiting_final_approval','approved','ready_to_publish',
                              'scheduled','published'];
        missing text[];
BEGIN
  IF NEW.status = ANY(gated) AND NEW.status IS DISTINCT FROM OLD.status THEN
    missing := public.mkt_content_missing_context(NEW.id);
    IF array_length(missing, 1) > 0 THEN
      RAISE EXCEPTION
        'content % cannot move to % until its strategic context is complete — missing: %',
        NEW.content_number, NEW.status, array_to_string(missing, ', ')
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Named to sort AFTER the origin-sync trigger so the gate reads synced values.
DROP TRIGGER IF EXISTS mkt_ci_zz_context_gate ON public.mkt_content_items;
CREATE TRIGGER mkt_ci_zz_context_gate BEFORE UPDATE ON public.mkt_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_content_context_gate();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.mkt_content_pillars      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_content_item_pillars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_content_usage        ENABLE ROW LEVEL SECURITY;

-- Pillars are shared vocabulary: readable by anyone who can read marketing,
-- writable only by planners.
DROP POLICY IF EXISTS mkt_content_pillars_select ON public.mkt_content_pillars;
CREATE POLICY mkt_content_pillars_select ON public.mkt_content_pillars
  FOR SELECT USING (public.wassell_mkt_can('read'));
DROP POLICY IF EXISTS mkt_content_pillars_write ON public.mkt_content_pillars;
CREATE POLICY mkt_content_pillars_write ON public.mkt_content_pillars
  FOR ALL USING (public.wassell_mkt_can('write_plan'))
  WITH CHECK (public.wassell_mkt_can('write_plan'));

DROP POLICY IF EXISTS mkt_content_item_pillars_select ON public.mkt_content_item_pillars;
CREATE POLICY mkt_content_item_pillars_select ON public.mkt_content_item_pillars
  FOR SELECT USING (public.wassell_mkt_can('read'));
DROP POLICY IF EXISTS mkt_content_item_pillars_write ON public.mkt_content_item_pillars;
CREATE POLICY mkt_content_item_pillars_write ON public.mkt_content_item_pillars
  FOR ALL USING (public.wassell_mkt_can('write_content'))
  WITH CHECK (public.wassell_mkt_can('write_content'));

DROP POLICY IF EXISTS mkt_content_usage_select ON public.mkt_content_usage;
CREATE POLICY mkt_content_usage_select ON public.mkt_content_usage
  FOR SELECT USING (public.wassell_mkt_can('read'));
DROP POLICY IF EXISTS mkt_content_usage_write ON public.mkt_content_usage;
CREATE POLICY mkt_content_usage_write ON public.mkt_content_usage
  FOR ALL USING (public.wassell_mkt_can('write_content'))
  WITH CHECK (public.wassell_mkt_can('write_content'));

GRANT SELECT ON public.mkt_content_pillars TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.mkt_content_pillars TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mkt_content_item_pillars,
  public.mkt_content_usage TO authenticated;

REVOKE ALL ON FUNCTION public.mkt_content_missing_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_content_missing_context(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.mkt_content_items.origin_kind IS 'program | campaign | reactive | standalone. Fixed at creation; reuse is recorded in mkt_content_usage and never rewrites this.';
COMMENT ON COLUMN public.mkt_content_items.campaign_id IS 'LEGACY MIRROR of origin_campaign_id, kept in sync by trigger for the existing UI/API. Do not write directly in new code.';
COMMENT ON TABLE  public.mkt_content_usage IS 'Reuse of an approved item. Unique per (item, kind, target) so roll-up cannot double count.';
