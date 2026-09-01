-- Competitor Watch — "Confirm links" review flow.
-- Turns the AI's speculative candidate attributions into confirmed project links
-- via a human ✓/✗, the same approve/dismiss loop the Files section uses. Reuses
-- the already-computed candidates (no expensive live fuzzy matching).

-- Queue: for each UNLINKED post (no primary_project_id) its BEST candidate
-- (highest confidence, not yet rejected), strongest first.
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
        (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name', ur.data->>'title')
           FROM public.unified_records ur WHERE ur.id = r.project_id) AS project_name,
        (SELECT f.value_text FROM public.mkt_observed_facts f
           WHERE f.content_post_id = p.id AND f.fact_type = 'project_name'
           ORDER BY f.confidence DESC NULLS LAST LIMIT 1) AS names_read,
        (SELECT m.stored_url FROM public.mkt_content_media m
           WHERE m.content_post_id = p.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
           ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
           LIMIT 1) AS thumb_url
      FROM ranked r
      JOIN public.mkt_content_posts p     ON p.id = r.content_post_id
      JOIN public.mkt_organizations o     ON o.id = p.organization_id
      JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id
    ) x
  ), '[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION public.mkt_attribution_queue(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_attribution_queue(int) TO authenticated, service_role;

-- Record a decision. accept=true → confirm THIS project, reject the post's other
-- candidates (one project wins), and set the enrichment's primary_project_id so
-- the Library shows the clickable link. accept=false → reject just this candidate
-- (the post's next-best guess surfaces next time). Idempotent on re-click.
CREATE OR REPLACE FUNCTION public.mkt_attribution_review(
  p_post_id uuid, p_project_id uuid, p_accept boolean, p_user uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF p_accept THEN
    UPDATE public.mkt_content_attributions
       SET review_status='confirmed', attribution_method='manual',
           confirmed_by=p_user, confirmed_at=now(), updated_at=now()
     WHERE content_post_id=p_post_id AND project_id=p_project_id;

    UPDATE public.mkt_content_attributions
       SET review_status='rejected', confirmed_by=p_user, confirmed_at=now(), updated_at=now()
     WHERE content_post_id=p_post_id AND project_id<>p_project_id AND review_status='candidate';

    UPDATE public.mkt_content_enrichment
       SET primary_project_id=p_project_id, updated_at=now()
     WHERE content_post_id=p_post_id AND primary_project_id IS NULL;
  ELSE
    UPDATE public.mkt_content_attributions
       SET review_status='rejected', confirmed_by=p_user, confirmed_at=now(), updated_at=now()
     WHERE content_post_id=p_post_id AND project_id=p_project_id AND review_status='candidate';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.mkt_attribution_review(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_attribution_review(uuid, uuid, boolean, uuid) TO service_role;
