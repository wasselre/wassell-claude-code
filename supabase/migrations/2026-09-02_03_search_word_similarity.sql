-- ════════════════════════════════════════════════════════════════════════════
-- W5 (bilingual): make mode-1 ranked search find a WORD inside a long document.
--
-- record_search_v2 / entity_search (W1 mig 04) used whole-string similarity()
-- + the `%` operator: similarity('a long unit description …', 'wide') is tiny
-- (normalized over ALL trigrams of the long side), so a real word that appears
-- in a description scored below pg_trgm.similarity_threshold and the record was
-- NOT returned — proven live (query "Wide" missed a record whose text_en
-- contains it). The correct tool is word_similarity(): the `<%` operator matches
-- when the query resembles ANY word-boundary substring of the document, which is
-- exactly "does this record contain this word?". Same GIN gin_trgm_ops indexes
-- back both operators — no new index.
--
-- These RPCs are built but not yet the active UI search path (the SPA still uses
-- the in-memory substring index), so this is a correctness fix on a dormant
-- function, not a behavior change to a live surface.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_search_v2(
  p_model_id uuid, p_query text, p_lang text DEFAULT 'ar',
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS TABLE (record_id uuid, rank real)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH q AS (SELECT public.wassell_search_norm(p_query) AS nq)
  SELECT sd.entity_id,
    GREATEST(
      word_similarity(q.nq, public.wassell_search_norm(sd.text_src)),
      word_similarity(q.nq, public.wassell_search_norm(sd.text_ar)) * (CASE WHEN p_lang='ar' THEN 1.1 ELSE 1.0 END),
      word_similarity(q.nq, public.wassell_search_norm(sd.text_en)) * (CASE WHEN p_lang='en' THEN 1.1 ELSE 1.0 END)
    )::real AS rank
  FROM public.search_documents sd, q
  WHERE sd.resource_kind = 'record'
    AND (p_model_id IS NULL OR sd.model_id = p_model_id)
    AND (q.nq <% public.wassell_search_norm(sd.text_src)
      OR q.nq <% public.wassell_search_norm(sd.text_ar)
      OR q.nq <% public.wassell_search_norm(sd.text_en))
    AND EXISTS (SELECT 1 FROM public.unified_records ur WHERE ur.id = sd.entity_id)  -- caller RLS
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
$$;

CREATE OR REPLACE FUNCTION public.entity_search(
  p_kind text, p_query text, p_lang text DEFAULT 'ar',
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS TABLE (entity_id uuid, rank real)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH q AS (SELECT public.wassell_search_norm(p_query) AS nq)
  SELECT sd.entity_id,
    GREATEST(
      word_similarity(q.nq, public.wassell_search_norm(sd.text_src)),
      word_similarity(q.nq, public.wassell_search_norm(sd.text_ar)),
      word_similarity(q.nq, public.wassell_search_norm(sd.text_en))
    )::real AS rank
  FROM public.search_documents sd, q
  WHERE sd.resource_kind = p_kind
    AND (q.nq <% public.wassell_search_norm(sd.text_src)
      OR q.nq <% public.wassell_search_norm(sd.text_ar)
      OR q.nq <% public.wassell_search_norm(sd.text_en))
    AND public.translation_visible(sd.resource_kind, sd.entity_id)   -- caller RLS per kind
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION public.record_search_v2(uuid, text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.entity_search(text, text, text, int, int) TO authenticated;
