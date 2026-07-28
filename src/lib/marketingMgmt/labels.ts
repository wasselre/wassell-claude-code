/**
 * Bilingual labels for every marketing-management enum.
 *
 * The page previously rendered raw snake_case English — `tiktok_video`,
 * `lead_generation`, `b_roll` — inside an Arabic RTL interface. STATUS_LABEL
 * existed for statuses and nothing else, so everything else leaked the database
 * vocabulary to the user.
 *
 * `lbl()` falls back to the raw key rather than blanking, so a value added to a
 * CHECK constraint before it is added here still renders something a person can
 * read and report, instead of an empty cell.
 */
export interface Bi { ar: string; en: string }

export const pick = (b: Bi | undefined, isAr: boolean, fallback: string): string =>
  b ? (isAr ? b.ar : b.en) : fallback;

/** Look a key up in a map, falling back to the key itself. */
export const lbl = (map: Record<string, Bi>, key: string | null | undefined, isAr: boolean): string =>
  key ? pick(map[key], isAr, key) : '—';

export const CONTENT_TYPE_LABEL: Record<string, Bi> = {
  reel:                 { ar: 'ريل', en: 'Reel' },
  tiktok_video:         { ar: 'فيديو تيك توك', en: 'TikTok video' },
  snapchat_video:       { ar: 'فيديو سناب', en: 'Snapchat video' },
  snapchat_story:       { ar: 'قصة سناب', en: 'Snapchat story' },
  instagram_story:      { ar: 'قصة إنستغرام', en: 'Instagram story' },
  static_image:         { ar: 'صورة ثابتة', en: 'Static image' },
  carousel:             { ar: 'كاروسيل', en: 'Carousel' },
  infographic:          { ar: 'إنفوجرافيك', en: 'Infographic' },
  long_form_video:      { ar: 'فيديو طويل', en: 'Long-form video' },
  paid_video_ad:        { ar: 'إعلان فيديو مدفوع', en: 'Paid video ad' },
  paid_image_ad:        { ar: 'إعلان صورة مدفوع', en: 'Paid image ad' },
  project_announcement: { ar: 'إعلان مشروع', en: 'Project announcement' },
  testimonial:          { ar: 'شهادة عميل', en: 'Testimonial' },
  construction_update:  { ar: 'تحديث إنشائي', en: 'Construction update' },
  educational:          { ar: 'محتوى تعليمي', en: 'Educational' },
  floor_plan:           { ar: 'مخطط', en: 'Floor plan' },
  property_tour:        { ar: 'جولة عقارية', en: 'Property tour' },
  drone_video:          { ar: 'تصوير جوي', en: 'Drone video' },
  presenter_video:      { ar: 'فيديو بمقدّم', en: 'Presenter video' },
  ai_video:             { ar: 'فيديو بالذكاء الاصطناعي', en: 'AI video' },
  motion_graphics:      { ar: 'موشن جرافيك', en: 'Motion graphics' },
  custom:               { ar: 'مخصص', en: 'Custom' },
};

export const PURPOSE_LABEL: Record<string, Bi> = {
  awareness:       { ar: 'وعي بالعلامة', en: 'Awareness' },
  engagement:      { ar: 'تفاعل', en: 'Engagement' },
  lead_generation: { ar: 'جذب عملاء', en: 'Lead generation' },
  retargeting:     { ar: 'إعادة استهداف', en: 'Retargeting' },
  branding:        { ar: 'هوية وعلامة', en: 'Branding' },
  education:       { ar: 'تثقيف', en: 'Education' },
  conversion:      { ar: 'تحويل', en: 'Conversion' },
  project_launch:  { ar: 'إطلاق مشروع', en: 'Project launch' },
  offer_promotion: { ar: 'ترويج عرض', en: 'Offer promotion' },
  investor:        { ar: 'مستثمرين', en: 'Investor' },
};

export const PRIORITY_LABEL: Record<string, Bi> = {
  low:    { ar: 'منخفضة', en: 'Low' },
  normal: { ar: 'عادية', en: 'Normal' },
  high:   { ar: 'عالية', en: 'High' },
  urgent: { ar: 'عاجلة', en: 'Urgent' },
};

export const ORGANIC_PAID_LABEL: Record<string, Bi> = {
  organic: { ar: 'عضوي', en: 'Organic' },
  paid:    { ar: 'مدفوع', en: 'Paid' },
  boosted: { ar: 'مموّل جزئياً', en: 'Boosted' },
};

export const FUNNEL_STAGE_LABEL: Record<string, Bi> = {
  awareness:     { ar: 'وعي', en: 'Awareness' },
  consideration: { ar: 'مفاضلة', en: 'Consideration' },
  decision:      { ar: 'قرار', en: 'Decision' },
  retention:     { ar: 'ولاء', en: 'Retention' },
};

export const CTA_DESTINATION_LABEL: Record<string, Bi> = {
  whatsapp:     { ar: 'واتساب', en: 'WhatsApp' },
  landing_page: { ar: 'صفحة هبوط', en: 'Landing page' },
  website:      { ar: 'الموقع', en: 'Website' },
  phone_call:   { ar: 'اتصال هاتفي', en: 'Phone call' },
  instagram_dm: { ar: 'رسالة إنستغرام', en: 'Instagram DM' },
  form:         { ar: 'نموذج', en: 'Form' },
  profile:      { ar: 'الحساب', en: 'Profile' },
  none:         { ar: 'بلا دعوة', en: 'No CTA' },
};

export const LANGUAGE_LABEL: Record<string, Bi> = {
  ar:   { ar: 'عربي', en: 'Arabic' },
  en:   { ar: 'إنجليزي', en: 'English' },
  both: { ar: 'الاثنان', en: 'Both' },
};

export const PLATFORM_LABEL: Record<string, Bi> = {
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  tiktok:    { ar: 'تيك توك', en: 'TikTok' },
  youtube:   { ar: 'يوتيوب', en: 'YouTube' },
  snapchat:  { ar: 'سناب شات', en: 'Snapchat' },
  x:         { ar: 'إكس', en: 'X' },
  facebook:  { ar: 'فيسبوك', en: 'Facebook' },
  linkedin:  { ar: 'لينكدإن', en: 'LinkedIn' },
  whatsapp:  { ar: 'واتساب', en: 'WhatsApp' },
  website:   { ar: 'الموقع', en: 'Website' },
};

export const SCENE_TYPE_LABEL: Record<string, Bi> = {
  presenter:        { ar: 'مقدّم', en: 'Presenter' },
  b_roll:           { ar: 'لقطات مساندة', en: 'B-roll' },
  drone:            { ar: 'تصوير جوي', en: 'Drone' },
  ai_visual:        { ar: 'مشهد بالذكاء الاصطناعي', en: 'AI visual' },
  animation:        { ar: 'أنيميشن', en: 'Animation' },
  screen_recording: { ar: 'تسجيل شاشة', en: 'Screen recording' },
  property_shot:    { ar: 'لقطة عقار', en: 'Property shot' },
  floor_plan:       { ar: 'مخطط', en: 'Floor plan' },
  text_only:        { ar: 'نص فقط', en: 'Text only' },
  testimonial:      { ar: 'شهادة عميل', en: 'Testimonial' },
  custom:           { ar: 'مخصص', en: 'Custom' },
};

export const SLIDE_TYPE_LABEL: Record<string, Bi> = {
  cover:       { ar: 'غلاف', en: 'Cover' },
  content:     { ar: 'محتوى', en: 'Content' },
  comparison:  { ar: 'مقارنة', en: 'Comparison' },
  feature:     { ar: 'ميزة', en: 'Feature' },
  offer:       { ar: 'عرض', en: 'Offer' },
  testimonial: { ar: 'شهادة عميل', en: 'Testimonial' },
  cta:         { ar: 'دعوة إجراء', en: 'Call to action' },
  custom:      { ar: 'مخصص', en: 'Custom' },
};

export const VERSION_TYPE_LABEL: Record<string, Bi> = {
  brief:            { ar: 'الموجز', en: 'Brief' },
  script:           { ar: 'السيناريو', en: 'Script' },
  caption:          { ar: 'التعليق', en: 'Caption' },
  post_design:      { ar: 'تصميم المنشور', en: 'Post design' },
  carousel_design:  { ar: 'تصميم الكاروسيل', en: 'Carousel design' },
  video_edit:       { ar: 'مونتاج', en: 'Video edit' },
  platform_variant: { ar: 'نسخة منصة', en: 'Platform variant' },
  final:            { ar: 'النسخة النهائية', en: 'Final' },
  published:        { ar: 'المنشور', en: 'Published' },
};

export const PUBLICATION_STATUS_LABEL: Record<string, Bi> = {
  draft:     { ar: 'مسودة', en: 'Draft' },
  scheduled: { ar: 'مجدول', en: 'Scheduled' },
  publishing:{ ar: 'قيد النشر', en: 'Publishing' },
  published: { ar: 'منشور', en: 'Published' },
  failed:    { ar: 'فشل', en: 'Failed' },
  cancelled: { ar: 'ملغي', en: 'Cancelled' },
};

export const ASSET_TYPE_LABEL: Record<string, Bi> = {
  photo:            { ar: 'صورة', en: 'Photo' },
  video:            { ar: 'فيديو', en: 'Video' },
  drone_photo:      { ar: 'صورة جوية', en: 'Drone photo' },
  drone_video:      { ar: 'فيديو جوي', en: 'Drone video' },
  floor_plan:       { ar: 'مخطط', en: 'Floor plan' },
  render:           { ar: 'رندر', en: 'Render' },
  logo:             { ar: 'شعار', en: 'Logo' },
  brochure:         { ar: 'بروشور', en: 'Brochure' },
  audio:            { ar: 'صوت', en: 'Audio' },
  document:         { ar: 'مستند', en: 'Document' },
  screen_recording: { ar: 'تسجيل شاشة', en: 'Screen recording' },
  custom:           { ar: 'مخصص', en: 'Custom' },
};

/** Statuses that end the line — shown apart from the forward path in the UI. */
export const TERMINAL_STATUSES = ['cancelled', 'archived'] as const;
