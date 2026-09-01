-- Fix: mkt_attribution_queue timed out (statement timeout) after _10 added the
-- project-info block. Cause: resolving the developer name scanned the huge
-- unified_records UNION view per row (dev.id::text = ... defeated the PK index).
-- Fixes:
--   1. resolve the developer name from the small mkt_organizations table
--      (developer_record_id) instead of unified_records;
--   2. fetch the project record ONCE per row via LEFT JOIN LATERAL (was two
--      correlated point-lookups);
--   3. compute the candidate set once (best AS MATERIALIZED).
-- Measured: ~8s timeout → ~320 ms.

CREATE OR REPLACE FUNCTION public.mkt_attribution_queue(p_limit int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH best AS MATERIALIZED (
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
        pr.pname AS project_name,
        (SELECT f.value_text FROM public.mkt_observed_facts f
           WHERE f.content_post_id = p.id AND f.fact_type = 'project_name'
           ORDER BY f.confidence DESC NULLS LAST LIMIT 1) AS names_read,
        (SELECT m.stored_url FROM public.mkt_content_media m
           WHERE m.content_post_id = p.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
           ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
           LIMIT 1) AS thumb_url,
        jsonb_build_object(
          'developer', (SELECT o2.name_ar FROM public.mkt_organizations o2
                          WHERE o2.developer_record_id::text = pr.pdata->>'developer' LIMIT 1),
          'city',       pr.pdata->>'city_name',
          'status',     pr.pdata->>'project_status',
          'unit_types', pr.pdata->'unit_types',
          'price',      COALESCE(pr.pdata->'available_price_range', pr.pdata->'price_range'),
          'page_url',   pr.pdata->>'project_page_url'
        ) AS project
      FROM ranked r
      JOIN public.mkt_content_posts p     ON p.id = r.content_post_id
      JOIN public.mkt_organizations o     ON o.id = p.organization_id
      JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id
      LEFT JOIN LATERAL (
        SELECT ur.data AS pdata,
               COALESCE(ur.data->>'project_name', ur.data->>'name', ur.data->>'title') AS pname
        FROM public.unified_records ur WHERE ur.id = r.project_id
      ) pr ON true
    ) x
  ), '[]'::jsonb)
);
$$;
