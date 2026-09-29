-- Transcripts for CRM video FILES that the marketing collection lane never saw.
--
-- Until now a video's transcript could only live in mkt_transcripts, keyed by
-- mkt_content_media (i.e. competitor/social reels the collector downloaded).
-- Our OWN uploaded videos (marketing assets, developer content) had nowhere to
-- store one. file_transcripts is that home: one row per files.id. Written by
-- operator scripts with the service role (scripts/transcribe-developer-videos.mjs);
-- read through file_video_transcript() and the broker portal.
--
-- language = 'none' + empty text means "transcribed, no speech" (music-only).

BEGIN;

CREATE TABLE IF NOT EXISTS public.file_transcripts (
  file_id     uuid PRIMARY KEY REFERENCES public.files(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  model       text NOT NULL,
  language    text,
  text        text NOT NULL DEFAULT '',
  segments    jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer,
  cost_usd    numeric,
  status      text NOT NULL DEFAULT 'done',
  raw         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.file_transcripts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_transcripts_select ON public.file_transcripts;
CREATE POLICY file_transcripts_select ON public.file_transcripts
  FOR SELECT TO authenticated USING (public.wassell_can_access_file(file_id, 'view'));
REVOKE ALL ON public.file_transcripts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.file_transcripts FROM authenticated;

-- The file's transcript: the collected-reel transcript when there is one,
-- else our own file transcript. Arabic first, then newest. Same signature and
-- access check as before.
CREATE OR REPLACE FUNCTION public.file_video_transcript(p_file_id uuid)
 RETURNS TABLE(transcript text, language text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.text, t.language FROM (
    SELECT tr.text, tr.language, tr.updated_at
      FROM public.mkt_content_media m
      JOIN public.mkt_transcripts tr ON tr.content_media_id = m.id
     WHERE m.file_id = p_file_id
       AND tr.status = 'done'
       AND btrim(coalesce(tr.text, '')) <> ''
    UNION ALL
    SELECT ft.text, ft.language, ft.updated_at
      FROM public.file_transcripts ft
     WHERE ft.file_id = p_file_id
       AND ft.status = 'done'
       AND btrim(coalesce(ft.text, '')) <> ''
  ) t
  WHERE public.wassell_can_access_file(p_file_id, 'view')
  ORDER BY (t.language = 'ar') DESC NULLS LAST, t.updated_at DESC
  LIMIT 1;
$function$;

COMMIT;
