-- 2026-10-05: design reads for competitor IMAGE posts, by Gemini.
--
-- The post reader stored an image's TEXT only. The design-read table built for
-- the Post Creative Director (visual_design_reads, 2026-09-02_22) never got a
-- row: its runner/API lanes failed all 481 of their jobs. The worker now fills
-- it with gemini-3.8-flash (worker/src/marketing/content/geminiDesign.ts):
-- one SlideRead per image + one PostRead per post, model_used
-- 'gemini:gemini-3.8-flash', rule_version 'gemini-v1'. New image posts are read
-- right after their post read; this function lists the ones still owed a read
-- (posts read before this change, and failures under 3 attempts) for the
-- sweep's design pass (content_process mode 'design_only').
BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_design_read_due(p_limit int DEFAULT 200)
RETURNS TABLE(content_post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id
    FROM mkt_content_posts p
    JOIN mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done' AND e.model LIKE 'gemini%'
   WHERE EXISTS (SELECT 1 FROM mkt_content_media m WHERE m.content_post_id = p.id AND m.media_kind = 'image' AND m.download_status = 'stored')
     AND NOT EXISTS (SELECT 1 FROM mkt_content_media v WHERE v.content_post_id = p.id AND v.media_kind = 'video' AND v.download_status = 'stored')
     AND NOT EXISTS (
       SELECT 1 FROM visual_design_reads r
        WHERE r.subject_kind = 'competitor_post' AND r.subject_id = p.id AND r.level = 'post'
          AND r.model_used = 'gemini:gemini-3.8-flash' AND r.rule_version = 'gemini-v1'
          AND (r.status = 'done' OR COALESCE((r.raw->>'attempts')::int, 1) >= 3))
   ORDER BY p.published_at DESC NULLS LAST, p.id
   LIMIT GREATEST(1, LEAST(p_limit, 2000));
$$;
REVOKE ALL ON FUNCTION public.mkt_design_read_due(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_design_read_due(int) TO service_role;

COMMIT;
