-- ============================================================================
-- 2026-08-07 — Phase 2: reusable deterministic analytics layer.
-- ZERO AI in any number (same rule as the market-intelligence benchmark layer).
--
-- FIVE composable primitives, not sixteen bespoke queries. Every question in the
-- brief maps onto one of them:
--
--   price trends by developer/district ....... mkt_fact_trend('price', org/district)
--   offer trends over time ................... mkt_fact_trend('offer')
--   delivery date / financing trends ......... mkt_fact_trend('delivery_date'|'financing')
--   most common CTAs / hooks / phones ........ mkt_fact_top('cta'|'campaign_message'|'phone')
--   payment plans / unit type distribution ... mkt_fact_top('payment_plan'|'unit_type')
--   developer / marketer positioning ......... mkt_fact_top('selling_point'|'audience', org)
--   posting activity / market over time ...... mkt_activity_trend()
--   platform distribution .................... mkt_platform_distribution()
--   share of voice ........................... mkt_compute_share_of_voice()
--
-- ON "hooks": there is no `hook` fact_type and one is not needed. A hook is the
-- opening claim of a piece of content, which the enrichment Skill already
-- captures as `campaign_message` (one line) and `selling_point` (array). Both
-- are queryable via mkt_fact_top; adding a `hook` type would duplicate them.
--
-- All are STABLE + SECURITY DEFINER and read-only, except
-- mkt_compute_share_of_voice which fills its own table.
-- Verified live: see docs/marketing-intelligence-schema.md §8.
-- ============================================================================

-- ── 1. Fact trend over time (the workhorse) ─────────────────────────────────
-- Buckets facts by day/week/month/quarter with count + numeric aggregates. Every
-- filter is optional (NULL = no filter), so ONE function serves "price by
-- developer", "price by district", "offers market-wide", and so on.
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
      AND (p_from    IS NULL OR f.observed_at >= p_from)
      AND (p_to      IS NULL OR f.observed_at <  (p_to + 1))
      AND (p_org     IS NULL OR f.organization_id = p_org)
      AND (p_project IS NULL OR f.project_id      = p_project)
      -- district scoping: the post must ALSO carry a matching district fact
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

-- ── 2. Top values for a fact type (rankings) ────────────────────────────────
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
      AND (p_from    IS NULL OR f.observed_at >= p_from)
      AND (p_to      IS NULL OR f.observed_at <  (p_to + 1))
      AND (p_org     IS NULL OR f.organization_id = p_org)
      AND (p_project IS NULL OR f.project_id      = p_project)
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

-- ── 3. Posting / advertising activity over time ─────────────────────────────
-- When p_project is given this counts CONFIRMED activity only: speculative
-- marketer_assignment candidates (83% of attributions, confidence 0.40) would
-- otherwise inflate every project roughly 4x. See docs §6a.
CREATE OR REPLACE FUNCTION public.mkt_activity_trend(
  p_bucket text DEFAULT 'month', p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_org uuid DEFAULT NULL, p_project uuid DEFAULT NULL)
RETURNS TABLE(bucket_start date, posts bigint, ads bigint, platforms bigint,
              organizations bigint, engagement bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH posts AS (
    SELECT date_trunc(coalesce(p_bucket,'month'), cp.published_at)::date AS b,
           cp.id, cp.platform, cp.organization_id,
           coalesce((cp.engagement->>'likes')::bigint,0)
         + coalesce((cp.engagement->>'comments')::bigint,0)
         + coalesce((cp.engagement->>'shares')::bigint,0)
         + coalesce((cp.engagement->>'views')::bigint,0) AS eng
    FROM mkt_content_posts cp
    WHERE cp.published_at IS NOT NULL
      AND (p_from IS NULL OR cp.published_at >= p_from)
      AND (p_to   IS NULL OR cp.published_at <  (p_to + 1))
      AND (p_org  IS NULL OR cp.organization_id = p_org)
      AND (p_project IS NULL OR EXISTS (
            SELECT 1 FROM mkt_content_attributions a
            WHERE a.content_post_id = cp.id AND a.project_id = p_project
              AND a.review_status IN ('auto_accepted','confirmed')))
  ),
  ads AS (
    SELECT date_trunc(coalesce(p_bucket,'month'),
                      coalesce(pa.platform_started_at, pa.first_seen_at))::date AS b, pa.id
    FROM mkt_paid_ads pa
    WHERE coalesce(pa.platform_started_at, pa.first_seen_at) IS NOT NULL
      AND (p_from IS NULL OR coalesce(pa.platform_started_at, pa.first_seen_at) >= p_from)
      AND (p_to   IS NULL OR coalesce(pa.platform_started_at, pa.first_seen_at) < (p_to + 1))
      AND (p_org  IS NULL OR pa.organization_id = p_org)
      AND p_project IS NULL   -- ads carry no project attribution yet
  ),
  buckets AS (SELECT b FROM posts UNION SELECT b FROM ads)
  SELECT k.b,
         coalesce((SELECT count(DISTINCT p.id) FROM posts p WHERE p.b = k.b), 0),
         coalesce((SELECT count(DISTINCT a.id) FROM ads   a WHERE a.b = k.b), 0),
         coalesce((SELECT count(DISTINCT p.platform) FROM posts p WHERE p.b = k.b), 0),
         coalesce((SELECT count(DISTINCT p.organization_id) FROM posts p WHERE p.b = k.b), 0),
         coalesce((SELECT sum(p.eng) FROM posts p WHERE p.b = k.b), 0)
  FROM buckets k ORDER BY 1;
$fn$;

-- ── 4. Platform distribution ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_platform_distribution(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_org uuid DEFAULT NULL, p_project uuid DEFAULT NULL)
RETURNS TABLE(platform text, posts bigint, share_pct numeric,
              engagement bigint, first_post timestamptz, last_post timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH scoped AS (
    SELECT cp.* FROM mkt_content_posts cp
    WHERE (p_from IS NULL OR cp.published_at >= p_from)
      AND (p_to   IS NULL OR cp.published_at <  (p_to + 1))
      AND (p_org  IS NULL OR cp.organization_id = p_org)
      AND (p_project IS NULL OR EXISTS (
            SELECT 1 FROM mkt_content_attributions a
            WHERE a.content_post_id = cp.id AND a.project_id = p_project
              AND a.review_status IN ('auto_accepted','confirmed')))
  ), tot AS (SELECT count(*)::numeric n FROM scoped)
  SELECT s.platform, count(*),
         round(100 * count(*) / nullif((SELECT n FROM tot),0), 2),
         sum(coalesce((s.engagement->>'likes')::bigint,0)
           + coalesce((s.engagement->>'comments')::bigint,0)
           + coalesce((s.engagement->>'shares')::bigint,0)
           + coalesce((s.engagement->>'views')::bigint,0)),
         min(s.published_at), max(s.published_at)
  FROM scoped s GROUP BY s.platform ORDER BY 2 DESC;
$fn$;

-- ── 5. Share of voice (fills mkt_share_of_voice) ────────────────────────────
-- share_pct is each org's portion of total posts+ads in the period and scope.
-- NOTE: the CTE total is aliased total_n, not n — `n` collided with the plpgsql
-- ROW_COUNT variable and Postgres rejected the ambiguous reference.
CREATE OR REPLACE FUNCTION public.mkt_compute_share_of_voice(
  p_from date, p_to date, p_scope_type text DEFAULT 'market', p_scope_key text DEFAULT '')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_rows integer;
BEGIN
  WITH posts AS (
    SELECT cp.organization_id, cp.id,
           coalesce((cp.engagement->>'likes')::bigint,0)
         + coalesce((cp.engagement->>'comments')::bigint,0)
         + coalesce((cp.engagement->>'shares')::bigint,0)
         + coalesce((cp.engagement->>'views')::bigint,0) AS eng
    FROM mkt_content_posts cp
    WHERE cp.published_at >= p_from AND cp.published_at < (p_to + 1)
      AND cp.organization_id IS NOT NULL
      AND (p_scope_type = 'market' OR EXISTS (
            SELECT 1 FROM mkt_observed_facts f
            WHERE f.content_post_id = cp.id
              AND f.fact_type = CASE p_scope_type WHEN 'district' THEN 'district' ELSE 'city' END
              AND f.normalized_key = mkt_fact_norm_key(
                    CASE p_scope_type WHEN 'district' THEN 'district' ELSE 'city' END, p_scope_key)))
  ),
  ads AS (
    SELECT pa.organization_id, pa.id FROM mkt_paid_ads pa
    WHERE coalesce(pa.platform_started_at, pa.first_seen_at) >= p_from
      AND coalesce(pa.platform_started_at, pa.first_seen_at) < (p_to + 1)
      AND pa.organization_id IS NOT NULL AND p_scope_type = 'market'
  ),
  agg AS (
    SELECT o.id AS organization_id, coalesce(pc.c, 0) AS post_count,
           coalesce(ac.c, 0) AS ad_count, coalesce(pc.e, 0) AS engagement_total
    FROM mkt_organizations o
    LEFT JOIN (SELECT organization_id, count(*) c, sum(eng) e FROM posts GROUP BY 1) pc
           ON pc.organization_id = o.id
    LEFT JOIN (SELECT organization_id, count(*) c FROM ads GROUP BY 1) ac
           ON ac.organization_id = o.id
    WHERE coalesce(pc.c,0) + coalesce(ac.c,0) > 0
  ),
  tot AS (SELECT sum(post_count + ad_count)::numeric AS total_n FROM agg)
  INSERT INTO mkt_share_of_voice
    (period_start, period_end, scope_type, scope_key, organization_id,
     post_count, ad_count, engagement_total, share_pct, computed_at)
  SELECT p_from, p_to, p_scope_type, coalesce(p_scope_key,''), organization_id,
         post_count, ad_count, engagement_total,
         round(100 * (post_count + ad_count) / nullif((SELECT total_n FROM tot),0), 2), now()
  FROM agg
  ON CONFLICT (period_start, period_end, scope_type, scope_key, organization_id)
  DO UPDATE SET post_count=EXCLUDED.post_count, ad_count=EXCLUDED.ad_count,
                engagement_total=EXCLUDED.engagement_total,
                share_pct=EXCLUDED.share_pct, computed_at=now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_fact_trend(text,text,date,date,uuid,uuid,text,numeric) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_fact_top(text,integer,date,date,uuid,uuid,numeric)     TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_activity_trend(text,date,date,uuid,uuid)               TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_platform_distribution(date,date,uuid,uuid)             TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_compute_share_of_voice(date,date,text,text)            TO service_role, authenticated;
