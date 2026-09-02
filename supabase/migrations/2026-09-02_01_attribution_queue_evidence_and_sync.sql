-- Confirm-links queue: two fixes after the "Riviera 59 suggested as Riviera 36" report.
--
-- Bug 1 — POINTER DISCONNECT: 335 posts had their correct project already
--   auto_accepted/confirmed in mkt_content_attributions, but the enrichment's
--   primary_project_id was never synced to it. So the post looked unlinked, sat
--   in the review queue, and its next-best *candidate* (often a wrong one, e.g.
--   a stray "ريفيرا 36" number-match from a video frame) was shown at 95%.
--   Fix: sync primary_project_id from the best accepted attribution. Idempotent
--   (only fills where NULL). Those posts then leave the queue AND show their real
--   project link in the Library.
--
-- Bug 2 — NON-EVIDENCE CANDIDATES: every marketer/developer post gets a 0.40
--   "marketer_assignment" candidate to EVERY project that org markets (an
--   org→project link, not evidence THIS post is about that project). They flooded
--   the queue. Fix: the queue now requires real text evidence
--   (attribution_method <> 'marketer_assignment'). Measured: queue 616 -> 138.

-- ── Bug 1: sync the pointer from accepted attributions (one-time, idempotent) ──
WITH sub AS (
  SELECT DISTINCT ON (content_post_id) content_post_id, project_id
  FROM public.mkt_content_attributions
  WHERE review_status IN ('auto_accepted','confirmed') AND project_id IS NOT NULL
  ORDER BY content_post_id, confidence DESC NULLS LAST
)
UPDATE public.mkt_content_enrichment e
SET primary_project_id = sub.project_id, updated_at = now()
FROM sub
WHERE e.content_post_id = sub.content_post_id
  AND e.status = 'done'
  AND e.primary_project_id IS NULL;

-- ── Bug 2: queue requires real text evidence (exclude org-link candidates) ─────
CREATE OR REPLACE FUNCTION public.mkt_attribution_queue(p_limit int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH best AS MATERIALIZED (
  SELECT DISTINCT ON (a.content_post_id) a.content_post_id, a.project_id, a.confidence
  FROM public.mkt_content_attributions a
  JOIN public.mkt_content_enrichment e ON e.content_post_id = a.content_post_id
       AND e.status = 'done' AND e.primary_project_id IS NULL
  WHERE a.review_status = 'candidate'
    AND a.attribution_method <> 'marketer_assignment'
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
