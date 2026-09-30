-- Stored thumbnails for videos + PDFs, and a batch transcript read.
--
-- (1) files.thumb_path — a small JPEG poster in the SAME bucket as the file
--     (`thumbs/<file_id>.jpg`). Images never needed one (Storage transforms the
--     original on the fly), but a video or a PDF has nothing to transform, so
--     every grid showed a grey icon. Written by the worker's enrichment lane for
--     new uploads and by scripts/backfill-file-thumbs.mjs for existing files;
--     signed by /api/files/sign-view-urls under the file's own view check.
--     NULL = no poster yet → the tile falls back to the kind icon.
--
-- (2) file_video_transcripts(uuid[]) — the batch twin of file_video_transcript:
--     one call for a whole grid instead of one per tile. Same sources, same
--     Arabic-first pick, same per-file access check.

BEGIN;

ALTER TABLE public.files ADD COLUMN IF NOT EXISTS thumb_path text;

CREATE OR REPLACE FUNCTION public.file_video_transcripts(p_file_ids uuid[])
 RETURNS TABLE(file_id uuid, transcript text, language text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (t.file_id) t.file_id, t.text, t.language FROM (
    SELECT m.file_id, tr.text, tr.language, tr.updated_at
      FROM public.mkt_content_media m
      JOIN public.mkt_transcripts tr ON tr.content_media_id = m.id
     WHERE m.file_id = ANY (p_file_ids)
       AND tr.status = 'done'
       AND btrim(coalesce(tr.text, '')) <> ''
    UNION ALL
    SELECT ft.file_id, ft.text, ft.language, ft.updated_at
      FROM public.file_transcripts ft
     WHERE ft.file_id = ANY (p_file_ids)
       AND ft.status = 'done'
       AND btrim(coalesce(ft.text, '')) <> ''
  ) t
  WHERE public.wassell_can_access_file(t.file_id, 'view')
  ORDER BY t.file_id, (t.language = 'ar') DESC NULLS LAST, t.updated_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.file_video_transcripts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_video_transcripts(uuid[]) TO authenticated, service_role;

COMMIT;
