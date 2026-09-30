-- ============================================================================
-- Video frames reach the OCR lane (2026-09-30)
-- ----------------------------------------------------------------------------
-- Measured 2026-09-30: of 1,406 stored competitor videos, 1,167 had their
-- on-screen text read from the COVER picture only and 237 from sampled frames.
-- Cause: the content sweep OCRs a post's cover on the subscription lane first
-- (stage 2); full processing (stage 3) then sees "this post already has visual
-- text" and skips the paid vision call — which is where the six sampled video
-- frames were. Price, offer and phone overlays live in those frames.
--
-- Frames now get their own queue, read by the SAME subscription OCR lane:
--   worker  content_process {mode:'frames_only'}  → samples 6 frames, stores
--           them, one mkt_video_frames row each (or ONE failure marker row)
--   sweep   mkt_videos_needing_frames()  → enqueues those jobs, a few per tick
--           mkt_video_frames_pending()   → batches pending frames into
--                                          claude_jobs(mkt_visual_ocr {frame_ids})
--   runner  reads the frames, writes mkt_visual_text against the VIDEO's media
--           row (source 'frame', frame_ts_ms) — the exact shape the paid path
--           already writes, so no reader changes — then mkt_video_frames_finish()
--           re-checks the post's project match once all its frames are read.
--
-- Frames are NOT mkt_content_media rows: sixteen functions read that table
-- (Content Library, Files bridge, design reads, storage usage…) and a new media
-- kind would leak stills into every one of them.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.mkt_video_frames (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_media_id uuid NOT NULL REFERENCES public.mkt_content_media(id) ON DELETE CASCADE,
  content_post_id  uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  -- position in the video; -1 = a failure marker ("frames could not be taken"),
  -- which stops the sweep re-trying a video that can never yield frames
  frame_ts_ms      integer NOT NULL,
  bucket           text,
  path             text,
  stored_url       text,
  ocr_status       text NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending', 'done', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  failure          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_media_id, frame_ts_ms)
);
CREATE INDEX IF NOT EXISTS mkt_video_frames_pending_idx
  ON public.mkt_video_frames (content_post_id, frame_ts_ms) WHERE ocr_status = 'pending';
CREATE INDEX IF NOT EXISTS mkt_video_frames_post_idx ON public.mkt_video_frames (content_post_id);
ALTER TABLE public.mkt_video_frames ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mkt_video_frames FROM anon, authenticated;
COMMENT ON TABLE public.mkt_video_frames IS
  'Still frames sampled from a stored competitor video, waiting for (or done with) OCR on the subscription lane. Service role only. Text lands in mkt_visual_text against the video media row.';

-- Posts with a stored video whose frames have never been taken.
CREATE OR REPLACE FUNCTION public.mkt_videos_needing_frames(p_limit integer DEFAULT 40)
RETURNS TABLE (content_post_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT DISTINCT m.content_post_id
    FROM public.mkt_content_media m
   WHERE m.media_kind = 'video' AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.mkt_visual_text v
                      WHERE v.content_media_id = m.id AND v.source = 'frame')
     AND NOT EXISTS (SELECT 1 FROM public.mkt_video_frames f WHERE f.content_media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.mkt_collection_jobs j
                      WHERE j.kind = 'content_process' AND j.status IN ('queued', 'running')
                        AND j.params->>'content_post_id' = m.content_post_id::text)
   LIMIT GREATEST(0, p_limit);
$$;

-- Pending frames not already inside a queued/running OCR job. Ordered by post
-- so a batch reads whole videos rather than one frame from each of 24.
CREATE OR REPLACE FUNCTION public.mkt_video_frames_pending(p_limit integer DEFAULT 24)
RETURNS TABLE (id uuid, content_post_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT f.id, f.content_post_id
    FROM public.mkt_video_frames f
   WHERE f.ocr_status = 'pending' AND f.frame_ts_ms >= 0
     AND NOT EXISTS (SELECT 1 FROM public.claude_jobs j
                      WHERE j.kind = 'mkt_visual_ocr' AND j.status IN ('pending', 'running')
                        AND j.payload->'frame_ids' ? f.id::text)
   ORDER BY f.content_post_id, f.frame_ts_ms
   LIMIT GREATEST(0, p_limit);
$$;

-- Close out a batch. A frame that could not be read is retried twice, then
-- marked failed (no uncapped retry of a session-costing read). Once a post has
-- no pending frame left, its project match is re-checked from the fuller text —
-- the free narrow-only pass, never for a post a person locked.
CREATE OR REPLACE FUNCTION public.mkt_video_frames_finish(p_done uuid[], p_unread uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_requeued integer := 0; v_max integer;
BEGIN
  UPDATE public.mkt_video_frames
     SET ocr_status = 'done', failure = NULL, updated_at = now()
   WHERE id = ANY (coalesce(p_done, '{}'::uuid[])) AND ocr_status = 'pending';

  UPDATE public.mkt_video_frames
     SET attempts = attempts + 1,
         ocr_status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
         failure = CASE WHEN attempts + 1 >= 3 THEN 'not read after 3 OCR attempts' ELSE failure END,
         updated_at = now()
   WHERE id = ANY (coalesce(p_unread, '{}'::uuid[])) AND ocr_status = 'pending';

  SELECT coalesce((SELECT (value)::int FROM public.mkt_settings WHERE key = 'max_attempts'), 5) INTO v_max;

  WITH touched AS (
    SELECT DISTINCT f.content_post_id AS post_id
      FROM public.mkt_video_frames f
     WHERE f.id = ANY (coalesce(p_done, '{}'::uuid[]) || coalesce(p_unread, '{}'::uuid[]))
  ), ready AS (
    SELECT t.post_id, cp.organization_id
      FROM touched t
      JOIN public.mkt_content_posts cp ON cp.id = t.post_id
      JOIN public.mkt_content_enrichment e ON e.content_post_id = cp.id
     WHERE NOT EXISTS (SELECT 1 FROM public.mkt_video_frames f
                        WHERE f.content_post_id = t.post_id AND f.ocr_status = 'pending')
       AND EXISTS (SELECT 1 FROM public.mkt_video_frames f
                    WHERE f.content_post_id = t.post_id AND f.ocr_status = 'done')
       AND cp.processing_status IN ('processed', 'partial', 'awaiting_intelligence')
       AND cp.availability = 'available'
       AND e.attribution_locked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.mkt_collection_jobs j
                        WHERE j.kind = 'content_process' AND j.status IN ('queued', 'running')
                          AND j.params->>'content_post_id' = t.post_id::text)
  ), ins AS (
    INSERT INTO public.mkt_collection_jobs (kind, provider, social_account_id, params, priority, max_attempts, requested_by, fallback_of)
    SELECT 'content_process', 'internal', NULL,
           jsonb_build_object('content_post_id', r.post_id, 'organization_id', r.organization_id,
                              'from', 'video_frames_ocr', 'mode', 'narrow_only'),
           40, v_max, NULL, NULL
      FROM ready r
    RETURNING 1
  )
  SELECT count(*) INTO v_requeued FROM ins;
  RETURN v_requeued;
END $$;

REVOKE ALL ON FUNCTION public.mkt_videos_needing_frames(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mkt_video_frames_pending(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mkt_video_frames_finish(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_videos_needing_frames(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_video_frames_pending(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_video_frames_finish(uuid[], uuid[]) TO service_role;

COMMIT;
