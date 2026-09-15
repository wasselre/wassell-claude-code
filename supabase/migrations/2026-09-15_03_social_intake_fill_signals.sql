-- Four fields the bridge left NULL on all 711 intake files, each fillable from
-- what the pipeline already knew:
--   ocr_text / has_text — the OCR sat in mkt_visual_text, so a file was not
--     findable by the words printed on it (a price, a phone number, an offer) —
--     the most searchable thing about a marketing creative.
--   aspect_ratio — the Library filters on it. A browser probe fills it at
--     upload; an intake file never passes through a browser, so it had none.
--     Snapping mirrors snapAspectRatio() in src/lib/files/mediaProbe.ts and
--     worker/src/runSocialFileJob.ts — change all three together.
--   document_type — every image said «صورة معرض», including the 31 plans.
-- dominant_colors / headline_space are deliberately left NULL: those need a
-- pixel read, and the creative lanes own them.
BEGIN;

WITH ocr AS (
  SELECT m.file_id,
         btrim(string_agg(NULLIF(btrim(vt.text), ''), E'\n' ORDER BY vt.frame_ts_ms NULLS FIRST, vt.created_at)) AS txt
    FROM public.mkt_content_media m
    JOIN public.mkt_visual_text vt ON vt.content_media_id = m.id
   WHERE m.file_id IS NOT NULL
   GROUP BY m.file_id
)
UPDATE public.files f
   SET ocr_text = NULLIF(ocr.txt, ''), has_text = (COALESCE(length(ocr.txt), 0) > 0), updated_at = now()
  FROM ocr
 WHERE ocr.file_id = f.id AND f.origin = 'social_intake'
   AND f.ocr_text IS DISTINCT FROM NULLIF(ocr.txt, '');

UPDATE public.files f
   SET has_text = false, updated_at = now()
 WHERE f.origin = 'social_intake' AND f.has_text IS NULL
   AND EXISTS (SELECT 1 FROM public.mkt_content_media m JOIN public.mkt_visual_text vt ON vt.content_media_id = m.id
                WHERE m.file_id = f.id);

WITH snapped AS (
  SELECT f.id,
         COALESCE(
           (SELECT r.label
              FROM (VALUES ('1:1',1.0),('16:9',16.0/9),('9:16',9.0/16),('4:3',4.0/3),('3:4',3.0/4),
                           ('3:2',3.0/2),('2:3',2.0/3),('21:9',21.0/9),('4:5',4.0/5),('5:4',5.0/4),
                           ('2:1',2.0),('1:2',0.5),('16:10',1.6),('10:16',0.625)) AS r(label, ratio)
             WHERE abs((f.width_px::numeric / f.height_px) - r.ratio) / r.ratio <= 0.04
             ORDER BY abs((f.width_px::numeric / f.height_px) - r.ratio)
             LIMIT 1),
           (f.width_px / gcd(f.width_px, f.height_px))::text || ':' || (f.height_px / gcd(f.width_px, f.height_px))::text
         ) AS label
    FROM public.files f
   WHERE f.origin = 'social_intake' AND f.aspect_ratio IS NULL
     AND f.width_px IS NOT NULL AND f.height_px IS NOT NULL AND f.height_px > 0
)
UPDATE public.files f SET aspect_ratio = s.label, updated_at = now()
  FROM snapped s WHERE s.id = f.id;

UPDATE public.files
   SET document_type = 'floor_plan', updated_at = now()
 WHERE origin = 'social_intake' AND primary_category = 'unit_plan' AND document_type <> 'floor_plan';

COMMIT;
