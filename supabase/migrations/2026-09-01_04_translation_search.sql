-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W1 — migration 04/05: bilingual entity search.
-- Four-mode contract (REV 4 §C2): this file = mode 1 (ranked free-text) and
-- the index behind mode 2 (field filtering lives on translation_variants,
-- created in mig 02). Modes 3 (exact/raw) and 4 (lookup) need no schema.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS sd_src_trgm ON public.search_documents
  USING gin (public.wassell_search_norm(text_src) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sd_ar_trgm ON public.search_documents
  USING gin (public.wassell_search_norm(text_ar) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sd_en_trgm ON public.search_documents
  USING gin (public.wassell_search_norm(text_en) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sd_dirty_idx ON public.search_documents (dirty) WHERE dirty;
CREATE INDEX IF NOT EXISTS sd_model_idx ON public.search_documents (model_id) WHERE model_id IS NOT NULL;

-- Rebuild one record's search document (worker + reconcile call this; also
-- runs inline after a translation activates so new text is findable at once).
-- text_src = raw translatable values; text_ar/text_en = ONLY generation-valid
-- variant displays (REV 4 blocker 6: stale translations are never indexed —
-- the capture trigger already cleared the columns synchronously).
CREATE OR REPLACE FUNCTION public.search_document_rebuild_record(p_record_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_model uuid; v_src text; v_ar text; v_en text;
BEGIN
  SELECT ur.model_id,
    (SELECT string_agg(btrim(ur.data->>p.field_path), ' ')
     FROM translation_field_policies p
     WHERE p.resource_kind='record' AND p.scope_id = ur.model_id
       AND p.classification_status='confirmed' AND p.treatment IN ('translate','transliterate')
       AND p.field_path !~ '\[' AND p.field_path NOT LIKE 'pair:%'
       AND COALESCE(btrim(ur.data->>p.field_path),'') <> '')
  INTO v_model, v_src
  FROM unified_records ur WHERE ur.id = p_record_id;
  IF v_model IS NULL THEN
    DELETE FROM search_documents WHERE resource_kind='record' AND entity_id = p_record_id;
    RETURN;
  END IF;
  SELECT string_agg(v.display_text, ' ') FILTER (WHERE v.lang='ar'),
         string_agg(v.display_text, ' ') FILTER (WHERE v.lang='en')
  INTO v_ar, v_en
  FROM translation_variants v
  JOIN translation_units u USING (resource_kind, entity_id, field_path)
  WHERE v.resource_kind='record' AND v.entity_id = p_record_id AND v.role='target'
    AND v.state IN ('translated','approved') AND v.generation = u.generation
    AND v.display_text IS NOT NULL;
  INSERT INTO search_documents (resource_kind, entity_id, model_id, text_src, text_ar, text_en, dirty, updated_at)
  VALUES ('record', p_record_id, v_model, v_src, v_ar, v_en, false, now())
  ON CONFLICT (resource_kind, entity_id) DO UPDATE SET
    model_id = EXCLUDED.model_id, text_src = EXCLUDED.text_src,
    text_ar = EXCLUDED.text_ar, text_en = EXCLUDED.text_en,
    dirty = false, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.search_documents_rebuild_dirty(p_limit int DEFAULT 200)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int := 0; r record;
BEGIN
  FOR r IN SELECT entity_id FROM search_documents
           WHERE resource_kind='record' AND dirty LIMIT p_limit
  LOOP
    PERFORM search_document_rebuild_record(r.entity_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Ranked free-text search — SECURITY INVOKER: the join through
-- translation_visible / unified_records applies the CALLER's RLS per row, so
-- a rep only ever gets hits they may see (REV 4 §C2 mode 1).
CREATE OR REPLACE FUNCTION public.record_search_v2(
  p_model_id uuid, p_query text, p_lang text DEFAULT 'ar',
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS TABLE (record_id uuid, rank real)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH q AS (SELECT public.wassell_search_norm(p_query) AS nq)
  SELECT sd.entity_id,
    GREATEST(
      similarity(public.wassell_search_norm(sd.text_src), q.nq),
      similarity(public.wassell_search_norm(sd.text_ar),  q.nq) * (CASE WHEN p_lang='ar' THEN 1.1 ELSE 1.0 END),
      similarity(public.wassell_search_norm(sd.text_en),  q.nq) * (CASE WHEN p_lang='en' THEN 1.1 ELSE 1.0 END)
    )::real AS rank
  FROM public.search_documents sd, q
  WHERE sd.resource_kind = 'record'
    AND (p_model_id IS NULL OR sd.model_id = p_model_id)
    AND (public.wassell_search_norm(sd.text_src) % q.nq
      OR public.wassell_search_norm(sd.text_ar)  % q.nq
      OR public.wassell_search_norm(sd.text_en)  % q.nq)
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
      similarity(public.wassell_search_norm(sd.text_src), q.nq),
      similarity(public.wassell_search_norm(sd.text_ar),  q.nq),
      similarity(public.wassell_search_norm(sd.text_en),  q.nq)
    )::real AS rank
  FROM public.search_documents sd, q
  WHERE sd.resource_kind = p_kind
    AND (public.wassell_search_norm(sd.text_src) % q.nq
      OR public.wassell_search_norm(sd.text_ar)  % q.nq
      OR public.wassell_search_norm(sd.text_en)  % q.nq)
    AND public.translation_visible(sd.resource_kind, sd.entity_id)   -- caller RLS per kind
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION public.record_search_v2(uuid, text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.entity_search(text, text, text, int, int) TO authenticated;
REVOKE ALL ON FUNCTION public.search_document_rebuild_record(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_documents_rebuild_dirty(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_document_rebuild_record(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_documents_rebuild_dirty(int) TO service_role;
