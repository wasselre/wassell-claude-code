-- ============================================================================
-- Companies surface: who each competitor is, and what they actually market
-- ----------------------------------------------------------------------------
-- The roster answered "how much have we collected" (accounts, posts, facts,
-- last pull). The operator asked for the marketing read instead: the company,
-- whether it develops or markets, and then what it publishes — how often, in
-- which format, for what purpose, about which projects and districts, whether
-- it runs offers, and how its posts perform.
--
-- Everything here already exists in the pipeline's output; it was only never
-- gathered per company:
--   mkt_content_posts.post_type        → format mix (image / video / reel / carousel)
--   mkt_content_enrichment.result      → purpose (the 7 content types), offer, district
--   mkt_content_enrichment.primary_project_id → which projects they push
--   mkt_content_posts.engagement       → likes / views actually recorded per post
--   mkt_content_posts.published_at     → cadence and last POST (not last pull:
--                                        the old "last activity" column showed when
--                                        WE scraped, which says nothing about them)
--
-- Shape is additive: every field the previous version returned is still there
-- under the same name, so the surface can be replaced without a flag day.
-- ============================================================================

-- District strings arrive both as «النرجس» and «حي النرجس». Folding the prefix
-- keeps one district as one row instead of two competing ones (Riva: 94 + 36
-- became 130).
CREATE OR REPLACE FUNCTION public.mkt_district_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(regexp_replace(btrim(coalesce(p, '')), '^(حي|حى)\s+', '')), '');
$$;

CREATE OR REPLACE FUNCTION public.mkt_company_roster()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
WITH post AS (
  SELECT p.id, p.organization_id AS org, p.social_account_id, p.platform, p.post_type, p.published_at,
         e.result, e.primary_project_id,
         COALESCE((p.engagement->>'likes')::numeric, 0)                                        AS likes,
         COALESCE((p.engagement->>'views')::numeric, (p.engagement->>'play_count')::numeric, 0) AS views
    FROM mkt_content_posts p
    LEFT JOIN mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
),
acct_posts AS (
  SELECT social_account_id, count(*) AS posts, max(published_at) AS last_post
    FROM mkt_content_posts GROUP BY social_account_id
),
agg AS (
  SELECT org,
         count(*)                                                              AS posts,
         count(*) FILTER (WHERE published_at > now() - interval '90 days')      AS posts_90d,
         count(*) FILTER (WHERE published_at > now() - interval '30 days')      AS posts_30d,
         max(published_at)                                                      AS last_post,
         count(*) FILTER (WHERE post_type = 'image')                            AS fmt_image,
         count(*) FILTER (WHERE post_type = 'carousel')                         AS fmt_carousel,
         count(*) FILTER (WHERE post_type IN ('video', 'reel', 'short'))        AS fmt_video,
         count(*) FILTER (WHERE result->>'content_type' = 'brand')              AS pur_brand,
         count(*) FILTER (WHERE result->>'content_type' = 'project_launch')     AS pur_launch,
         count(*) FILTER (WHERE result->>'content_type' = 'offer')              AS pur_offer,
         count(*) FILTER (WHERE result->>'content_type' = 'teaser')             AS pur_teaser,
         count(*) FILTER (WHERE result->>'content_type' = 'walkthrough')        AS pur_walkthrough,
         count(*) FILTER (WHERE result->>'content_type' = 'event')              AS pur_event,
         count(*) FILTER (WHERE result->>'content_type' = 'testimonial')        AS pur_testimonial,
         count(*) FILTER (WHERE nullif(result->>'offer', '') IS NOT NULL
                            AND result->>'offer' <> 'null')                     AS offer_posts,
         -- averages over posts that actually carry a number, so one un-metered
         -- platform cannot drag a company's figure to zero
         round(avg(likes) FILTER (WHERE likes > 0))::int                        AS avg_likes,
         round(avg(views) FILTER (WHERE views > 0))::int                        AS avg_views
    FROM post GROUP BY org
),
proj AS (
  SELECT org, jsonb_agg(jsonb_build_object('name', name, 'posts', n) ORDER BY n DESC) AS top_projects
    FROM (
      SELECT p.org, COALESCE(r.data->>'project_name', '—') AS name, count(*) AS n,
             row_number() OVER (PARTITION BY p.org ORDER BY count(*) DESC) AS rn
        FROM post p JOIN records r ON r.id = p.primary_project_id
       WHERE p.primary_project_id IS NOT NULL
       GROUP BY p.org, 2
    ) t WHERE rn <= 4 GROUP BY org
),
dist AS (
  SELECT org, jsonb_agg(jsonb_build_object('name', name, 'posts', n) ORDER BY n DESC) AS top_districts
    FROM (
      SELECT p.org, mkt_district_norm(p.result->>'district') AS name, count(*) AS n,
             row_number() OVER (PARTITION BY p.org ORDER BY count(*) DESC) AS rn
        FROM post p
       WHERE mkt_district_norm(p.result->>'district') IS NOT NULL
       GROUP BY p.org, 2
    ) t WHERE rn <= 4 GROUP BY org
),
latest_offer AS (
  SELECT DISTINCT ON (org) org, btrim(result->>'offer') AS offer_text, published_at AS offer_at
    FROM post
   WHERE nullif(btrim(result->>'offer'), '') IS NOT NULL AND result->>'offer' <> 'null'
   ORDER BY org, published_at DESC NULLS LAST
)
SELECT jsonb_build_object(
  'companies', COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.posts_90d DESC, row.posts DESC NULLS LAST), '[]'::jsonb)
) FROM (
  SELECT
    o.id, o.name_ar AS name, o.name_en, o.org_type, o.website,
    (SELECT count(*) FROM mkt_observed_facts f WHERE f.organization_id = o.id) AS facts,
    (SELECT count(*) FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active) AS accounts,
    COALESCE(a.posts, 0) AS posts,
    COALESCE(a.posts_90d, 0) AS posts_90d,
    COALESCE(a.posts_30d, 0) AS posts_30d,
    a.last_post,
    (SELECT COALESCE(sum(sa.followers), 0) FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active) AS followers,
    (SELECT max(sa.last_incremental_at) FROM mkt_social_accounts sa WHERE sa.organization_id = o.id) AS last_pull,
    -- posts per week over the window we can see, NULL when there is nothing recent
    CASE WHEN COALESCE(a.posts_90d, 0) > 0 THEN round(a.posts_90d / 12.85, 1) END AS posts_per_week,
    jsonb_build_object('image', COALESCE(a.fmt_image, 0), 'carousel', COALESCE(a.fmt_carousel, 0), 'video', COALESCE(a.fmt_video, 0)) AS formats,
    jsonb_build_object(
      'brand', COALESCE(a.pur_brand, 0), 'project_launch', COALESCE(a.pur_launch, 0), 'offer', COALESCE(a.pur_offer, 0),
      'teaser', COALESCE(a.pur_teaser, 0), 'walkthrough', COALESCE(a.pur_walkthrough, 0),
      'event', COALESCE(a.pur_event, 0), 'testimonial', COALESCE(a.pur_testimonial, 0)) AS purposes,
    COALESCE(a.offer_posts, 0) AS offer_posts,
    lo.offer_text, lo.offer_at,
    a.avg_likes, a.avg_views,
    COALESCE(pr.top_projects, '[]'::jsonb) AS top_projects,
    COALESCE(di.top_districts, '[]'::jsonb) AS top_districts,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'platform', sa.platform, 'handle', sa.handle, 'followers', sa.followers,
         'enabled', sa.collection_enabled, 'last_pull', sa.last_incremental_at,
         'cadence', sa.cadence->>'incremental',
         'posts', (SELECT ap.posts FROM acct_posts ap WHERE ap.social_account_id = sa.id),
         'last_post', (SELECT ap.last_post FROM acct_posts ap WHERE ap.social_account_id = sa.id)
       ) ORDER BY sa.platform), '[]'::jsonb)
       FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active) AS account_list
  FROM mkt_organizations o
  LEFT JOIN agg a ON a.org = o.id
  LEFT JOIN proj pr ON pr.org = o.id
  LEFT JOIN dist di ON di.org = o.id
  LEFT JOIN latest_offer lo ON lo.org = o.id
  WHERE EXISTS (SELECT 1 FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active)
) row;
$function$;

REVOKE ALL ON FUNCTION public.mkt_company_roster() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_company_roster() TO service_role;
