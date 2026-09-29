/**
 * Bilingual copy + formatting for the public tracked-link pages (/v/:token).
 * Like the broker portal, the page lives outside the app shell and is read by
 * customers, so its strings live in one dictionary rather than the app bundle.
 * Numbers use Latin digits in both languages (no «٫» / dot ambiguity).
 */

const DICT = {
  brand: { ar: 'وصل العقارية', en: 'Wassel Real Estate' },
  photos: { ar: 'الصور', en: 'Photos' },
  videos: { ar: 'الفيديوهات', en: 'Videos' },
  brochure: { ar: 'البروشور', en: 'Brochure' },
  units: { ar: 'الوحدات المتاحة', en: 'Available units' },
  location: { ar: 'الموقع', en: 'Location' },
  ready: { ar: 'جاهز', en: 'Ready' },
  offPlan: { ar: 'على الخارطة', en: 'Off-plan' },
  handover: { ar: 'التسليم', en: 'Handover' },
  from: { ar: 'تبدأ من', en: 'From' },
  sar: { ar: 'ريال', en: 'SAR' },
  sqm: { ar: 'م²', en: 'm²' },
  bedrooms: { ar: 'غرف', en: 'bedrooms' },
  bedroomsLabel: { ar: 'غرف النوم', en: 'Bedrooms' },
  bathroomsLabel: { ar: 'دورات المياه', en: 'Bathrooms' },
  area: { ar: 'المساحة', en: 'Area' },
  totalArea: { ar: 'المساحة الإجمالية', en: 'Total area' },
  privateArea: { ar: 'المساحة الخاصة', en: 'Private area' },
  price: { ar: 'السعر', en: 'Price' },
  floor: { ar: 'الدور', en: 'Floor' },
  facade: { ar: 'الواجهة', en: 'Facade' },
  parking: { ar: 'المواقف', en: 'Parking' },
  type: { ar: 'النوع', en: 'Type' },
  model: { ar: 'النموذج', en: 'Model' },
  unit: { ar: 'وحدة', en: 'Unit' },
  components: { ar: 'مكونات الوحدة', en: 'What the unit has' },
  plan: { ar: 'المخطط', en: 'Floor plan' },
  details: { ar: 'التفاصيل', en: 'Details' },
  hide: { ar: 'إخفاء', en: 'Hide' },
  noUnits: { ar: 'لا توجد وحدات متاحة حالياً', en: 'No units available right now' },
  openMaps: { ar: 'افتح الموقع في خرائط قوقل', en: 'Open in Google Maps' },
  openingMaps: { ar: 'جارٍ فتح الخريطة…', en: 'Opening the map…' },
  openBrochure: { ar: 'افتح البروشور', en: 'Open the brochure' },
  watch: { ar: 'شاهد', en: 'Watch' },
  notAvailable: { ar: 'هذا الرابط غير متاح', en: 'This link is not available' },
  notAvailableHint: { ar: 'تواصل معنا على واتساب وبنرسل لك رابط جديد.', en: 'Message us on WhatsApp and we will send you a new link.' },
  retry: { ar: 'إعادة المحاولة', en: 'Try again' },
  loadFailed: { ar: 'تعذّر التحميل', en: 'Could not load' },
  prev: { ar: 'السابق', en: 'Previous' },
  next: { ar: 'التالي', en: 'Next' },
  close: { ar: 'إغلاق', en: 'Close' },
  moreAboutProject: { ar: 'اكتشف المشروع', en: 'Explore the project' },
} as const;

export type Key = keyof typeof DICT;
export const tr = (k: Key, isAr: boolean): string => DICT[k][isAr ? 'ar' : 'en'];

export function money(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined) return '';
  return `${Math.round(v).toLocaleString('en-US')} ${tr('sar', isAr)}`;
}

export function sqm(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined) return '';
  return `${Math.round(v)} ${tr('sqm', isAr)}`;
}
