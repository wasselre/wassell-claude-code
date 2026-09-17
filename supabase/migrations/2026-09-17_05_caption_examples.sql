-- ============================================================================
-- Ten competitor captions the caption AI learns from. 2026-09-17.
--
-- Operator ask: "capture the best 10 captions so the AI could learn from those
-- captions ... very simple." No scoring pipeline — ten rows, shown to the model
-- as style examples in BOTH caption writers:
--   · api/_lib/marketing/planning/content.ts  (post caption, «توليد بالذكاء»)
--   · worker/src/runMetaAdJob.ts             (Meta ad caption)
--
-- Chosen from mkt_content_posts on 2026-09-17 by engagement
-- (likes + 3×comments + 4×saves + 4×shares), at most two per account, selling
-- posts only — occasion poems (national / founding day), hashtag-only posts and
-- corporate news were skipped. Phone numbers, URLs and the English halves of
-- bilingual captions were removed so the model never copies a rival's contact
-- details. Swapping an example is a data edit: update or replace a row.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.mos_caption_examples (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position       int  NOT NULL,
  caption        text NOT NULL CHECK (length(btrim(caption)) > 0),
  source_handle  text,
  source_post_id uuid REFERENCES public.mkt_content_posts(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mos_caption_examples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mos_caption_examples_read ON public.mos_caption_examples;
CREATE POLICY mos_caption_examples_read ON public.mos_caption_examples
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.mos_caption_examples FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.mos_caption_examples FROM authenticated;

INSERT INTO public.mos_caption_examples (position, caption, source_handle, source_post_id)
SELECT v.position, v.caption, v.handle, (SELECT p.id FROM public.mkt_content_posts p WHERE p.id = v.post_id)
  FROM (VALUES
  (1, E'ارتقِ بطموحات عائلتك في الماجدية 147، في حي النرجس الراقي شمال الرياض، حيث تجد مجتمعًا متكاملًا بالمرافق والخدمات التي تلبي جميع احتياجات الحياة الأساسية والترفيهية.\n\nاحجز الآن\n\n#مجتمع_متكامل #عقارات',
      'almajdiah', 'a15453c1-3f88-4632-ad1a-b11d1d83c8c9'::uuid),
  (2, E'حي المربّع 📍.. مشروع حديث بهوية سعودية في قلب الرياض. 🇸🇦\nيجمع بين الفخامة، والتصميم المتطور، وأصالة المكان. ✨\nلتفاصيل أكثر تواصلوا معنا.',
      'alajlan_riviera', '8f9a3bf4-b9db-4c0d-a08f-44e0538525a5'::uuid),
  (3, E'حيث إن رفاه المسكن ليس ترفًا،\nبل حياةٌ يُستقرّ بها…\nومن المسكن تبدأ الرواية.',
      'alajlan_riviera', '0b1d157c-66be-4447-9699-fd5052972e08'::uuid),
  (4, E'🏙️ في قلب الرياض - حي المربع\nامتلك وحدتك السكنية في موقع استثنائي يجمع بين الفخامة والحيوية.\nبداية من دفعة أولى: 298,500 ريال فقط\n📍 موقع مركزي | تصميم عصري | مرافق متكاملة',
      'alajlan_riviera', 'f811e139-ca12-4e5a-a43e-c8144a153964'::uuid),
  (5, E'تملّك الرفاهية الآن – حي الصفا\n✨ أسلوب حياة راقٍ وموقع يليق بك، بأسعار تبدأ من 575,000 ريال فقط.\n📍 موقع مميز | تصميم عصري | خدمات متكاملة',
      'alajlan_riviera', '1e28570f-1665-437e-a2db-27bc491f27f7'::uuid),
  (6, E'تاون هاوس ديارا مشارف\n\nمساحات تخدمك، يتميز المشروع بموقعه في بيئة سكنية حديثة وهادئة مع سهولة الوصول إلى الطرق الرئيسية بحي النرجس ضمن مخطط مشارف هيلز.\n\nسجّل اهتمامك معنا',
      'riva_aqar', 'b2fab055-6f7c-4a38-b16c-e1085c8c5e22'::uuid),
  (7, E'ساندستون ريزيدنسيز ..\nسكن عملي بتصميم متقن،\nوموقع يسهّل يومك.',
      'riva_aqar', '7f0bf47e-3553-4725-9afe-57f96757336d'::uuid),
  (8, E'إلوڤي يقدم تجربة عصرية في حي النخيل شمال الرياض، حيث يلتقي الموقع الاستراتيجي مع التخطيط المدروس وسهولة الوصول إلى تفاصيل الحياة اليومية.\n\nصُمم المشروع لمن يبحث عن فرصة تملك في موقع حيوي، يمنح قربًا من حركة المدينة، وتجربة أكثر راحة وتنظيمًا.\n\nإلوڤي ليس مجرد مشروع جديد، بل حضور في أحد أبرز مواقع الرياض، حيث تبدأ القيمة من الموقع، وتستمر مع الوقت.',
      'zoodrealty', 'fb88e2bf-4899-4a4c-9a3c-541129f2436e'::uuid),
  (9, E'سكن واستثمار ورفاهية كلها في مكان واحد\nفي أرقى أحياء الرياض (جنوب طريق الملك سلمان)\nيمام للاستثمار تقدم لك «تاون هاوس بالنرجس»\nللتفاصيل والاستفسار زوروا الموقع في البايو',
      'yamam_inv', '72c12f20-3ec4-4a30-9cd7-63bc7d5ac59e'::uuid),
  (10, E'ديارا مشارف ..\nمشروع تاون هاوس صُمم لراحة العائلة،\nبتفاصيل عملية، ومساحات تعطيك إحساس الرحابة بكل زاوية.',
      'riva_aqar', '29d5b5aa-c167-4554-aa8e-be2452e6a680'::uuid)
  ) AS v(position, caption, handle, post_id)
 WHERE NOT EXISTS (SELECT 1 FROM public.mos_caption_examples);

COMMIT;
