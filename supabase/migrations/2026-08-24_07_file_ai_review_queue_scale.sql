-- file_ai_review_queue had the same scale trap the count did, one step behind:
-- ORDER BY created_at DESC LIMIT 200 forces Postgres to apply the per-row
-- wassell_can_access_file('edit') filter to EVERY pending row before it can sort
-- and take 200 — so the RLS cost grew with the whole pending set (2.8s at 2,669;
-- ~7.5s and a timeout near the 7,700 the backfill produces).
--
-- Fix: take the newest N pending files FIRST (index-cheap sort, no function), then
-- apply the edit gate to just those N. For an admin (edits everything) the page is
-- unchanged — the newest 200 pending. For a scoped reviewer it's the editable
-- subset of the newest 200 (they page back for the rest) — the standard
-- gate-the-page-not-the-universe tradeoff, and the only shape that stays under the
-- statement timeout at scale. Aggregation of the ai_suggested provenance stays,
-- but the expensive per-row RLS now runs on 200 rows, not thousands.
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
  ),
  newest AS (
    SELECT f.id, f.original_name, f.kind, f.mime_type, f.document_type,
           f.asset_nature, f.ai_description, f.tags, f.ai_suggestions,
           pend.ai_fields, coalesce(pend.ai_subjects, '{}'::text[]) AS ai_subjects, f.created_at
      FROM pend
      JOIN public.files f ON f.id = pend.file_id
     ORDER BY f.created_at DESC
     LIMIT greatest(1, least(p_limit, 500)) OFFSET greatest(0, p_offset)
  )
  SELECT id, original_name, kind, mime_type, document_type, asset_nature,
         ai_description, tags, ai_suggestions, ai_fields, ai_subjects, created_at
    FROM newest
   WHERE public.wassell_can_access_file(id, 'edit')
   ORDER BY created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.file_ai_review_queue(int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_ai_review_queue(int, int) TO authenticated;
