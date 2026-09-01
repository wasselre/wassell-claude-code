-- Confirm-links queue: skip brand / general-branding posts.
-- A post whose only project signal is the developer's OWN name (its logo/
-- watermark, present on every post) is not evidence of a SPECIFIC project —
-- e.g. "الماجدية 174" vs a Ramadan card that just shows the الماجدية logo. These
-- were scoring 95% and clogging the review queue. The enrichment already flags
-- them (is_general_branding / content_type='brand'), so exclude them from the
-- queue. Measured: queue 2,064 -> 593 real, project-specific candidates.
-- (Non-destructive: the candidate rows remain; they're just never surfaced for
-- confirmation, so a brand post can never be linked to a project.)
--
-- The precise name-overlap rule (project name ≈ developer name + suffix ⇒ a
-- developer-name-only match must not score high) belongs in the ingestion
-- scorer (worker/skill) so NEW posts never get the inflated score; this queue
-- filter is the backlog-side application of the same principle.

CREATE OR REPLACE FUNCTION public.mkt_attribution_queue(p_limit int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH best AS MATERIALIZED (
  SELECT DISTINCT ON (a.content_post_id) a.content_post_id, a.project_id, a.confidence
  FROM public.mkt_content_attributions a
  JOIN public.mkt_content_enrichment e ON e.content_post_id = a.content_post_id
       AND e.status = 'done' AND e.primary_project_id IS NULL
  WHERE a.review_status = 'candidate'
    AND COALESCE((e.result->>'is_general_branding')::boolean, false) = false
    AND COALESCE(e.result->>'content_type', '') <> 'brand'
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
