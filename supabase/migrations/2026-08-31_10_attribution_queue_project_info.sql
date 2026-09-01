-- Confirm-links focus mode — return richer context so a reviewer can judge each
-- decision without leaving the screen: the fuller caption, and an "about the
-- project" block (developer, city, price, unit types, status, page link).

CREATE OR REPLACE FUNCTION public.mkt_attribution_queue(p_limit int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH best AS (
  SELECT DISTINCT ON (a.content_post_id) a.content_post_id, a.project_id, a.confidence
  FROM public.mkt_content_attributions a
  JOIN public.mkt_content_enrichment e ON e.content_post_id = a.content_post_id
       AND e.status = 'done' AND e.primary_project_id IS NULL
  WHERE a.review_status = 'candidate'
  ORDER BY a.content_post_id, a.confidence DESC NULLS LAST
),
ranked AS (
  SELECT * FROM best ORDER BY confidence DESC NULLS LAST LIMIT GREATEST(p_limit, 0)
)
SELECT jsonb_build_object(
  'remaining', (SELECT count(*) FROM best),
  'items', COALESCE((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.confidence DESC NULLS LAST) FROM (
      SELECT
        p.id AS post_id, r.project_id, r.confidence,
        o.name_ar AS org_name, p.platform, p.post_type AS format, p.post_url, p.published_at,
        COALESCE(NULLIF(e.result->>'campaign_message',''), LEFT(p.caption, 180)) AS summary,
        LEFT(p.caption, 400) AS caption,
        (SELECT COALESCE(pr.data->>'project_name', pr.data->>'name', pr.data->>'title')
           FROM public.unified_records pr WHERE pr.id = r.project_id) AS project_name,
        (SELECT f.value_text FROM public.mkt_observed_facts f
           WHERE f.content_post_id = p.id AND f.fact_type = 'project_name'
           ORDER BY f.confidence DESC NULLS LAST LIMIT 1) AS names_read,
        (SELECT m.stored_url FROM public.mkt_content_media m
           WHERE m.content_post_id = p.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
           ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
           LIMIT 1) AS thumb_url,
        (SELECT jsonb_build_object(
            'developer', (SELECT dev.data->>'name' FROM public.unified_records dev WHERE dev.id::text = pr.data->>'developer'),
            'city',       pr.data->>'city_name',
            'status',     pr.data->>'project_status',
            'unit_types', pr.data->'unit_types',
            'price',      COALESCE(pr.data->'available_price_range', pr.data->'price_range'),
            'page_url',   pr.data->>'project_page_url'
          ) FROM public.unified_records pr WHERE pr.id = r.project_id) AS project
      FROM ranked r
      JOIN public.mkt_content_posts p     ON p.id = r.content_post_id
      JOIN public.mkt_organizations o     ON o.id = p.organization_id
      JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id
    ) x
  ), '[]'::jsonb)
);
$$;
