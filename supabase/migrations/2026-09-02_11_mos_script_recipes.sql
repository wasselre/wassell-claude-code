-- Single, versioned, READ-ONLY source for the video-script recipes.
-- Replaces the drifting copies in api/_lib/marketing/videoScript.ts, the worker
-- copy, client.ts and VideoScriptModal.tsx. No management UI by decision; later
-- management is a UI question, not a migration. Beats are PURPOSES (flexible
-- guidance), never wording templates.
CREATE TABLE IF NOT EXISTS public.mos_script_recipes (
  key                     text PRIMARY KEY,
  label_ar                text NOT NULL,
  label_en                text NOT NULL,
  -- ordered beat purposes, e.g. ["hook","location","feature","feature","product","proof","cta"]
  structure               jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- flexible prose guidance: what each beat must achieve / must not copy
  guidance                text NOT NULL,
  default_duration_sec    int  NOT NULL DEFAULT 45,
  scene_count_hint        int  NOT NULL DEFAULT 7,
  -- which competitor content_type shelves feed retrieval for this recipe
  retrieval_content_types text[] NOT NULL DEFAULT '{}',
  -- fact classes the recipe cannot run without (checked by the facts stage)
  requires_facts          text[] NOT NULL DEFAULT '{}',
  version                 int  NOT NULL DEFAULT 1,
  is_active               boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mos_script_recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mos_script_recipes_read ON public.mos_script_recipes;
CREATE POLICY mos_script_recipes_read ON public.mos_script_recipes
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mos_script_recipes TO authenticated, service_role;

INSERT INTO public.mos_script_recipes
  (key, label_ar, label_en, structure, guidance, default_duration_sec, scene_count_hint, retrieval_content_types, requires_facts, version)
VALUES
  ('walkthrough', 'جولة', 'Walkthrough',
   '["hook","location","feature","feature","product","proof","cta"]',
   'جولة (ميدانية أو رندرات). الخطّاف سؤال أو تنوّع منتجات أو سعر — لا تحية طويلة. ثبّت الموقع مبكراً. مرّ على ٢–٣ مزايا بترتيب الكاتب لا بترتيب ثابت، بأسلوب ودّي طبيعي («ما شاء الله» جائزة). اذكر المساحات والسعر المتاح بصيغة «تبدأ من». أغلق بإشارة ثقة (جاهزية أو ضمانات) ثم دعوة وصل العقارية. البنية دليل للأغراض؛ لا تُعاد الجُمل بين السكربتات.',
   45, 7, '{walkthrough}', '{}', 1),
  ('offer', 'عرض', 'Offer',
   '["hook","offer","proof","cta"]',
   'قصير (~٣٠ ثانية). خطّاف ندرة أو سعر. اعرض العرض كحقيقة من حقائق المشروع (يتطلّب عرضاً أو سعراً متاحاً). إلحاح بلا مواعيد مُختلَقة. دعوة فورية للحجز عبر وصل العقارية.',
   30, 4, '{offer}', '{price}', 1),
  ('rent_vs_own', 'إيجار مقابل تملّك', 'Rent vs own',
   '["hook","comparison","comparison","product","cta"]',
   'لا يحتاج تصويراً. خطّاف «مستأجر؟». قارن شخصين: واحد يستأجر وواحد يتملّك. الرقم الوحيد الجائز هو سعر المشروع الحقيقي؛ الإيجار يبقى وصفياً بلا رقم. الخلاصة أن التملّك أفضل، ثم دعوة وصل العقارية.',
   40, 5, '{offer,walkthrough}', '{price}', 1),
  ('product_explainer', 'شرح المنتج', 'Product explainer',
   '["hook","product","feature","feature","location","cta"]',
   'خطّاف «لماذا هذا المنتج مختلف». الحاجة أو المشكلة، ثم المنتج كحل (المكوّنات والمرافق من الحقائق فقط)، ثم لمن يناسب، ثم دعوة وصل العقارية. لا تكرّر جُمل الجولة.',
   45, 6, '{walkthrough,project_launch}', '{}', 1),
  ('launch', 'إطلاق', 'Launch',
   '["hook","brand","feature","feature","offer","cta"]',
   'خطّاف إعلان. كشف المشروع. ٢–٣ مميزات فارقة من الحقائق. الطرح الأول والسعر فقط إن كان متاحاً. دعوة «كن أول من يحجز» عبر وصل العقارية.',
   40, 6, '{project_launch,teaser}', '{}', 1)
ON CONFLICT (key) DO UPDATE SET
  label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, structure = EXCLUDED.structure,
  guidance = EXCLUDED.guidance, default_duration_sec = EXCLUDED.default_duration_sec,
  scene_count_hint = EXCLUDED.scene_count_hint, retrieval_content_types = EXCLUDED.retrieval_content_types,
  requires_facts = EXCLUDED.requires_facts, version = EXCLUDED.version, updated_at = now();
