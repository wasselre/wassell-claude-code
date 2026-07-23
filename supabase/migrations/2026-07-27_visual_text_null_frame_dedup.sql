-- ============================================================================
-- Fix: mkt_visual_text duplicated rows for images/thumbnails on reprocess.
-- Their frame_ts_ms is NULL, and the original UNIQUE(content_media_id, source,
-- frame_ts_ms) treats NULLs as DISTINCT (SQL default), so every reprocess of an
-- image inserted a NEW row instead of updating. Replace the constraint with a
-- NULLS NOT DISTINCT unique index so ON CONFLICT dedups NULL-frame rows too.
-- (mkt_visual_text_upsert's ON CONFLICT (content_media_id, source, frame_ts_ms)
--  matches this index unchanged.)
-- ============================================================================

DELETE FROM public.mkt_visual_text v USING (
  SELECT id, row_number() OVER (PARTITION BY content_media_id, source, COALESCE(frame_ts_ms,-1) ORDER BY created_at DESC, id DESC) AS rn
  FROM public.mkt_visual_text
) d
WHERE v.id = d.id AND d.rn > 1;

ALTER TABLE public.mkt_visual_text DROP CONSTRAINT IF EXISTS mkt_visual_text_content_media_id_source_frame_ts_ms_key;
DROP INDEX IF EXISTS public.mkt_visual_text_content_media_id_source_frame_ts_ms_key;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_visual_text_media_source_frame_uq
  ON public.mkt_visual_text (content_media_id, source, frame_ts_ms) NULLS NOT DISTINCT;
