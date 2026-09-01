-- Relevant competitor video-transcript sample for the in-app video-script
-- generator (the «اكتب سكربت» button on a video content record). Real-estate
-- video content types only (avoids brand/off-topic noise), longest 12.
-- Read-only, SECURITY DEFINER; called by api/_lib/marketing/videoScript.ts.
CREATE OR REPLACE FUNCTION public.mkt_script_transcripts_sample()
RETURNS TABLE(txt text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT LEFT(t.text, 500) AS txt
  FROM public.mkt_transcripts t
  JOIN public.mkt_content_posts p ON p.id = t.content_post_id
  JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
  WHERE t.status = 'done' AND length(t.text) > 200
    AND (e.result->>'content_type') IN ('walkthrough','offer','project_launch','teaser')
  ORDER BY length(t.text) DESC
  LIMIT 12;
$$;
REVOKE ALL ON FUNCTION public.mkt_script_transcripts_sample() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_script_transcripts_sample() TO authenticated, service_role;
