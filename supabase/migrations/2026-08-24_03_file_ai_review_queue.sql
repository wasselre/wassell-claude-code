-- AI review queue: every file that still carries at least one ai_suggested
-- provenance row, restricted to files the caller can EDIT (approve/dismiss both
-- gate on edit access, so a view-only file has no actionable place here). Powers
-- the Library's "AI review" tab — one screen to judge enrichment quality and
-- accept/dismiss in bulk, instead of opening files one at a time.
--
-- SECURITY DEFINER so the provenance JOIN + per-row access check run with a
-- stable search_path; auth.uid() still reads the CALLER's JWT, so the edit gate
-- is the caller's own permission, not the definer's.

CREATE OR REPLACE FUNCTION public.file_ai_review_queue(p_limit int DEFAULT 200, p_offset int DEFAULT 0)
RETURNS TABLE (
  id uuid,
  original_name text,
  kind text,
  mime_type text,
  document_type text,
  asset_nature text,
  ai_description text,
  tags text[],
  ai_suggestions jsonb,
  ai_fields text[],
  ai_subjects text[],
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH pend AS (
    SELECT p.file_id,
           array_agg(p.field_path ORDER BY p.field_path) AS ai_fields,
           array_remove(array_agg(
             CASE WHEN p.field_path LIKE 'subject:%' THEN substr(p.field_path, 9) END
             ORDER BY p.field_path), NULL) AS ai_subjects
      FROM public.file_metadata_provenance p
     WHERE p.state = 'ai_suggested'
     GROUP BY p.file_id
  )
  SELECT f.id, f.original_name, f.kind, f.mime_type, f.document_type,
         f.asset_nature, f.ai_description, f.tags, f.ai_suggestions,
         pend.ai_fields, coalesce(pend.ai_subjects, '{}'::text[]), f.created_at
    FROM pend
    JOIN public.files f ON f.id = pend.file_id
   WHERE public.wassell_can_access_file(f.id, 'edit')
   ORDER BY f.created_at DESC
   LIMIT greatest(1, least(p_limit, 500)) OFFSET greatest(0, p_offset);
$$;
REVOKE ALL ON FUNCTION public.file_ai_review_queue(int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_ai_review_queue(int, int) TO authenticated;

-- The honest total (so the tab can show a badge and the page can say
-- "showing first N of M" rather than silently capping). Same edit gate.
CREATE OR REPLACE FUNCTION public.file_ai_review_count()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int
    FROM (SELECT DISTINCT file_id FROM public.file_metadata_provenance WHERE state = 'ai_suggested') p
   WHERE public.wassell_can_access_file(p.file_id, 'edit');
$$;
REVOKE ALL ON FUNCTION public.file_ai_review_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_ai_review_count() TO authenticated;
