-- Competitor Content Library — return the project's record id so a confident
-- project attribution becomes a clickable link (like the developer link).
-- project_record_id = the enrichment's primary_project_id (an all_projects id);
-- NULL when the post isn't confidently attributed. Additive; carries the
-- developer + media fields from _07 forward.

CREATE OR REPLACE FUNCTION public.mkt_content_library(
  p_shelf     text    DEFAULT NULL,
  p_org       uuid    DEFAULT NULL,
  p_format    text    DEFAULT NULL,
  p_platform  text    DEFAULT NULL,
  p_has_offer boolean DEFAULT NULL,
  p_q         text    DEFAULT NULL,
  p_limit     int     DEFAULT 40,
  p_offset    int     DEFAULT 0
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH base AS (
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id,
    o.name_ar                                   AS org_name,
    o.developer_record_id                       AS developer_record_id,
    e.primary_project_id,
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
  SELECT * FROM filt WHERE (p_shelf IS NULL OR content_type = p_shelf)
),
page AS (
  SELECT jsonb_agg(to_jsonb(x)) AS rows FROM (
    SELECT
      s.id, s.org_name, s.organization_id, s.developer_record_id, s.platform,
      s.primary_project_id::text                      AS project_record_id,
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
          AND m.media_kind IN ('image', 'video')) AS media
    FROM shelved s
    ORDER BY s.published_at DESC NULLS LAST, s.id
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
$$;
