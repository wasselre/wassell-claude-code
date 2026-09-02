-- Post-level text embeddings for competitor content (transcript + OCR + campaign
-- message + selling points) and the relevance-based exemplar retrieval that
-- replaces the "12 longest transcripts" sampler.
CREATE TABLE IF NOT EXISTS public.mkt_content_embeddings (
  content_post_id uuid PRIMARY KEY REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  embedding       extensions.vector(1024) NOT NULL,
  model           text NOT NULL,
  version         int  NOT NULL DEFAULT 1,
  text_hash       text NOT NULL,
  source_text     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_content_embeddings_hnsw
  ON public.mkt_content_embeddings USING hnsw (embedding extensions.vector_cosine_ops) WITH (m = 16, ef_construction = 64);
ALTER TABLE public.mkt_content_embeddings ENABLE ROW LEVEL SECURITY; -- service-only

-- Candidate exemplars for a brief: filters + cosine similarity in SQL. Diversity
-- (MMR, per-org caps, near-duplicate collapse) is applied by the worker.
CREATE OR REPLACE FUNCTION public.mkt_script_exemplars(
  p_query extensions.vector(1024),
  p_content_types text[],
  p_platforms text[],
  p_language text,
  p_exclude_org uuid,
  p_limit int DEFAULT 40)
RETURNS TABLE (
  content_post_id uuid, organization_id uuid, org_name text, platform text, post_type text,
  content_type text, language text, views bigint, similarity numeric,
  transcript_text text, transcript_segments jsonb, transcript_language text, ocr_text text,
  campaign_message text, selling_points jsonb, offer text, unit_types jsonb, district text,
  published_at timestamptz, post_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
  WITH tx AS (
    -- prefer an Arabic transcript when one exists (re-transcription stores a second model key)
    SELECT DISTINCT ON (t.content_post_id) t.content_post_id, t.text, t.segments, t.language
      FROM public.mkt_transcripts t
     WHERE t.status = 'done' AND length(COALESCE(t.text,'')) > 80
     ORDER BY t.content_post_id, (t.language = 'ar') DESC, length(t.text) DESC
  ), ocr AS (
    SELECT v.content_post_id, string_agg(NULLIF(v.text,''), ' | ') AS ocr_text
      FROM public.mkt_visual_text v WHERE v.status = 'done' GROUP BY v.content_post_id
  )
  SELECT p.id, p.organization_id, o.name_ar, p.platform, p.post_type,
         e.result->>'content_type', COALESCE(e.result->>'language', tx.language),
         NULLIF(p.engagement->>'views','')::bigint,
         (1 - (emb.embedding <=> p_query))::numeric AS similarity,
         tx.text, tx.segments, tx.language, ocr.ocr_text,
         NULLIF(e.result->>'campaign_message',''), e.result->'selling_points', NULLIF(e.result->>'offer',''),
         e.result->'unit_types', NULLIF(e.result->>'district',''), p.published_at, p.post_url
    FROM public.mkt_content_embeddings emb
    JOIN public.mkt_content_posts p ON p.id = emb.content_post_id
    LEFT JOIN public.mkt_organizations o ON o.id = p.organization_id
    LEFT JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
    LEFT JOIN tx ON tx.content_post_id = p.id
    LEFT JOIN ocr ON ocr.content_post_id = p.id
   WHERE p.post_type IN ('video','reel','short')
     AND (tx.text IS NOT NULL OR ocr.ocr_text IS NOT NULL)
     AND (p_content_types IS NULL OR cardinality(p_content_types) = 0 OR (e.result->>'content_type') = ANY(p_content_types))
     AND (p_platforms IS NULL OR cardinality(p_platforms) = 0 OR p.platform = ANY(p_platforms))
     AND (p_language IS NULL OR COALESCE(e.result->>'language', tx.language) IN (p_language, 'mixed'))
     AND (p_exclude_org IS NULL OR p.organization_id IS DISTINCT FROM p_exclude_org)
     AND COALESCE((e.result->>'is_general_branding')::boolean, false) = false
   ORDER BY emb.embedding <=> p_query
   LIMIT GREATEST(p_limit, 1);
$$;
REVOKE ALL ON FUNCTION public.mkt_script_exemplars(extensions.vector, text[], text[], text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_script_exemplars(extensions.vector, text[], text[], text, uuid, int) TO service_role;
