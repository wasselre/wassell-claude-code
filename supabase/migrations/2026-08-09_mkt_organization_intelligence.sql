-- ============================================================================
-- 2026-08-09 — Phase 4: Organization Intelligence backend.
--
-- Part 1 makes follower growth measurable AT ALL (nothing was writing history).
-- Part 2 adds the composite read, the mirror of mkt_project_intelligence.
--
-- Serves developers AND marketing companies from ONE function: the role is read
-- per-project from mkt_project_organizations.relationship_type, because 9 orgs
-- in production hold more than one role and a per-org type cannot express that
-- (docs §2.6).
--
-- No new tables. Composes the Phase 2 primitives. Deterministic.
-- ============================================================================

-- ── Part 1: capture follower history ────────────────────────────────────────
-- mkt_account_metrics was created in the schema pass but NOTHING wrote to it
-- over time: the collector only overwrites the mkt_social_accounts.followers
-- scalar. Measured before this migration: 1 row total, ZERO accounts with more
-- than one row — so "growth over time", a required output, was structurally
-- unanswerable and would have stayed that way however the page was written.
--
-- Same trigger posture as fact emission: one SQL definition, fires for every
-- writer, no application code to keep in sync across the worker and runner
-- packages. Day-bucketed so repeated syncs in one day UPDATE rather than
-- inflate the series; UNIQUE(social_account_id, captured_at) makes that atomic.
CREATE OR REPLACE FUNCTION public.mkt_tg_capture_account_metrics()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  BEGIN
    IF NEW.followers IS NOT NULL THEN
      INSERT INTO mkt_account_metrics (social_account_id, captured_at, followers, provider)
      VALUES (NEW.id, date_trunc('day', now()), NEW.followers, NEW.provider)
      ON CONFLICT (social_account_id, captured_at)
      DO UPDATE SET followers = EXCLUDED.followers, provider = EXCLUDED.provider;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Same asymmetric-cost rule as fact emission: losing the account sync to
    -- protect a derived history row would be the worse trade. Loud, not silent.
    RAISE WARNING 'mkt_account_metrics capture failed for account % : % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS mkt_social_accounts_capture_metrics ON public.mkt_social_accounts;
CREATE TRIGGER mkt_social_accounts_capture_metrics
  AFTER INSERT OR UPDATE OF followers ON public.mkt_social_accounts
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_capture_account_metrics();

COMMENT ON TABLE public.mkt_account_metrics IS
  'Audience history per social account, appended by the '
  'mkt_social_accounts_capture_metrics trigger (day-bucketed). '
  'mkt_social_accounts.followers remains the convenience "latest" scalar. '
  'Growth is only measurable once an account has >= 2 rows, so the Organization '
  'Intelligence payload reports growth_measurable explicitly rather than '
  'returning an empty series that reads as "no growth".';

-- ── Part 2: the composite read ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_organization_intelligence(
  p_org_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_lim  int  := greatest(1, least(coalesce(p_limit,10), 50));
  v_from date := coalesce(p_from, '1900-01-01'::date);
  v_to   date := coalesce(p_to,   '2999-12-31'::date);
  v_out  jsonb;
BEGIN
  SELECT jsonb_build_object(
    'generated_at', now(),
    'window', jsonb_build_object('from', p_from, 'to', p_to),

    'organization', (
      SELECT jsonb_build_object(
        'id', o.id, 'name', coalesce(o.name_en, o.name_ar),
        'name_ar', o.name_ar, 'name_en', o.name_en,
        'website', o.website, 'hq_city', o.hq_city, 'status', o.status,
        'followers_cached', o.followers_cached,
        'meta_page_url', o.meta_page_url, 'meta_confirmed', o.meta_confirmed,
        'developer_record_id', o.developer_record_id)
      FROM mkt_organizations o WHERE o.id = p_org_id),

    -- What this org IS, derived from its links (never from org_type, superseded)
    'roles', coalesce((
      SELECT jsonb_object_agg(relationship_type, n) FROM (
        SELECT relationship_type, count(DISTINCT project_id) AS n
        FROM mkt_project_organizations WHERE organization_id = p_org_id
        GROUP BY relationship_type) r), '{}'::jsonb),

    'projects', jsonb_build_object(
      'total', (SELECT count(DISTINCT project_id) FROM mkt_project_organizations
                WHERE organization_id = p_org_id),
      'shown', v_lim,
      'items', coalesce((
        SELECT jsonb_agg(x ORDER BY (x->>'post_count')::int DESC NULLS LAST) FROM (
          SELECT jsonb_build_object(
            'project_id', po.project_id, 'name', r.data->>'project_name',
            'city', r.data->>'city_name', 'status', r.data->>'project_status',
            'role', po.relationship_type, 'human_confirmed', po.human_confirmed,
            'post_count', coalesce(s.post_count, 0),
            'candidate_post_count', coalesce(s.candidate_post_count, 0),
            'fact_count', coalesce(s.fact_count, 0),
            'last_activity_at', s.last_activity_at,
            'min_advertised_price', s.min_advertised_price,
            'max_advertised_price', s.max_advertised_price) AS x
          FROM mkt_project_organizations po
          LEFT JOIN unified_records r ON r.id = po.project_id
          LEFT JOIN mkt_project_marketing_state s ON s.project_id = po.project_id
          WHERE po.organization_id = p_org_id
          ORDER BY coalesce(s.post_count,0) DESC, s.last_activity_at DESC NULLS LAST
          LIMIT v_lim) z), '[]'::jsonb)),

    'social_accounts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', sa.id, 'platform', sa.platform, 'handle', sa.handle,
        'profile_url', sa.profile_url, 'followers', sa.followers,
        'verified', sa.verified, 'collection_enabled', sa.collection_enabled,
        'last_synced_at', sa.last_synced_at)
        ORDER BY sa.followers DESC NULLS LAST, sa.platform)
      FROM mkt_social_accounts sa WHERE sa.organization_id = p_org_id), '[]'::jsonb),

    -- ── Audience growth. Honest about whether it is measurable AT ALL. ─────
    'audience', (
      WITH series AS (
        SELECT am.social_account_id, am.captured_at, am.followers
        FROM mkt_account_metrics am
        JOIN mkt_social_accounts sa ON sa.id = am.social_account_id
        WHERE sa.organization_id = p_org_id
      ),
      per_account AS (
        SELECT social_account_id, count(*) AS points,
               min(captured_at) AS first_at, max(captured_at) AS last_at,
               (array_agg(followers ORDER BY captured_at))[1] AS first_followers,
               (array_agg(followers ORDER BY captured_at DESC))[1] AS last_followers
        FROM series GROUP BY social_account_id
      )
      SELECT jsonb_build_object(
        'current_followers', (SELECT sum(followers) FROM mkt_social_accounts
                              WHERE organization_id = p_org_id),
        'history_points', coalesce((SELECT sum(points) FROM per_account), 0),
        -- >= 2 observations needed. Saying so is the difference between
        -- "no growth" and "we cannot see growth yet".
        'growth_measurable', coalesce((SELECT bool_or(points >= 2) FROM per_account), false),
        'net_change', (SELECT sum(last_followers - first_followers) FROM per_account WHERE points >= 2),
        'first_observed_at', (SELECT min(first_at) FROM per_account),
        'last_observed_at', (SELECT max(last_at) FROM per_account),
        'series', coalesce((
          SELECT jsonb_agg(jsonb_build_object('day', d, 'followers', f) ORDER BY d)
          FROM (SELECT captured_at::date AS d, sum(followers) AS f
                FROM series GROUP BY 1) g), '[]'::jsonb))),

    -- ── Posting frequency: rate + current-vs-prior comparison ──────────────
    'posting_frequency', (
      WITH months AS (
        SELECT t.bucket_start, t.posts
        FROM mkt_activity_trend('month', p_from, p_to, p_org_id, NULL) t
      ),
      recent AS (
        SELECT coalesce(sum(posts),0)::numeric AS n FROM months
        WHERE bucket_start >= (date_trunc('month', now()) - interval '3 months')::date
      ),
      prior AS (
        SELECT coalesce(sum(posts),0)::numeric AS n FROM months
        WHERE bucket_start >= (date_trunc('month', now()) - interval '6 months')::date
          AND bucket_start <  (date_trunc('month', now()) - interval '3 months')::date
      )
      SELECT jsonb_build_object(
        'total_posts', (SELECT coalesce(sum(posts),0) FROM months),
        'months_active', (SELECT count(*) FROM months WHERE posts > 0),
        'avg_posts_per_active_month',
          (SELECT round(avg(posts)::numeric, 1) FROM months WHERE posts > 0),
        'last_3_months', (SELECT n FROM recent),
        'prior_3_months', (SELECT n FROM prior),
        -- NULL (not 0) with no prior baseline: a percentage against zero
        -- history would be a fabricated claim.
        'change_pct', CASE WHEN (SELECT n FROM prior) > 0
                           THEN round(100 * ((SELECT n FROM recent) - (SELECT n FROM prior))
                                          / (SELECT n FROM prior), 1) END)),

    'ads', jsonb_build_object(
      'total', (SELECT count(*) FROM mkt_paid_ads WHERE organization_id = p_org_id),
      'active', (SELECT count(*) FROM mkt_paid_ads WHERE organization_id = p_org_id AND is_active),
      'shown', v_lim,
      'recent', coalesce((
        SELECT jsonb_agg(x ORDER BY x->>'started_at' DESC NULLS LAST) FROM (
          SELECT jsonb_build_object(
            'ad_id', pa.id, 'platform', pa.platform, 'headline', pa.headline,
            'cta', pa.cta, 'landing_url', pa.landing_url, 'is_active', pa.is_active,
            'started_at', coalesce(pa.platform_started_at, pa.first_seen_at),
            'ended_at', pa.platform_ended_at,
            'creative_url', pa.creative_stored_url) AS x
          FROM mkt_paid_ads pa WHERE pa.organization_id = p_org_id
          ORDER BY coalesce(pa.platform_started_at, pa.first_seen_at) DESC NULLS LAST
          LIMIT v_lim) z), '[]'::jsonb)),

    -- campaign_message / selling_point ARE the hooks — no separate hook type
    'facts', (
      SELECT jsonb_object_agg(ft, vals) FROM (
        SELECT ft, coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'value', t.sample_value, 'key', t.normalized_key,
            'observations', t.observations, 'posts', t.distinct_posts,
            'first_seen', t.first_seen, 'last_seen', t.last_seen,
            'share_pct', t.share_pct))
          FROM mkt_fact_top(ft, v_lim, p_from, p_to, p_org_id, NULL) t), '[]'::jsonb) AS vals
        FROM unnest(ARRAY['cta','offer','campaign_message','selling_point','content_type',
                          'price','phone','payment_plan','unit_type','district',
                          'delivery_date','financing','amenity','audience','objective']) ft) z),

    'trends', jsonb_build_object(
      'activity', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'bucket', t.bucket_start, 'posts', t.posts, 'ads', t.ads,
          'platforms', t.platforms, 'engagement', t.engagement) ORDER BY t.bucket_start)
        FROM mkt_activity_trend('month', p_from, p_to, p_org_id, NULL) t), '[]'::jsonb),
      'price', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'bucket', t.bucket_start, 'observations', t.observations,
          'min', t.min_value, 'max', t.max_value, 'avg', t.avg_value) ORDER BY t.bucket_start)
        FROM mkt_fact_trend('price','month', p_from, p_to, p_org_id, NULL) t
        WHERE t.numeric_count > 0), '[]'::jsonb),
      'platforms', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'platform', d.platform, 'posts', d.posts, 'share_pct', d.share_pct,
          'engagement', d.engagement))
        FROM mkt_platform_distribution(p_from, p_to, p_org_id, NULL) d), '[]'::jsonb)),

    'share_of_voice', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'period_start', s.period_start, 'period_end', s.period_end,
        'scope', s.scope_type, 'scope_key', s.scope_key,
        'post_count', s.post_count, 'ad_count', s.ad_count,
        'engagement_total', s.engagement_total, 'share_pct', s.share_pct)
        ORDER BY s.period_start DESC)
      FROM mkt_share_of_voice s WHERE s.organization_id = p_org_id), '[]'::jsonb),

    'campaigns', jsonb_build_object(
      'total', (SELECT count(*) FROM mkt_campaigns WHERE organization_id = p_org_id),
      'active', (SELECT count(*) FROM mkt_campaigns WHERE organization_id = p_org_id AND is_active),
      'shown', v_lim,
      'items', coalesce((
        SELECT jsonb_agg(x ORDER BY x->>'last_seen_at' DESC NULLS LAST) FROM (
          SELECT jsonb_build_object(
            'campaign_id', c.id, 'label', coalesce(c.manual_label, c.label),
            'objective', c.objective, 'platforms', to_jsonb(c.platforms),
            'is_active', c.is_active, 'member_count', c.member_count,
            'first_seen_at', c.first_seen_at, 'last_seen_at', c.last_seen_at,
            'summary', (SELECT jsonb_build_object('confidence', su.confidence,
                          'summary_ar', su.result->>'summary_ar',
                          'summary_en', su.result->>'summary_en')
                        FROM mkt_campaign_summaries su WHERE su.campaign_id = c.id)) AS x
          FROM mkt_campaigns c WHERE c.organization_id = p_org_id
          ORDER BY c.last_seen_at DESC NULLS LAST LIMIT v_lim) z), '[]'::jsonb)),

    'insights', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'severity', i.severity, 'title', i.title,
        'body', i.body, 'evidence', i.evidence, 'generated_at', i.generated_at)
        ORDER BY i.generated_at DESC)
      FROM mkt_insights i
      WHERE i.organization_id = p_org_id AND NOT coalesce(i.dismissed,false)), '[]'::jsonb),

    -- ── Coverage: what this page CANNOT answer yet, and why ────────────────
    -- Stated explicitly so an empty section is never mistaken for a zero.
    'coverage', jsonb_build_object(
      'has_content', (SELECT count(*) > 0 FROM mkt_content_posts WHERE organization_id = p_org_id),
      'has_facts',   (SELECT count(*) > 0 FROM mkt_observed_facts WHERE organization_id = p_org_id),
      'has_ads',     (SELECT count(*) > 0 FROM mkt_paid_ads WHERE organization_id = p_org_id),
      'content_processed_posts', (
        SELECT count(*) FROM mkt_content_posts
        WHERE organization_id = p_org_id AND processing_status IN ('processed','partial')),
      'content_unprocessed_posts', (
        SELECT count(*) FROM mkt_content_posts
        WHERE organization_id = p_org_id AND processing_status NOT IN ('processed','partial')),
      'note', 'Facts (offers, prices, CTAs, hooks) exist only for posts that have '
           || 'been through content processing. An empty facts section with a high '
           || 'content_unprocessed_posts count means the content was collected but '
           || 'not yet OCR''d/enriched — not that the advertiser says nothing.')
  ) INTO v_out;
  RETURN v_out;
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_organization_intelligence(uuid,date,date,integer) TO service_role, authenticated;
