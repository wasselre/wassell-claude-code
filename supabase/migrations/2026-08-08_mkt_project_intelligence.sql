-- ============================================================================
-- 2026-08-08 — Phase 3: Project Intelligence backend.
--
-- Part 1 fixes how facts are scoped to a project (a real under-reporting bug).
-- Part 2 adds the composite read that backs the Project Intelligence page.
-- Part 3 makes the rollup's fact_count agree with part 1.
--
-- No new tables. No parallel logic. Deterministic throughout — the only
-- AI-derived content is what already lives in mkt_insights /
-- mkt_campaign_summaries, surfaced as-is with its provenance.
-- ============================================================================

-- ── Part 1: one definition of "a fact belongs to this project" ──────────────
-- The Phase 2 primitives matched only mkt_observed_facts.project_id, which the
-- enrichment emitter sets from primary_project_id. OCR-derived facts carry NO
-- project_id, so "prices for project X" silently missed every price read off an
-- image.
--
-- Measured: direct project_id = 327 facts / 7 projects. Resolving through a
-- CONFIRMED attribution on the fact's post = 1 192 facts / 9 projects, with the
-- direct set a strict SUBSET. Project scoping was under-reporting 3.6x.
--
-- Fixed HERE rather than in a new Phase 3 resolver so there is exactly one
-- definition. Speculative marketer_assignment candidates stay excluded (docs §6a).
CREATE OR REPLACE FUNCTION public.mkt_fact_belongs_to_project(
  p_fact_project uuid, p_fact_post uuid, p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT p_project IS NULL
      OR p_fact_project = p_project
      OR EXISTS (SELECT 1 FROM mkt_content_attributions a
                 WHERE a.content_post_id = p_fact_post
                   AND a.project_id = p_project
                   AND a.review_status IN ('auto_accepted','confirmed'));
$fn$;

CREATE OR REPLACE FUNCTION public.mkt_fact_trend(
  p_fact_type text, p_bucket text DEFAULT 'month',
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_org uuid DEFAULT NULL, p_project uuid DEFAULT NULL,
  p_district text DEFAULT NULL, p_min_conf numeric DEFAULT 0.0)
RETURNS TABLE(bucket_start date, observations bigint, distinct_values bigint,
              numeric_count bigint, min_value numeric, max_value numeric,
              avg_value numeric, median_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH scoped AS (
    SELECT f.* FROM mkt_observed_facts f
    WHERE f.fact_type = p_fact_type
      AND f.observed_at IS NOT NULL
      AND f.confidence >= coalesce(p_min_conf, 0)
      AND (p_from IS NULL OR f.observed_at >= p_from)
      AND (p_to   IS NULL OR f.observed_at <  (p_to + 1))
      AND (p_org  IS NULL OR f.organization_id = p_org)
      AND mkt_fact_belongs_to_project(f.project_id, f.content_post_id, p_project)
      AND (p_district IS NULL OR EXISTS (
            SELECT 1 FROM mkt_observed_facts d
            WHERE d.content_post_id = f.content_post_id
              AND d.fact_type = 'district'
              AND d.normalized_key = mkt_fact_norm_key('district', p_district)))
  )
  SELECT date_trunc(coalesce(p_bucket,'month'), observed_at)::date,
         count(*), count(DISTINCT normalized_key), count(value_num),
         min(value_num), max(value_num), round(avg(value_num), 2),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY value_num)
  FROM scoped GROUP BY 1 ORDER BY 1;
$fn$;

CREATE OR REPLACE FUNCTION public.mkt_fact_top(
  p_fact_type text, p_limit integer DEFAULT 20,
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_org uuid DEFAULT NULL, p_project uuid DEFAULT NULL,
  p_min_conf numeric DEFAULT 0.0)
RETURNS TABLE(normalized_key text, sample_value text, observations bigint,
              distinct_posts bigint, distinct_orgs bigint,
              first_seen timestamptz, last_seen timestamptz, share_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH scoped AS (
    SELECT f.* FROM mkt_observed_facts f
    WHERE f.fact_type = p_fact_type
      AND f.confidence >= coalesce(p_min_conf, 0)
      AND (p_from IS NULL OR f.observed_at >= p_from)
      AND (p_to   IS NULL OR f.observed_at <  (p_to + 1))
      AND (p_org  IS NULL OR f.organization_id = p_org)
      AND mkt_fact_belongs_to_project(f.project_id, f.content_post_id, p_project)
  ), tot AS (SELECT count(*)::numeric AS n FROM scoped)
  SELECT s.normalized_key,
         (array_agg(s.value_text ORDER BY length(s.value_text) DESC))[1],
         count(*), count(DISTINCT s.content_post_id), count(DISTINCT s.organization_id),
         min(s.observed_at), max(s.observed_at),
         round(100 * count(*) / nullif((SELECT n FROM tot), 0), 2)
  FROM scoped s GROUP BY s.normalized_key
  ORDER BY 3 DESC, 7 DESC NULLS LAST
  LIMIT greatest(1, coalesce(p_limit, 20));
$fn$;

-- ── Part 2: the composite read ──────────────────────────────────────────────
-- ONE round trip against a consistent snapshot, rather than a dozen racing
-- queries. Composes the Phase 2 primitives.
--
-- EVERY list is capped AND the cap is REPORTED (`shown` next to `total`),
-- because a silently truncated list reads as "that is all there is".
--
-- CONFIRMED attributions only. The speculative candidates are surfaced in an
-- `attribution_quality` block so the operator SEES what is withheld and why,
-- instead of the page quietly overstating activity ~4x (docs §6a).
CREATE OR REPLACE FUNCTION public.mkt_project_intelligence(
  p_project_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_lim int := greatest(1, least(coalesce(p_limit,10), 50));
  v_from date := coalesce(p_from, '1900-01-01'::date);
  v_to   date := coalesce(p_to,   '2999-12-31'::date);
  v_out jsonb;
BEGIN
  SELECT jsonb_build_object(
    'generated_at', now(),
    'window', jsonb_build_object('from', p_from, 'to', p_to),

    'project', (
      SELECT jsonb_build_object(
        'id', r.id, 'name', r.data->>'project_name', 'city', r.data->>'city_name',
        'status', r.data->>'project_status', 'type', r.data->>'project_type',
        'page_url', r.data->>'project_page_url',
        'developer', (SELECT jsonb_build_object('record_id', d.id, 'name',
                        coalesce(d.data->>'developer_name', d.data->>'name'))
                      FROM unified_records d WHERE d.id = (r.data->>'developer')::uuid))
      FROM unified_records r WHERE r.id = p_project_id),

    -- role lives on the LINK, not on the org (an org is a developer on some
    -- projects and a marketer on others)
    'organizations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'organization_id', o.id, 'name', coalesce(o.name_en, o.name_ar),
        'role', po.relationship_type, 'confidence', po.confidence,
        'human_confirmed', po.human_confirmed,
        'first_observed_at', po.first_observed_at,
        'last_observed_at', po.last_observed_at, 'is_active', po.is_active)
        ORDER BY po.relationship_type, po.confidence DESC NULLS LAST)
      FROM mkt_project_organizations po
      JOIN mkt_organizations o ON o.id = po.organization_id
      WHERE po.project_id = p_project_id), '[]'::jsonb),

    'social_accounts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', sa.id, 'platform', sa.platform, 'handle', sa.handle,
        'profile_url', sa.profile_url, 'followers', sa.followers,
        'organization_id', sa.organization_id,
        'collection_enabled', sa.collection_enabled, 'last_synced_at', sa.last_synced_at)
        ORDER BY sa.platform, sa.handle)
      FROM mkt_social_accounts sa
      WHERE sa.organization_id IN (
        SELECT organization_id FROM mkt_project_organizations WHERE project_id = p_project_id)
      ), '[]'::jsonb),

    'content', jsonb_build_object(
      'total', (SELECT count(DISTINCT cp.id) FROM mkt_content_posts cp
                JOIN mkt_content_attributions a ON a.content_post_id = cp.id
                WHERE a.project_id = p_project_id
                  AND a.review_status IN ('auto_accepted','confirmed')
                  AND cp.published_at BETWEEN v_from AND v_to),
      'shown', v_lim,
      'recent', coalesce((
        SELECT jsonb_agg(x ORDER BY x->>'published_at' DESC) FROM (
          SELECT jsonb_build_object(
            'post_id', cp.id, 'platform', cp.platform, 'post_type', cp.post_type,
            'url', cp.post_url, 'published_at', cp.published_at,
            'caption_preview', left(coalesce(cp.caption,''), 240),
            'caption_full_length', length(coalesce(cp.caption,'')),
            'engagement', cp.engagement,
            'attribution_method', a.attribution_method,
            'attribution_confidence', a.confidence) AS x
          FROM mkt_content_posts cp
          JOIN mkt_content_attributions a ON a.content_post_id = cp.id
          WHERE a.project_id = p_project_id
            AND a.review_status IN ('auto_accepted','confirmed')
            AND cp.published_at BETWEEN v_from AND v_to
          ORDER BY cp.published_at DESC LIMIT v_lim) s), '[]'::jsonb)),

    'paid_ads', jsonb_build_object(
      'total', (SELECT count(*) FROM mkt_ad_attributions aa WHERE aa.project_id = p_project_id),
      'shown', v_lim,
      'recent', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'ad_id', pa.id, 'platform', pa.platform, 'headline', pa.headline,
          'cta', pa.cta, 'landing_url', pa.landing_url, 'is_active', pa.is_active,
          'started_at', coalesce(pa.platform_started_at, pa.first_seen_at),
          'ended_at', pa.platform_ended_at, 'creative_url', pa.creative_stored_url))
        FROM mkt_ad_attributions aa
        JOIN mkt_paid_ads pa ON pa.id = aa.paid_ad_id
        WHERE aa.project_id = p_project_id), '[]'::jsonb)),

    -- campaign_message / selling_point ARE the "hooks" — no separate hook type
    'facts', (
      SELECT jsonb_object_agg(ft, vals) FROM (
        SELECT ft, coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'value', t.sample_value, 'key', t.normalized_key,
            'observations', t.observations, 'posts', t.distinct_posts,
            'first_seen', t.first_seen, 'last_seen', t.last_seen,
            'share_pct', t.share_pct))
          FROM mkt_fact_top(ft, v_lim, p_from, p_to, NULL, p_project_id) t), '[]'::jsonb) AS vals
        FROM unnest(ARRAY['price','offer','cta','campaign_message','selling_point',
                          'phone','payment_plan','delivery_date','unit_type',
                          'district','financing','amenity','audience']) ft) z),

    'trends', jsonb_build_object(
      'activity', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'bucket', t.bucket_start, 'posts', t.posts, 'ads', t.ads,
          'platforms', t.platforms, 'engagement', t.engagement) ORDER BY t.bucket_start)
        FROM mkt_activity_trend('month', p_from, p_to, NULL, p_project_id) t), '[]'::jsonb),
      'price', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'bucket', t.bucket_start, 'observations', t.observations,
          'min', t.min_value, 'max', t.max_value, 'avg', t.avg_value) ORDER BY t.bucket_start)
        FROM mkt_fact_trend('price','month', p_from, p_to, NULL, p_project_id) t
        WHERE t.numeric_count > 0), '[]'::jsonb),
      'platforms', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'platform', d.platform, 'posts', d.posts, 'share_pct', d.share_pct,
          'engagement', d.engagement))
        FROM mkt_platform_distribution(p_from, p_to, NULL, p_project_id) d), '[]'::jsonb)),

    'share_of_voice', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'organization_id', s.organization_id, 'name', coalesce(o.name_en, o.name_ar),
        'period_start', s.period_start, 'period_end', s.period_end,
        'scope', s.scope_type, 'post_count', s.post_count, 'ad_count', s.ad_count,
        'share_pct', s.share_pct) ORDER BY s.period_start DESC, s.share_pct DESC)
      FROM mkt_share_of_voice s
      JOIN mkt_organizations o ON o.id = s.organization_id
      WHERE s.organization_id IN (
        SELECT organization_id FROM mkt_project_organizations WHERE project_id = p_project_id)
      ), '[]'::jsonb),

    'timeline', jsonb_build_object(
      'campaigns', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'campaign_id', c.id, 'label', coalesce(c.manual_label, c.label),
          'objective', c.objective, 'platforms', to_jsonb(c.platforms),
          'is_active', c.is_active, 'member_count', c.member_count,
          'first_seen_at', c.first_seen_at, 'last_seen_at', c.last_seen_at,
          'summary', (SELECT jsonb_build_object('confidence', su.confidence,
                        'summary_ar', su.result->>'summary_ar',
                        'summary_en', su.result->>'summary_en')
                      FROM mkt_campaign_summaries su WHERE su.campaign_id = c.id))
          ORDER BY c.last_seen_at DESC NULLS LAST)
        FROM mkt_campaigns c WHERE c.project_id = p_project_id), '[]'::jsonb),
      'org_first_seen', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'organization_id', po.organization_id, 'name', coalesce(o.name_en, o.name_ar),
          'role', po.relationship_type, 'first_observed_at', po.first_observed_at)
          ORDER BY po.first_observed_at)
        FROM mkt_project_organizations po
        JOIN mkt_organizations o ON o.id = po.organization_id
        WHERE po.project_id = p_project_id AND po.first_observed_at IS NOT NULL), '[]'::jsonb)),

    'state', (SELECT to_jsonb(s) FROM mkt_project_marketing_state s
              WHERE s.project_id = p_project_id),

    'insights', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'severity', i.severity, 'title', i.title,
        'body', i.body, 'evidence', i.evidence, 'generated_at', i.generated_at,
        'dismissed', i.dismissed) ORDER BY i.generated_at DESC)
      FROM mkt_insights i
      WHERE i.project_id = p_project_id AND NOT coalesce(i.dismissed,false)), '[]'::jsonb),

    'attribution_quality', (
      SELECT jsonb_build_object(
        'confirmed_posts', count(DISTINCT a.content_post_id)
                             FILTER (WHERE a.review_status IN ('auto_accepted','confirmed')),
        'speculative_posts', count(DISTINCT a.content_post_id)
                             FILTER (WHERE a.review_status NOT IN ('auto_accepted','confirmed')),
        'note', 'Everything above counts CONFIRMED attributions only. Speculative '
              || 'marketer_assignment candidates (confidence 0.40) are excluded; they '
              || 'would overstate project activity roughly 4x. See docs section 6a.')
      FROM mkt_content_attributions a WHERE a.project_id = p_project_id)
  ) INTO v_out;
  RETURN v_out;
END $fn$;

-- ── Part 3: keep the rollup's fact_count consistent with Part 1 ─────────────
-- Both appear in the same page payload; two different scopings would visibly
-- contradict each other.
CREATE OR REPLACE FUNCTION public.mkt_recompute_project_marketing_state()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n integer;
BEGIN
  WITH strong AS (
    SELECT a.project_id, count(DISTINCT cp.id) AS post_count,
           count(DISTINCT cp.platform) AS platform_count,
           array_agg(DISTINCT cp.platform) AS platforms,
           count(DISTINCT cp.organization_id) AS org_count,
           min(cp.published_at) AS first_at, max(cp.published_at) AS last_at
    FROM mkt_content_attributions a
    JOIN mkt_content_posts cp ON cp.id = a.content_post_id
    WHERE a.review_status IN ('auto_accepted','confirmed')
    GROUP BY a.project_id
  ),
  weak AS (
    SELECT a.project_id, count(DISTINCT a.content_post_id) AS candidate_post_count
    FROM mkt_content_attributions a
    WHERE a.review_status NOT IN ('auto_accepted','confirmed') GROUP BY a.project_id
  ),
  camps AS (
    SELECT project_id, count(*) AS campaign_count,
           count(*) FILTER (WHERE is_active) AS active_campaign_count
    FROM mkt_campaigns WHERE project_id IS NOT NULL GROUP BY project_id
  ),
  facts AS (   -- resolved the SAME way the intelligence page resolves them
    SELECT a.project_id, count(DISTINCT f.id) AS fact_count,
           min(f.value_num) FILTER (WHERE f.fact_type='price') AS min_price,
           max(f.value_num) FILTER (WHERE f.fact_type='price') AS max_price
    FROM mkt_observed_facts f
    JOIN mkt_content_attributions a ON a.content_post_id = f.content_post_id
    WHERE a.review_status IN ('auto_accepted','confirmed')
    GROUP BY a.project_id
  ),
  keys AS (
    SELECT project_id FROM strong UNION SELECT project_id FROM weak
    UNION SELECT project_id FROM camps UNION SELECT project_id FROM facts
  ),
  merged AS (
    SELECT k.project_id,
           coalesce(s.post_count, 0) AS post_count,
           coalesce(w.candidate_post_count, 0) AS candidate_post_count,
           coalesce(s.platform_count, 0) AS platform_count,
           coalesce(s.platforms, '{}') AS platforms,
           coalesce(s.org_count, 0) AS org_count,
           coalesce(c.campaign_count, 0) AS campaign_count,
           coalesce(c.active_campaign_count, 0) AS active_campaign_count,
           coalesce(f.fact_count, 0) AS fact_count,
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
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_fact_belongs_to_project(uuid,uuid,uuid)        TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_project_intelligence(uuid,date,date,integer)   TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_recompute_project_marketing_state()            TO service_role, authenticated;
