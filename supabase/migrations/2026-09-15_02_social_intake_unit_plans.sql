-- Competitors post FLOOR PLANS inside ordinary carousels. The bridge gave every
-- post image one blanket category, so «رقم الوحدة 01 · المساحة الإجمالية 115.85 م
-- · الدور الأرضي» — a plain unit plan — was filed under «تصميم» (operator, 2026-09-15).
--
-- The pipeline had already READ the words off each image (mkt_visual_text); the
-- classification simply never consulted them. Discriminator: a FLOOR LABEL or a
-- UNIT/VILLA NUMBER — not room names, since a spec poster lists «غرفة خادمة ·
-- مطبخ» as selling points while being a poster. «رقم الغيلا» is included because
-- that is how the OCR renders «رقم الفيلا» on several real plans.
-- 31 of 421 images reclassified. Mirrored in worker/src/runSocialFileJob.ts
-- (looksLikeUnitPlan) so new posts arrive classified.
UPDATE public.files f
   SET primary_category = 'unit_plan', updated_at = now()
  FROM public.mkt_content_media m
  JOIN public.mkt_visual_text vt ON vt.content_media_id = m.id
 WHERE m.file_id = f.id
   AND f.origin = 'social_intake'
   AND f.kind = 'image'
   AND f.primary_category <> 'unit_plan'
   AND (vt.text ~ 'الدور الأرضي|الدور الارضي|الدور الأول|الدور الاول|الدور الثاني|الدور الثانى|GROUND FLOOR|FIRST FLOOR|SECOND FLOOR'
     OR vt.text ~ 'رقم الوحدة|رقم الفيلا|رقم الغيلا|رقم الشقة|رقم النموذج'
     OR vt.text ~ 'مخطط');
