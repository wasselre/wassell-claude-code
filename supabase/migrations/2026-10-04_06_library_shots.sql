-- One library (2026-10-04): each Content Library row also carries its stored
-- video's media id and shot status, so a video entry opens its shots in place
-- and the separate Visual library tab becomes a search mode of the same page.
-- Same signature as 2026-10-04_04 → CREATE OR REPLACE keeps the grants; the
-- MATERIALIZED baseline stays (without it the query took >120 s).

BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_content_library(
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
      (SELECT sa.handle FROM public.mkt_social_accounts sa WHERE sa.id = s.social_account_id) AS account_handle,
      -- one library (2026-10-04): the post's stored video and its shot status,
      -- so a video entry can open its shots in place
      vm.id AS video_media_id,
      (SELECT v.status FROM public.mkt_cv_videos v WHERE v.content_media_id = vm.id) AS shots_status,
      (SELECT v.shot_count FROM public.mkt_cv_videos v WHERE v.content_media_id = vm.id) AS shot_count
    FROM shelved s
    LEFT JOIN LATERAL (SELECT m.id FROM public.mkt_content_media m
                        WHERE m.content_post_id = s.id AND m.media_kind = 'video' AND m.download_status = 'stored'
                        ORDER BY m.carousel_index LIMIT 1) vm ON true
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

COMMIT;
