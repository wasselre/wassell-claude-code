-- Competitor Watch: interactions on every post + one page per company.
--
-- The numbers were collected all along and never shown: `engagement` on each
-- post (views / likes / comments / shares / saves — likes on 5,127 of 5,949
-- posts, views on 2,624; Instagram photos have no views) and 28,198 readings
-- over time in mkt_metric_snapshots, including the 7- and 30-day re-reads.
--
--   mkt_content_library  + p_sort ('recent' | 'views' | 'likes' | 'vs_usual')
--                        + per post: the numbers, the 7- and 30-day readings,
--                          and "× usual" — the post against its OWN account's
--                          median of the last 12 months, so a small account's
--                          hit is not buried under a big account's average post.
--   mkt_company_profile  everything for one company page.
--
-- The 7- / 30-day reading is the snapshot nearest the mark inside a window
-- (5-12 days, 25-45 days after publishing): the new re-reads land on the mark,
-- the older 14-day refreshes still give a usable reading near it.

BEGIN;

-- ── shared pieces ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_post_age_reading(p_post uuid, p_published timestamptz, p_days int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT s.metrics || jsonb_build_object('captured_at', s.captured_at)
    FROM public.mkt_metric_snapshots s
   WHERE s.subject_type = 'post' AND s.subject_id = p_post AND p_published IS NOT NULL
     AND s.captured_at BETWEEN p_published + make_interval(days => CASE WHEN p_days <= 7 THEN 5 ELSE 25 END)
                           AND p_published + make_interval(days => CASE WHEN p_days <= 7 THEN 12 ELSE 45 END)
   ORDER BY abs(extract(epoch FROM (s.captured_at - (p_published + make_interval(days => p_days)))))
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.mkt_post_age_reading(uuid, timestamptz, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_post_age_reading(uuid, timestamptz, int) TO authenticated, service_role;

-- Each account's typical post over the last 12 months (medians, zeros ignored).
-- A median needs at least 10 posts carrying that number — below that the
-- "typical" figure is noise (an account with views on 1 of 120 posts).
CREATE OR REPLACE VIEW public.mkt_account_baseline_v WITH (security_invoker = true) AS
WITH x AS (
  SELECT p.social_account_id,
         public.try_numeric(p.engagement->>'views') AS v,
         public.try_numeric(p.engagement->>'likes') AS l
    FROM public.mkt_content_posts p
   WHERE p.social_account_id IS NOT NULL AND p.published_at > now() - interval '365 days'
)
SELECT social_account_id,
       CASE WHEN count(*) FILTER (WHERE v > 0) >= 10
            THEN (percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FILTER (WHERE v > 0))::numeric END AS median_views,
       CASE WHEN count(*) FILTER (WHERE l > 0) >= 10
            THEN (percentile_cont(0.5) WITHIN GROUP (ORDER BY l) FILTER (WHERE l > 0))::numeric END AS median_likes,
       count(*) AS posts_12m
  FROM x GROUP BY social_account_id;
REVOKE ALL ON public.mkt_account_baseline_v FROM anon;
DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'mkt_account_baseline_v';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST mkt_account_baseline_v — options are %', v_opts;
  END IF;
END $assert$;

-- ── the library, with performance ───────────────────────────────────────────
DROP FUNCTION IF EXISTS public.mkt_content_library(text, uuid, text, text, boolean, text, integer, integer);
CREATE FUNCTION public.mkt_content_library(
  p_shelf text DEFAULT NULL, p_org uuid DEFAULT NULL, p_format text DEFAULT NULL, p_platform text DEFAULT NULL,
  p_has_offer boolean DEFAULT NULL, p_q text DEFAULT NULL, p_limit integer DEFAULT 40, p_offset integer DEFAULT 0,
  p_sort text DEFAULT 'recent')
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH baseline AS MATERIALIZED (
  -- Computed ONCE. A plain join to the view let the planner re-run its median
  -- aggregate for every post: 3,838 posts took over 120 s on 2026-10-04.
  SELECT * FROM public.mkt_account_baseline_v
),
base AS (
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id, p.social_account_id,
    o.name_ar                                   AS org_name,
    o.developer_record_id                       AS developer_record_id,
    e.primary_project_id,
    e.attribution_locked_at,
    e.candidate_projects,
    e.result                                    AS r,
    (e.result->>'content_type')                 AS content_type
  FROM public.mkt_content_posts p
  JOIN public.mkt_organizations o        ON o.id = p.organization_id
  JOIN public.mkt_content_enrichment e   ON e.content_post_id = p.id AND e.status = 'done'
),
filt AS (
  SELECT * FROM base
  WHERE (p_org      IS NULL OR organization_id = p_org)
    AND (p_format   IS NULL OR post_type = p_format)
    AND (p_platform IS NULL OR platform = p_platform)
    AND (p_has_offer IS NULL OR (p_has_offer = ((COALESCE(r->>'offer','') <> '') OR content_type = 'offer')))
    AND (p_q IS NULL OR p_q = '' OR (
          caption               ILIKE '%'||p_q||'%'
       OR (r->>'campaign_message') ILIKE '%'||p_q||'%'
       OR (r->>'objective')        ILIKE '%'||p_q||'%'
    ))
),
shelved AS (
  SELECT f.*,
         public.try_numeric(f.engagement->>'views') AS v_views,
         public.try_numeric(f.engagement->>'likes') AS v_likes,
         b.median_views, b.median_likes,
         CASE WHEN public.try_numeric(f.engagement->>'views') > 0 AND b.median_views >= 50
                THEN public.try_numeric(f.engagement->>'views') / b.median_views
              WHEN public.try_numeric(f.engagement->>'likes') > 0 AND b.median_likes >= 5
                THEN public.try_numeric(f.engagement->>'likes') / b.median_likes END AS vs_usual
    FROM filt f
    LEFT JOIN baseline b ON b.social_account_id = f.social_account_id
   WHERE (p_shelf IS NULL OR f.content_type = p_shelf)
),
page AS (
  SELECT jsonb_agg(to_jsonb(x)) AS rows FROM (
    SELECT
      s.id, s.org_name, s.organization_id, s.developer_record_id, s.platform,
      s.primary_project_id::text                      AS project_record_id,
      (s.attribution_locked_at IS NOT NULL)           AS attribution_locked,
      (SELECT c->>'strength' FROM jsonb_array_elements(s.candidate_projects) c
        WHERE c->>'projectId' = s.primary_project_id::text LIMIT 1) AS attribution_strength,
      COALESCE(s.r->'mentioned_projects', '[]'::jsonb) AS unknown_projects,
      COALESCE((s.r->>'is_general_branding')::boolean, false) AS is_general_branding,
      (SELECT count(*) FROM public.mkt_content_media m WHERE m.content_post_id = s.id AND m.file_id IS NOT NULL) AS files_registered,
      s.post_type                                     AS format,
      s.content_type                                  AS shelf,
      COALESCE(NULLIF(s.r->>'campaign_message',''), LEFT(s.caption, 180)) AS summary,
      LEFT(s.caption, 500)                            AS caption,
      (s.r->'selling_points')                         AS selling_points,
      (s.r->'unit_types')                             AS unit_types,
      (s.r->'amenities')                              AS amenities,
      (s.r->'ctas')                                   AS ctas,
      NULLIF(s.r->>'offer','')                        AS offer,
      NULLIF(s.r->>'price','')                        AS price,
      NULLIF(s.r->>'payment_plan','')                 AS payment_plan,
      NULLIF(s.r->>'district','')                     AS district,
      s.engagement, s.published_at, s.post_url,
      (s.duration_ms IS NOT NULL AND s.duration_ms > 0) AS is_video,
      EXISTS (SELECT 1 FROM public.mkt_transcripts t
               WHERE t.content_post_id = s.id AND t.status = 'done') AS has_transcript,
      (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name', ur.data->>'title')
         FROM public.unified_records ur
        WHERE ur.id = s.primary_project_id)          AS project_name,
      (SELECT m.stored_url FROM public.mkt_content_media m
         WHERE m.content_post_id = s.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
         ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
         LIMIT 1)                                     AS thumb_url,
      (SELECT jsonb_agg(jsonb_build_object('kind', m.media_kind, 'url', m.stored_url) ORDER BY m.created_at)
         FROM public.mkt_content_media m
        WHERE m.content_post_id = s.id AND m.download_status = 'stored'
          AND m.stored_url IS NOT NULL
          AND m.media_kind IN ('image', 'video')) AS media,
      -- performance (2026-10-04)
      s.v_views AS views, s.v_likes AS likes,
      public.try_numeric(s.engagement->>'comments') AS comments,
      public.try_numeric(s.engagement->>'shares')   AS shares,
      public.try_numeric(s.engagement->>'saves')    AS saves,
      public.mkt_post_age_reading(s.id, s.published_at, 7)  AS at_7d,
      public.mkt_post_age_reading(s.id, s.published_at, 30) AS at_30d,
      round(s.median_views) AS usual_views, round(s.median_likes) AS usual_likes,
      round(s.vs_usual, 1)  AS vs_usual,
      -- A guess, labelled as one in the UI: views far above the account's usual
      -- with almost no likes is the shape of a paid ad (measured: YouTube videos
      -- at 1.6-5.8 M views with 1-24 likes on channels that usually get 119-509).
      (s.v_views >= 20 * s.median_views AND s.median_views >= 50
        AND COALESCE(s.v_likes, 0) < 0.002 * s.v_views)  AS likely_paid,
      (SELECT sa.handle FROM public.mkt_social_accounts sa WHERE sa.id = s.social_account_id) AS account_handle
    FROM shelved s
    ORDER BY
      CASE WHEN p_sort = 'views'    THEN s.v_views  END DESC NULLS LAST,
      CASE WHEN p_sort = 'likes'    THEN s.v_likes  END DESC NULLS LAST,
      CASE WHEN p_sort = 'vs_usual' THEN s.vs_usual END DESC NULLS LAST,
      s.published_at DESC NULLS LAST, s.id
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  ) x
),
shelves AS (
  SELECT jsonb_object_agg(content_type, c) AS obj FROM (
    SELECT COALESCE(content_type, 'unknown') AS content_type, count(*) AS c
    FROM filt GROUP BY 1
  ) f
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM shelved),
  'shelves', COALESCE((SELECT obj FROM shelves), '{}'::jsonb),
  'rows',    COALESCE((SELECT rows FROM page), '[]'::jsonb)
);
$function$;
-- Same grants the previous version had (captured 2026-10-04).
REVOKE ALL ON FUNCTION public.mkt_content_library(text, uuid, text, text, boolean, text, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_content_library(text, uuid, text, text, boolean, text, integer, integer, text) TO authenticated, service_role;

-- ── one company, everything ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_company_profile(p_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
WITH org AS (
  SELECT o.* FROM public.mkt_organizations o WHERE o.id = p_org
),
baseline AS MATERIALIZED (SELECT * FROM public.mkt_account_baseline_v),
posts AS (
  SELECT p.id, p.platform, p.post_type, p.published_at, p.social_account_id, p.post_url, p.caption,
         public.try_numeric(p.engagement->>'views') AS views,
         public.try_numeric(p.engagement->>'likes') AS likes,
         public.try_numeric(p.engagement->>'comments') AS comments,
         e.primary_project_id, e.result AS r, (e.result->>'content_type') AS content_type
    FROM public.mkt_content_posts p
    LEFT JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.organization_id = p_org
),
recent AS (SELECT * FROM posts WHERE published_at > now() - interval '365 days'),
accounts AS (
  SELECT jsonb_agg(jsonb_build_object(
           'id', sa.id, 'platform', sa.platform, 'handle', sa.handle, 'display_name', sa.display_name,
           'profile_url', sa.profile_url, 'followers', COALESCE(am.followers, sa.followers),
           'followers_30d_ago', am30.followers,
           'collection_enabled', sa.collection_enabled, 'cadence', sa.cadence,
           'history_done_at', sa.history_done_at, 'last_synced_at', sa.last_synced_at,
           'posts_total', (SELECT count(*) FROM posts p WHERE p.social_account_id = sa.id),
           'posts_90d', (SELECT count(*) FROM posts p WHERE p.social_account_id = sa.id AND p.published_at > now() - interval '90 days'),
           'last_post_at', (SELECT max(p.published_at) FROM posts p WHERE p.social_account_id = sa.id),
           'usual_views', round(b.median_views), 'usual_likes', round(b.median_likes)
         ) ORDER BY COALESCE(am.followers, sa.followers) DESC NULLS LAST) AS j
    FROM public.mkt_social_accounts sa
    LEFT JOIN LATERAL (SELECT m.followers FROM public.mkt_account_metrics m WHERE m.social_account_id = sa.id ORDER BY m.captured_at DESC LIMIT 1) am ON true
    LEFT JOIN LATERAL (SELECT m.followers FROM public.mkt_account_metrics m WHERE m.social_account_id = sa.id AND m.captured_at <= now() - interval '30 days' ORDER BY m.captured_at DESC LIMIT 1) am30 ON true
    LEFT JOIN baseline b ON b.social_account_id = sa.id
   WHERE sa.organization_id = p_org
),
weeks AS (
  SELECT jsonb_agg(jsonb_build_object('week', w.wk, 'posts', COALESCE(c.n, 0)) ORDER BY w.wk) AS j
    FROM (SELECT generate_series(date_trunc('week', now() - interval '25 weeks'), date_trunc('week', now()), interval '1 week')::date AS wk) w
    LEFT JOIN (SELECT date_trunc('week', published_at)::date AS wk, count(*) n FROM recent GROUP BY 1) c ON c.wk = w.wk
),
months AS (
  SELECT jsonb_agg(jsonb_build_object('month', m.mo, 'posts', COALESCE(c.n, 0), 'avg_views', c.av, 'avg_likes', c.al) ORDER BY m.mo) AS j
    FROM (SELECT generate_series(date_trunc('month', now() - interval '11 months'), date_trunc('month', now()), interval '1 month')::date AS mo) m
    LEFT JOIN (SELECT date_trunc('month', published_at)::date AS mo, count(*) n,
                      round(avg(views) FILTER (WHERE views > 0)) av, round(avg(likes) FILTER (WHERE likes > 0)) al
                 FROM recent GROUP BY 1) c ON c.mo = m.mo
),
top_posts AS (
  SELECT jsonb_agg(t ORDER BY t.rank_score DESC NULLS LAST) AS j FROM (
    SELECT p.id, p.platform, p.post_type AS format, p.content_type, p.published_at, p.post_url,
           p.views, p.likes, p.comments,
           COALESCE(NULLIF(p.r->>'campaign_message',''), LEFT(p.caption, 140)) AS summary,
           (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = p.primary_project_id) AS project_name,
           (p.views >= 20 * b.median_views AND b.median_views >= 50 AND COALESCE(p.likes, 0) < 0.002 * p.views) AS likely_paid,
           round(CASE WHEN p.views > 0 AND b.median_views >= 50 THEN p.views / b.median_views
                      WHEN p.likes > 0 AND b.median_likes >= 5 THEN p.likes / b.median_likes END, 1) AS vs_usual,
           (SELECT m.stored_url FROM public.mkt_content_media m
             WHERE m.content_post_id = p.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
             ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at LIMIT 1) AS thumb_url,
           -- ranked against the account's own usual post, so a small account's hit shows
           COALESCE(CASE WHEN p.views > 0 AND b.median_views >= 50 THEN p.views / b.median_views
                         WHEN p.likes > 0 AND b.median_likes >= 5 THEN p.likes / b.median_likes END, 0) AS rank_score
      FROM recent p LEFT JOIN baseline b ON b.social_account_id = p.social_account_id
     ORDER BY rank_score DESC NULLS LAST LIMIT 12
  ) t
),
mix AS (
  SELECT jsonb_build_object(
    'content_type', (SELECT jsonb_object_agg(k, n) FROM (SELECT COALESCE(content_type, 'unknown') k, count(*) n FROM recent GROUP BY 1) a),
    'format',       (SELECT jsonb_object_agg(k, n) FROM (SELECT COALESCE(post_type, 'unknown') k, count(*) n FROM recent GROUP BY 1) a),
    'platform',     (SELECT jsonb_object_agg(k, n) FROM (SELECT platform k, count(*) n FROM recent GROUP BY 1) a)
  ) AS j
),
projects AS (
  SELECT jsonb_agg(t ORDER BY t.posts DESC) AS j FROM (
    SELECT p.primary_project_id AS project_id,
           (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = p.primary_project_id) AS name,
           count(*) AS posts, max(p.published_at) AS last_post_at,
           round(avg(p.views) FILTER (WHERE p.views > 0)) AS avg_views, round(avg(p.likes) FILTER (WHERE p.likes > 0)) AS avg_likes
      FROM posts p WHERE p.primary_project_id IS NOT NULL GROUP BY 1
  ) t
),
offers AS (
  SELECT jsonb_agg(t ORDER BY t.published_at DESC) AS j FROM (
    SELECT p.id, p.published_at, p.r->>'offer' AS offer, NULLIF(p.r->>'price','') AS price, NULLIF(p.r->>'payment_plan','') AS payment_plan,
           (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = p.primary_project_id) AS project_name
      FROM posts p WHERE COALESCE(p.r->>'offer','') <> '' ORDER BY p.published_at DESC NULLS LAST LIMIT 15
  ) t
),
messages AS (
  SELECT jsonb_agg(t ORDER BY t.published_at DESC) AS j FROM (
    SELECT p.id, p.published_at, p.r->>'campaign_message' AS message, p.content_type
      FROM recent p WHERE COALESCE(p.r->>'campaign_message','') <> '' ORDER BY p.published_at DESC NULLS LAST LIMIT 15
  ) t
),
unknown_projects AS (
  SELECT jsonb_agg(jsonb_build_object('name', name, 'posts', n) ORDER BY n DESC) AS j FROM (
    SELECT btrim(x) AS name, count(*) n FROM posts p, jsonb_array_elements_text(COALESCE(p.r->'mentioned_projects','[]'::jsonb)) x
     WHERE btrim(x) <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 20
  ) t
),
visual AS (
  SELECT jsonb_agg(jsonb_build_object('tag', tag, 'shots', n) ORDER BY n DESC) AS j FROM (
    SELECT t AS tag, count(*) n
      FROM public.mkt_cv_shots s JOIN public.mkt_cv_videos v ON v.id = s.video_id, unnest(s.tags) t
     WHERE v.organization_id = p_org AND v.owner = 'competitor'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 20
  ) t
)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM org) THEN NULL ELSE jsonb_build_object(
  'organization', (SELECT jsonb_build_object('id', id, 'name_ar', name_ar, 'name_en', name_en, 'org_type', org_type,
                    'developer_record_id', developer_record_id, 'website', website, 'hq_city', hq_city, 'status', status) FROM org),
  'totals', jsonb_build_object(
     'posts', (SELECT count(*) FROM posts), 'posts_12m', (SELECT count(*) FROM recent),
     'posts_30d', (SELECT count(*) FROM posts WHERE published_at > now() - interval '30 days'),
     'first_post_at', (SELECT min(published_at) FROM posts), 'last_post_at', (SELECT max(published_at) FROM posts),
     'avg_views_12m', (SELECT round(avg(views) FILTER (WHERE views > 0)) FROM recent),
     'avg_likes_12m', (SELECT round(avg(likes) FILTER (WHERE likes > 0)) FROM recent)),
  'accounts', COALESCE((SELECT j FROM accounts), '[]'::jsonb),
  'weeks', COALESCE((SELECT j FROM weeks), '[]'::jsonb),
  'months', COALESCE((SELECT j FROM months), '[]'::jsonb),
  'top_posts', COALESCE((SELECT j FROM top_posts), '[]'::jsonb),
  'mix', (SELECT j FROM mix),
  'projects', COALESCE((SELECT j FROM projects), '[]'::jsonb),
  'offers', COALESCE((SELECT j FROM offers), '[]'::jsonb),
  'messages', COALESCE((SELECT j FROM messages), '[]'::jsonb),
  'unknown_projects', COALESCE((SELECT j FROM unknown_projects), '[]'::jsonb),
  'visual_style', COALESCE((SELECT j FROM visual), '[]'::jsonb)
) END;
$function$;
REVOKE ALL ON FUNCTION public.mkt_company_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_company_profile(uuid) TO service_role;

COMMIT;
