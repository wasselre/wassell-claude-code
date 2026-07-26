-- ============================================================================
-- 2026-08-05 — Marketing Intelligence schema, steps 4-9 of 9.
--   4. mkt_account_metrics        — audience history
--   5. mkt_project_marketing_state — per-project rollup (+ recompute fn)
--   6. mkt_share_of_voice          — competitive position over time
--   7. typed reach/spend on mkt_paid_ads
--   8. referential integrity
--   9. deprecation markers (NOTHING dropped)
-- All additive. See docs/marketing-intelligence-schema.md.
-- ============================================================================

-- ── 4. Audience history ─────────────────────────────────────────────────────
-- mkt_social_accounts.followers is a SCALAR each sync overwrites, populated on
-- 1 of 29 accounts. "Is this competitor growing?" is unanswerable without a
-- series. The scalar stays as the convenient "latest" value.
CREATE TABLE IF NOT EXISTS public.mkt_account_metrics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id uuid NOT NULL REFERENCES public.mkt_social_accounts(id) ON DELETE CASCADE,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  followers         integer,
  following         integer,
  posts_count       integer,
  provider          text,
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_account_metrics_unique UNIQUE (social_account_id, captured_at)
);
CREATE INDEX IF NOT EXISTS mkt_account_metrics_acct_idx
  ON public.mkt_account_metrics(social_account_id, captured_at DESC);
ALTER TABLE public.mkt_account_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_account_metrics_read ON public.mkt_account_metrics;
CREATE POLICY mkt_account_metrics_read ON public.mkt_account_metrics
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.mkt_account_metrics (social_account_id, captured_at, followers, provider)
SELECT id, coalesce(last_metrics_at, last_synced_at, now()), followers, provider
FROM public.mkt_social_accounts WHERE followers IS NOT NULL
ON CONFLICT (social_account_id, captured_at) DO NOTHING;

-- ── 7. Typed reach / spend ──────────────────────────────────────────────────
-- reach_info is untyped jsonb and empty on 10/10 ads: even if a provider gave us
-- reach or spend today there is nowhere queryable to put it.
ALTER TABLE public.mkt_paid_ads
  ADD COLUMN IF NOT EXISTS reach_lower       bigint,
  ADD COLUMN IF NOT EXISTS reach_upper       bigint,
  ADD COLUMN IF NOT EXISTS impressions_lower bigint,
  ADD COLUMN IF NOT EXISTS impressions_upper bigint,
  ADD COLUMN IF NOT EXISTS spend_lower       numeric,
  ADD COLUMN IF NOT EXISTS spend_upper       numeric,
  ADD COLUMN IF NOT EXISTS spend_currency    text,
  ADD COLUMN IF NOT EXISTS active_days       integer;

COMMENT ON COLUMN public.mkt_paid_ads.reach_info IS
  'Legacy untyped provider payload. Prefer the typed reach_/impressions_/spend_ '
  'columns; keep this as the raw record of what the provider returned.';

-- ── 5. Per-project rollup ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_project_marketing_state (
  project_id            uuid PRIMARY KEY,   -- all_projects record (JSONB: no FK)
  post_count            integer NOT NULL DEFAULT 0,
  candidate_post_count  integer NOT NULL DEFAULT 0,
  ad_count              integer NOT NULL DEFAULT 0,
  platform_count        integer NOT NULL DEFAULT 0,
  platforms             text[]  NOT NULL DEFAULT '{}',
  org_count             integer NOT NULL DEFAULT 0,
  campaign_count        integer NOT NULL DEFAULT 0,
  active_campaign_count integer NOT NULL DEFAULT 0,
  fact_count            integer NOT NULL DEFAULT 0,
  min_advertised_price  numeric,
  max_advertised_price  numeric,
  first_activity_at     timestamptz,
  last_activity_at      timestamptz,
  computed_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mkt_project_marketing_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_project_marketing_state_read ON public.mkt_project_marketing_state;
CREATE POLICY mkt_project_marketing_state_read ON public.mkt_project_marketing_state
  FOR SELECT TO authenticated USING (true);

-- CRITICAL: strong vs speculative attributions must not be conflated.
-- 3 842 of 4 636 attributions (83%) are `marketer_assignment` at confidence 0.40
-- with review_status='candidate' — they mean "this org markets these projects so
-- this post MIGHT relate to any of them". Counting them as real made nearly every
-- project look like it had ~130 posts on 3 platforms. That is how a rollup
-- silently manufactures false intelligence.
CREATE OR REPLACE FUNCTION public.mkt_recompute_project_marketing_state()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  WITH strong AS (
    SELECT a.project_id,
           count(DISTINCT cp.id)              AS post_count,
           count(DISTINCT cp.platform)        AS platform_count,
           array_agg(DISTINCT cp.platform)    AS platforms,
           count(DISTINCT cp.organization_id) AS org_count,
           min(cp.published_at)               AS first_at,
           max(cp.published_at)               AS last_at
    FROM mkt_content_attributions a
    JOIN mkt_content_posts cp ON cp.id = a.content_post_id
    WHERE a.review_status IN ('auto_accepted','confirmed')
    GROUP BY a.project_id
  ),
  weak AS (
    SELECT a.project_id, count(DISTINCT a.content_post_id) AS candidate_post_count
    FROM mkt_content_attributions a
    WHERE a.review_status NOT IN ('auto_accepted','confirmed')
    GROUP BY a.project_id
  ),
  camps AS (
    SELECT project_id, count(*) AS campaign_count,
           count(*) FILTER (WHERE is_active) AS active_campaign_count
    FROM mkt_campaigns WHERE project_id IS NOT NULL GROUP BY project_id
  ),
  facts AS (
    SELECT project_id, count(*) AS fact_count,
           min(value_num) FILTER (WHERE fact_type='price') AS min_price,
           max(value_num) FILTER (WHERE fact_type='price') AS max_price
    FROM mkt_observed_facts WHERE project_id IS NOT NULL GROUP BY project_id
  ),
  keys AS (
    SELECT project_id FROM strong UNION SELECT project_id FROM weak
    UNION SELECT project_id FROM camps UNION SELECT project_id FROM facts
  ),
  merged AS (
    SELECT k.project_id,
           coalesce(s.post_count, 0)            AS post_count,
           coalesce(w.candidate_post_count, 0)  AS candidate_post_count,
           coalesce(s.platform_count, 0)        AS platform_count,
           coalesce(s.platforms, '{}')          AS platforms,
           coalesce(s.org_count, 0)             AS org_count,
           coalesce(c.campaign_count, 0)        AS campaign_count,
           coalesce(c.active_campaign_count, 0) AS active_campaign_count,
           coalesce(f.fact_count, 0)            AS fact_count,
           f.min_price, f.max_price, s.first_at, s.last_at
    FROM keys k
    LEFT JOIN strong s ON s.project_id = k.project_id
    LEFT JOIN weak   w ON w.project_id = k.project_id
    LEFT JOIN camps  c ON c.project_id = k.project_id
    LEFT JOIN facts  f ON f.project_id = k.project_id
  )
  INSERT INTO mkt_project_marketing_state
    (project_id, post_count, candidate_post_count, platform_count, platforms,
     org_count, campaign_count, active_campaign_count, fact_count,
     min_advertised_price, max_advertised_price, first_activity_at, last_activity_at, computed_at)
  SELECT project_id, post_count, candidate_post_count, platform_count, platforms,
         org_count, campaign_count, active_campaign_count, fact_count,
         min_price, max_price, first_at, last_at, now()
  FROM merged WHERE project_id IS NOT NULL
  ON CONFLICT (project_id) DO UPDATE SET
    post_count=EXCLUDED.post_count, candidate_post_count=EXCLUDED.candidate_post_count,
    platform_count=EXCLUDED.platform_count, platforms=EXCLUDED.platforms,
    org_count=EXCLUDED.org_count, campaign_count=EXCLUDED.campaign_count,
    active_campaign_count=EXCLUDED.active_campaign_count, fact_count=EXCLUDED.fact_count,
    min_advertised_price=EXCLUDED.min_advertised_price,
    max_advertised_price=EXCLUDED.max_advertised_price,
    first_activity_at=EXCLUDED.first_activity_at, last_activity_at=EXCLUDED.last_activity_at,
    computed_at=now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION public.mkt_recompute_project_marketing_state() TO service_role, authenticated;

-- ── 6. Share of voice ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_share_of_voice (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  scope_type       text NOT NULL,     -- market | city | district
  scope_key        text NOT NULL,     -- '' for market-wide
  organization_id  uuid NOT NULL REFERENCES public.mkt_organizations(id) ON DELETE CASCADE,
  post_count       integer NOT NULL DEFAULT 0,
  ad_count         integer NOT NULL DEFAULT 0,
  engagement_total bigint  NOT NULL DEFAULT 0,
  share_pct        numeric NOT NULL DEFAULT 0,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_share_of_voice_scope_check CHECK (scope_type IN ('market','city','district')),
  CONSTRAINT mkt_share_of_voice_unique UNIQUE (period_start, period_end, scope_type, scope_key, organization_id)
);
CREATE INDEX IF NOT EXISTS mkt_share_of_voice_scope_idx
  ON public.mkt_share_of_voice(scope_type, scope_key, period_start DESC);
ALTER TABLE public.mkt_share_of_voice ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_share_of_voice_read ON public.mkt_share_of_voice;
CREATE POLICY mkt_share_of_voice_read ON public.mkt_share_of_voice
  FOR SELECT TO authenticated USING (true);

-- ── 8. Referential integrity ────────────────────────────────────────────────
-- Every FK below was verified to have ZERO orphans first, so all validate
-- immediately (no NOT VALID, which would be integrity theatre).
-- project_id is excluded everywhere: projects live in the JSONB `records` table.
ALTER TABLE public.mkt_campaigns
  ADD CONSTRAINT mkt_campaigns_org_fk FOREIGN KEY (organization_id)
  REFERENCES public.mkt_organizations(id) ON DELETE CASCADE;
ALTER TABLE public.mkt_insights
  ADD CONSTRAINT mkt_insights_org_fk FOREIGN KEY (organization_id)
  REFERENCES public.mkt_organizations(id) ON DELETE CASCADE;
ALTER TABLE public.mkt_landing_pages
  ADD CONSTRAINT mkt_landing_pages_org_fk FOREIGN KEY (organization_id)
  REFERENCES public.mkt_organizations(id) ON DELETE CASCADE;
ALTER TABLE public.mkt_ad_campaigns
  ADD CONSTRAINT mkt_ad_campaigns_org_fk FOREIGN KEY (organization_id)
  REFERENCES public.mkt_organizations(id) ON DELETE CASCADE;
ALTER TABLE public.mkt_campaign_summaries
  ADD CONSTRAINT mkt_campaign_summaries_org_fk FOREIGN KEY (organization_id)
  REFERENCES public.mkt_organizations(id) ON DELETE CASCADE;
ALTER TABLE public.mkt_paid_ads
  ADD CONSTRAINT mkt_paid_ads_landing_page_fk FOREIGN KEY (landing_page_id)
  REFERENCES public.mkt_landing_pages(id) ON DELETE SET NULL;
ALTER TABLE public.mkt_paid_ads
  ADD CONSTRAINT mkt_paid_ads_ad_campaign_fk FOREIGN KEY (campaign_id)
  REFERENCES public.mkt_ad_campaigns(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.mkt_paid_ads.campaign_id IS
  'References mkt_ad_campaigns (paid-only grouping). The cross-platform campaign '
  'membership for the same ad lives in mkt_campaign_members. See '
  'docs/marketing-intelligence-schema.md §2.4.';

-- mkt_insights.campaign_id gets NO FK: it is genuinely POLYMORPHIC. All 14
-- currently-set values resolve to mkt_ad_campaigns, but the cross-platform
-- insight rules write mkt_campaigns ids into the same column. Rather than pick a
-- side and break one, make the ambiguity explicit and resolvable.
ALTER TABLE public.mkt_insights ADD COLUMN IF NOT EXISTS campaign_scope text;
UPDATE public.mkt_insights i SET campaign_scope =
  CASE WHEN EXISTS (SELECT 1 FROM public.mkt_campaigns c    WHERE c.id=i.campaign_id) THEN 'cross_platform'
       WHEN EXISTS (SELECT 1 FROM public.mkt_ad_campaigns a WHERE a.id=i.campaign_id) THEN 'paid' END
WHERE i.campaign_id IS NOT NULL AND i.campaign_scope IS NULL;
ALTER TABLE public.mkt_insights
  ADD CONSTRAINT mkt_insights_campaign_scope_check
  CHECK (campaign_scope IS NULL OR campaign_scope IN ('cross_platform','paid'));
COMMENT ON COLUMN public.mkt_insights.campaign_id IS
  'POLYMORPHIC — resolve against the table named by campaign_scope '
  '(cross_platform -> mkt_campaigns, paid -> mkt_ad_campaigns). No FK is possible '
  'until the two campaign entities are unified.';

-- ── 9. Deprecation markers. NOTHING IS DROPPED. ─────────────────────────────
COMMENT ON TABLE public.mkt_ad_campaigns IS
  'SUPERSEDED by mkt_campaigns (cross-platform, cg-v1), which spans organic + paid '
  'and carries corrections and summaries. Still load-bearing: 10/10 '
  'mkt_paid_ads.campaign_id and 14 mkt_insights rows point here. Do not drop until '
  'both are migrated. See docs/marketing-intelligence-schema.md §2.4.';
COMMENT ON COLUMN public.mkt_organizations.org_type IS
  'SUPERSEDED by mkt_project_organizations.relationship_type. An org is a developer '
  'on some projects and a marketer on others, so a single scalar cannot be correct — '
  'it reads 200 developer / 1 marketer while the link table records 950 developer, '
  '49 authorized_marketer, 7 observed_marketer. See §2.6.';
COMMENT ON TABLE public.mkt_assets IS
  'Our OWN creative production pipeline (hook/script/production_stage) — not '
  'competitor intelligence. 0 rows, never used.';
COMMENT ON TABLE public.mkt_project_marketing_state IS
  'Per-project marketing rollup via mkt_recompute_project_marketing_state(). '
  'post_count counts ONLY auto_accepted/confirmed attributions; speculative '
  'candidates live in candidate_post_count and must never be shown as confirmed.';
COMMENT ON TABLE public.mkt_share_of_voice IS
  'Deterministic competitive-position aggregate. ZERO AI in any number.';
COMMENT ON TABLE public.mkt_account_metrics IS
  'Audience history per social account. mkt_social_accounts.followers remains the '
  'convenience "latest" scalar; this table is the series.';
