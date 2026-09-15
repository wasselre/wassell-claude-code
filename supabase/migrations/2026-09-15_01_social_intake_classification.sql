-- Social-intake files were filed as raw_photo / raw_video with asset_nature
-- 'real'. Both were wrong:
--   * a competitor's published reel or post image is a FINISHED creative
--     (logo, captions, colour grade), not unedited source material. 711 of them
--     buried the real raw pool — 278 photos and 2 videos — under other
--     companies' finished work, so "find me raw footage" returned their ads.
--     Correct values: design (image) / ready_video (video).
--   * asset_nature 'real' was asserted with no basis; off-plan marketing is
--     frequently a CGI render. An empty field is honest, and the visual
--     intelligence read can fill it later.
-- production_state 'published' was right and is untouched.
-- Pre-change values: public._backup_social_intake_classification_20260915.
UPDATE public.files
   SET primary_category = CASE WHEN kind = 'video' THEN 'ready_video' ELSE 'design' END,
       asset_nature = NULL,
       updated_at = now()
 WHERE origin = 'social_intake'
   AND (primary_category IN ('raw_photo','raw_video') OR asset_nature = 'real');
