/**
 * Post Creative Director — shared bilingual label maps for the creative tab.
 *
 * One module, never inline strings in JSX: every controlled vocabulary the
 * panels render (placement types, AI modes, rights, natures, ref aspects…)
 * resolves through these maps with a raw-slug fallback.
 */
import type {
  AcquisitionSource, AiMode, AiRecommendationStatus, AssetNature, AssetUsage,
  IntendedUse, PackageStatus, PlacementType, ProductionState, RefAspect, RefKind,
  TargetKind, UsageRights,
} from '@/lib/creative/contracts';
import { PLATFORM_LABELS } from '@/lib/marketingOS/client';

export type Lbl = { ar: string; en: string };

export const pick = (map: Record<string, Lbl>, key: string | null | undefined, isAr: boolean): string => {
  if (!key) return '—';
  const m = map[key];
  return m ? (isAr ? m.ar : m.en) : key;
};

export const platformLabel = (platform: string, isAr: boolean): string =>
  pick(PLATFORM_LABELS, platform, isAr);

export const PLACEMENT_LABELS: Record<PlacementType, Lbl> = {
  feed:        { ar: 'منشور خلاصة', en: 'Feed post' },
  carousel:    { ar: 'كاروسيل', en: 'Carousel' },
  story:       { ar: 'ستوري', en: 'Story' },
  reel_cover:  { ar: 'غلاف ريل', en: 'Reel cover' },
  photo_mode:  { ar: 'وضع الصور', en: 'Photo mode' },
  post:        { ar: 'منشور', en: 'Post' },
  ad_feed:     { ar: 'إعلان خلاصة', en: 'Feed ad' },
  ad_story:    { ar: 'إعلان ستوري', en: 'Story ad' },
  ad_carousel: { ar: 'إعلان كاروسيل', en: 'Carousel ad' },
  ad_reels:    { ar: 'إعلان ريلز', en: 'Reels ad' },
  ad_display:  { ar: 'إعلان عرضي', en: 'Display ad' },
};

export const TARGET_KIND_LABELS: Record<TargetKind, Lbl> = {
  organic: { ar: 'عضوي', en: 'Organic' },
  paid:    { ar: 'مدفوع', en: 'Paid' },
};

export const INTENDED_USE_LABELS: Record<IntendedUse, Lbl> = {
  organic: { ar: 'عضوي', en: 'Organic' },
  paid:    { ar: 'مدفوع', en: 'Paid' },
  both:    { ar: 'عضوي + مدفوع', en: 'Organic + paid' },
};

export const PACKAGE_STATUS_LABELS: Record<PackageStatus, Lbl> = {
  draft:      { ar: 'مسودة', en: 'Draft' },
  applied:    { ar: 'مُطبَّقة', en: 'Applied' },
  superseded: { ar: 'حلّت محلها نسخة أحدث', en: 'Superseded' },
  rejected:   { ar: 'مرفوضة', en: 'Rejected' },
};

export const AI_MODE_LABELS: Record<AiMode, Lbl> = {
  cleanup:           { ar: 'تنظيف', en: 'Cleanup' },
  crop:              { ar: 'قصّ', en: 'Crop' },
  color_correct:     { ar: 'تصحيح ألوان', en: 'Color correct' },
  extend_background: { ar: 'تمديد الخلفية', en: 'Extend background' },
  remove_clutter:    { ar: 'إزالة تشويش', en: 'Remove clutter' },
  combine:           { ar: 'دمج أصول', en: 'Combine assets' },
  supporting_visual: { ar: 'مرئي مساند', en: 'Supporting visual' },
  remove_text:       { ar: 'إزالة نص', en: 'Remove text' },
  request_photo:     { ar: 'طلب صورة', en: 'Request photo' },
};

export const AI_STATUS_LABELS: Record<AiRecommendationStatus, Lbl> = {
  recommended: { ar: 'مقترح', en: 'Recommended' },
  approved:    { ar: 'معتمد للتنفيذ', en: 'Approved' },
  queued:      { ar: 'في الطابور', en: 'Queued' },
  running:     { ar: 'قيد التنفيذ', en: 'Running' },
  completed:   { ar: 'مكتمل', en: 'Completed' },
  failed:      { ar: 'فشل', en: 'Failed' },
  dismissed:   { ar: 'مستبعد', en: 'Dismissed' },
};

export const USAGE_RIGHTS_LABELS: Record<UsageRights, Lbl> = {
  approved:              { ar: 'معتمدة', en: 'Approved' },
  use_after_edit:        { ar: 'تُستخدم بعد التعديل', en: 'Use after edit' },
  attribution_required:  { ar: 'تتطلب نسبة', en: 'Attribution required' },
  internal_only:         { ar: 'داخلية فقط', en: 'Internal only' },
  restricted:            { ar: 'مقيّدة', en: 'Restricted' },
  do_not_use:            { ar: 'ممنوعة', en: 'Do not use' },
  needs_review:          { ar: 'تحتاج مراجعة', en: 'Needs review' },
};

export const ASSET_NATURE_LABELS: Record<AssetNature, Lbl> = {
  real:           { ar: 'صورة حقيقية', en: 'Real' },
  ai_generated:   { ar: 'مُولّدة بالذكاء', en: 'AI-generated' },
  ai_edited:      { ar: 'مُعدّلة بالذكاء', en: 'AI-edited' },
  cgi_render:     { ar: 'تصيير CGI', en: 'CGI render' },
  graphic_design: { ar: 'تصميم جرافيك', en: 'Graphic design' },
  screenshot:     { ar: 'لقطة شاشة', en: 'Screenshot' },
};

export const ACQUISITION_LABELS: Record<AcquisitionSource, Lbl> = {
  developer:  { ar: 'من المطوّر', en: 'Developer' },
  internal:   { ar: 'داخلية', en: 'Internal' },
  competitor: { ar: 'منافس', en: 'Competitor' },
  client:     { ar: 'عميل', en: 'Client' },
  partner:    { ar: 'شريك', en: 'Partner' },
  public:     { ar: 'عامة', en: 'Public' },
  unknown:    { ar: 'غير معروف', en: 'Unknown' },
};

export const PRODUCTION_STATE_LABELS: Record<ProductionState, Lbl> = {
  raw:       { ar: 'خام', en: 'Raw' },
  edited:    { ar: 'معدّلة', en: 'Edited' },
  final:     { ar: 'نهائية', en: 'Final' },
  published: { ar: 'منشورة', en: 'Published' },
};

export const ASSET_USAGE_LABELS: Record<AssetUsage, Lbl> = {
  direct:         { ar: 'كما هي', en: 'As-is' },
  crop:           { ar: 'قصّ', en: 'Crop' },
  retouch:        { ar: 'رتوش', en: 'Retouch' },
  color_correct:  { ar: 'تصحيح ألوان', en: 'Color correct' },
  ai_edit:        { ar: 'تعديل بالذكاء', en: 'AI edit' },
  ai_extend:      { ar: 'تمديد بالذكاء', en: 'AI extend' },
  combine:        { ar: 'دمج', en: 'Combine' },
  reference_only: { ar: 'مرجع فقط', en: 'Reference only' },
};

export const REF_KIND_LABELS: Record<RefKind, Lbl> = {
  competitor_post:  { ar: 'منشور منافس', en: 'Competitor post' },
  competitor_media: { ar: 'وسيط منافس', en: 'Competitor media' },
  wassel_content:   { ar: 'محتوى وصل', en: 'Wassel content' },
  wassel_file:      { ar: 'ملف وصل', en: 'Wassel file' },
  file:             { ar: 'ملف', en: 'File' },
};

export const REF_ASPECT_LABELS: Record<RefAspect, Lbl> = {
  composition:        { ar: 'التكوين', en: 'Composition' },
  hierarchy:          { ar: 'التسلسل', en: 'Hierarchy' },
  colors:             { ar: 'الألوان', en: 'Colors' },
  carousel_structure: { ar: 'بنية الكاروسيل', en: 'Carousel structure' },
  typography:         { ar: 'الخطوط', en: 'Typography' },
  image_treatment:    { ar: 'معالجة الصورة', en: 'Image treatment' },
  cta:                { ar: 'الدعوة لإجراء', en: 'CTA' },
  copy_structure:     { ar: 'بنية النص', en: 'Copy structure' },
  density:            { ar: 'الكثافة', en: 'Density' },
  branding:           { ar: 'الهوية', en: 'Branding' },
  other:              { ar: 'أخرى', en: 'Other' },
};

export const SLIDE_ROLE_LABELS: Record<string, Lbl> = {
  cover:     { ar: 'غلاف', en: 'Cover' },
  feature:   { ar: 'ميزة', en: 'Feature' },
  specs:     { ar: 'مواصفات', en: 'Specs' },
  offer:     { ar: 'عرض', en: 'Offer' },
  location:  { ar: 'الموقع', en: 'Location' },
  proof:     { ar: 'إثبات', en: 'Proof' },
  lifestyle: { ar: 'نمط حياة', en: 'Lifestyle' },
  cta:       { ar: 'دعوة', en: 'CTA' },
  brand:     { ar: 'هوية', en: 'Brand' },
  other:     { ar: 'أخرى', en: 'Other' },
};

export const IMAGE_CHANGE_LABELS: Record<string, Lbl> = {
  none:    { ar: 'بلا تغيير', en: 'No change' },
  crop:    { ar: 'قصّ', en: 'Crop' },
  extend:  { ar: 'تمديد', en: 'Extend' },
  replace: { ar: 'استبدال', en: 'Replace' },
};

export const JOB_KIND_LABELS: Record<string, Lbl> = {
  post_concepts:    { ar: 'اقتراح الأفكار', en: 'Concepts' },
  post_package:     { ar: 'بناء الحزمة', en: 'Package' },
  post_regenerate:  { ar: 'إعادة التوليد', en: 'Regenerate' },
  post_derivatives: { ar: 'المشتقات', en: 'Derivatives' },
};

export const JOB_STAGE_LABELS: Record<string, Lbl> = {
  brief:      { ar: 'الموجز', en: 'Brief' },
  facts:      { ar: 'الحقائق', en: 'Facts' },
  brand:      { ar: 'الهوية', en: 'Brand kit' },
  references: { ar: 'المراجع', en: 'References' },
  assets:     { ar: 'الأصول', en: 'Assets' },
  targets:    { ar: 'الأهداف', en: 'Targets' },
  concepts:   { ar: 'الأفكار', en: 'Concepts' },
  package:    { ar: 'الحزمة', en: 'Package' },
  derivatives:{ ar: 'المشتقات', en: 'Derivatives' },
  validate:   { ar: 'التحقق', en: 'Validate' },
  persist:    { ar: 'الحفظ', en: 'Persist' },
};
