-- ============================================================================
-- TikTok photo posts are not videos (2026-09-30)
-- ----------------------------------------------------------------------------
-- Running the video recovery (2026-09-30_05) returned a file for 6 of 175
-- "missing videos". The other 169 are PHOTO posts ("slideshows": isSlideshow =
-- true, duration 0, slideshowImageLinks[]). The parser called every TikTok item
-- a video, so each got a video row marked failed and its pictures were never
-- stored or read. The worker now stores the slides as images; this migration
-- corrects the rows already collected:
--   * post_type  video → image / carousel (from the newest raw payload)
--   * the false "failed video" media row is removed
--   * mkt_tiktok_videos_missing only offers real videos, so the recovery never
--     buys a download pass for a photo post again.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

CREATE TEMP TABLE _tt_photo ON COMMIT DROP AS
SELECT p.id, CASE WHEN jsonb_array_length(l.payload->'slideshowImageLinks') > 1 THEN 'carousel' ELSE 'image' END AS new_type
  FROM public.mkt_content_posts p
  CROSS JOIN LATERAL (SELECT r.payload FROM public.mkt_raw_ingestions r
                       WHERE r.external_identity = p.external_id ORDER BY r.created_at DESC LIMIT 1) l
 WHERE p.platform = 'tiktok' AND p.post_type = 'video'
   AND l.payload->>'isSlideshow' = 'true'
   AND jsonb_typeof(l.payload->'slideshowImageLinks') = 'array'
   AND jsonb_array_length(l.payload->'slideshowImageLinks') > 0;

UPDATE public.mkt_content_posts p SET post_type = t.new_type, updated_at = now()
  FROM _tt_photo t WHERE t.id = p.id;

DELETE FROM public.mkt_content_media m USING _tt_photo t
 WHERE m.content_post_id = t.id AND m.media_kind = 'video' AND m.download_status = 'failed';

CREATE OR REPLACE FUNCTION public.mkt_tiktok_videos_missing(p_account uuid, p_limit integer DEFAULT 25, p_max_attempts integer DEFAULT 3)
RETURNS TABLE (post_id uuid, external_id text, post_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p.id, p.external_id, p.post_url
    FROM public.mkt_content_posts p
    JOIN public.mkt_content_media m
      ON m.content_post_id = p.id AND m.media_kind = 'video' AND m.download_status = 'failed'
   WHERE p.platform = 'tiktok'
     AND p.post_type = 'video'          -- a photo post has no file to fetch
     AND p.social_account_id = p_account
     AND p.availability = 'available'
     AND nullif(p.post_url, '') IS NOT NULL
     AND m.redownload_attempts < GREATEST(1, p_max_attempts)
     AND NOT EXISTS (SELECT 1 FROM public.mkt_content_media s
                      WHERE s.content_post_id = p.id AND s.media_kind = 'video' AND s.download_status = 'stored')
   ORDER BY m.redownload_attempts, p.published_at DESC NULLS LAST, p.id
   LIMIT GREATEST(0, p_limit);
$$;

COMMIT;
