-- ============================================================================
-- Marketing Intelligence index (2026-08-13).
--
-- One composed read for the Marketing Intelligence page shell: the global
-- insight feed plus the project and organization pickers, against a single
-- consistent snapshot. Same posture as mkt_project_intelligence /
-- mkt_organization_intelligence — compose server-side so the page is one round
-- trip rather than N waterfalls.
--
-- Deterministic. No AI. Every number is a COUNT or a MAX over stored rows.
--
-- The `coverage` block is not decoration. This platform's recurring failure mode
-- is a confidently-wrong number: rollups that counted speculative attributions
-- and inflated project activity ~4x, and a job queue that read 684-succeeded /
-- 0-failed while its OCR step was dead. Every list here therefore reports what
-- it is NOT showing, and the page is expected to render it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mkt_intelligence_index(p_limit int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_all_projects constant uuid := '220c49b9-de57-492d-9eca-c0d9f54fd40f';
  v_limit int := greatest(1, least(coalesce(p_limit, 60), 500));
  v_insights jsonb; v_projects jsonb; v_orgs jsonb; v_coverage jsonb;
  v_proj_total int; v_org_total int; v_ins_total int;
BEGIN
  -- ── Insight feed: live (undismissed), newest first, names resolved ────────
  SELECT count(*) INTO v_ins_total FROM mkt_insights WHERE COALESCE(dismissed,false) = false;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.severity_rank, x.generated_at DESC), '[]'::jsonb)
    INTO v_insights
  FROM (
    SELECT i.id, i.kind, i.severity, i.title, i.body, i.evidence, i.generated_at,
           i.project_id, i.organization_id,
           r.data->>'project_name' AS project_name,
           COALESCE(o.name_ar, o.name_en) AS organization_name,
           CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END AS severity_rank
    FROM mkt_insights i
    LEFT JOIN unified_records r ON r.id = i.project_id AND r.model_id = v_all_projects
    LEFT JOIN mkt_organizations o ON o.id = i.organization_id
    WHERE COALESCE(i.dismissed,false) = false
    ORDER BY severity_rank, i.generated_at DESC
    LIMIT v_limit
  ) x;

  -- ── Project picker: only projects with SOME marketing signal ─────────────
  -- post_count is confirmed attributions only; candidate_post_count is the
  -- speculative "this org markets these projects" set, kept separate on purpose.
  SELECT count(*) INTO v_proj_total
  FROM mkt_project_marketing_state s
  WHERE s.post_count > 0 OR s.candidate_post_count > 0 OR s.ad_count > 0;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.last_activity_at DESC NULLS LAST), '[]'::jsonb)
    INTO v_projects
  FROM (
    SELECT s.project_id, r.data->>'project_name' AS name, r.data->>'city' AS city,
           s.post_count, s.candidate_post_count, s.ad_count, s.fact_count,
           s.org_count, s.platform_count, s.platforms,
           s.min_advertised_price, s.max_advertised_price, s.last_activity_at
    FROM mkt_project_marketing_state s
    LEFT JOIN unified_records r ON r.id = s.project_id AND r.model_id = v_all_projects
    WHERE s.post_count > 0 OR s.candidate_post_count > 0 OR s.ad_count > 0
    ORDER BY s.last_activity_at DESC NULLS LAST
    LIMIT v_limit
  ) x;

  -- ── Organization picker: developers AND marketers, one shape ─────────────
  SELECT count(*) INTO v_org_total
  FROM mkt_organizations o
  WHERE EXISTS (SELECT 1 FROM mkt_content_posts p WHERE p.organization_id = o.id)
     OR EXISTS (SELECT 1 FROM mkt_project_organizations po WHERE po.organization_id = o.id AND po.is_active);

  SELECT COALESCE(jsonb_agg(x ORDER BY x.post_count DESC, x.name), '[]'::jsonb)
    INTO v_orgs
  FROM (
    SELECT o.id AS organization_id,
           COALESCE(o.name_ar, o.name_en) AS name,
           o.name_ar, o.name_en, o.hq_city, o.status, o.website,
           (SELECT count(*) FROM mkt_project_organizations po
             WHERE po.organization_id = o.id AND po.is_active)            AS project_count,
           (SELECT count(*) FROM mkt_content_posts p
             WHERE p.organization_id = o.id)                              AS post_count,
           (SELECT count(*) FROM mkt_observed_facts f
             WHERE f.organization_id = o.id)                              AS fact_count,
           (SELECT max(p.published_at) FROM mkt_content_posts p
             WHERE p.organization_id = o.id)                              AS last_activity_at
    FROM mkt_organizations o
    WHERE EXISTS (SELECT 1 FROM mkt_content_posts p WHERE p.organization_id = o.id)
       OR EXISTS (SELECT 1 FROM mkt_project_organizations po WHERE po.organization_id = o.id AND po.is_active)
    ORDER BY post_count DESC, name
    LIMIT v_limit
  ) x;

  -- ── Coverage: what this page does NOT know. Render it, do not hide it. ───
  SELECT jsonb_build_object(
    'posts_total',        (SELECT count(*) FROM mkt_content_posts),
    'posts_processed',    (SELECT count(*) FROM mkt_content_posts
                            WHERE processing_status IN ('processed','partial')),
    -- `awaiting_intelligence` is NOT "unprocessed". Media, OCR and facts have all
    -- landed for these posts — only the runner's attribution decision is
    -- outstanding. Collapsing the two would understate the fact layer (which is
    -- fully populated) and overstate what is broken (nothing is).
    'posts_awaiting_intelligence', (SELECT count(*) FROM mkt_content_posts
                                     WHERE processing_status = 'awaiting_intelligence'),
    'posts_failed',       (SELECT count(*) FROM mkt_content_posts
                            WHERE processing_status = 'failed'),
    'posts_by_status',    (SELECT COALESCE(jsonb_object_agg(s, n), '{}'::jsonb)
                             FROM (SELECT COALESCE(processing_status,'(none)') AS s, count(*) AS n
                                     FROM mkt_content_posts GROUP BY 1) q),
    'posts_without_ocr',  (SELECT count(*) FROM mkt_content_posts p
                            WHERE NOT EXISTS (SELECT 1 FROM mkt_visual_text v
                                               WHERE v.content_post_id = p.id)),
    'facts_total',        (SELECT count(*) FROM mkt_observed_facts),
    'orgs_total',         v_org_total,
    'orgs_with_facts',    (SELECT count(DISTINCT organization_id) FROM mkt_observed_facts
                            WHERE organization_id IS NOT NULL),
    'attribution',        jsonb_build_object(
                            'confirmed',   (SELECT count(*) FROM mkt_content_attributions
                                             WHERE review_status IN ('auto_accepted','confirmed')),
                            'speculative', (SELECT count(*) FROM mkt_content_attributions
                                             WHERE review_status = 'candidate')),
    'note', 'Project post counts are CONFIRMED attributions only. Speculative '
         || 'candidates are reported separately and are never mixed in. Posts '
         || 'awaiting_intelligence already contribute facts (media, OCR and fact '
         || 'extraction are complete) but carry no project decision yet. Posts '
         || 'without OCR contribute caption and transcript evidence only.'
  ) INTO v_coverage;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'insights',      jsonb_build_object('shown', jsonb_array_length(v_insights),
                                        'total', v_ins_total, 'rows', v_insights),
    'projects',      jsonb_build_object('shown', jsonb_array_length(v_projects),
                                        'total', v_proj_total, 'rows', v_projects),
    'organizations', jsonb_build_object('shown', jsonb_array_length(v_orgs),
                                        'total', v_org_total, 'rows', v_orgs),
    'coverage', v_coverage
  );
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_intelligence_index(int) TO service_role, authenticated;

-- Dismiss / restore a single insight. Used by the feed so an operator can clear
-- a handled item without deleting the evidence trail.
CREATE OR REPLACE FUNCTION public.mkt_insight_set_dismissed(p_insight_id uuid, p_dismissed boolean)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.mkt_insights SET dismissed = COALESCE(p_dismissed, true)
   WHERE id = p_insight_id
  RETURNING true;
$$;

GRANT EXECUTE ON FUNCTION public.mkt_insight_set_dismissed(uuid, boolean) TO service_role, authenticated;
