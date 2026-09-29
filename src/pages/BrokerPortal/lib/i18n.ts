/**
 * Bilingual copy + formatting for the public broker page.
 *
 * The page lives outside the app shell and is read by outside brokers, so its
 * strings are kept in one bilingual dictionary (the `isAr ? ar : en` pattern,
 * centralised) rather than the app-wide i18n bundle.
 *
 * Numbers use Latin digits in both languages (prices are read and re-typed by
 * brokers); percentages always carry their sign.
 */

import type { Bi, Range } from './api';

const DICT = {
  brand: { ar: 'وصل العقارية', en: 'Wassel Real Estate' },
  gift: { ar: 'بوابة الوسطاء', en: 'Broker Portal' },
  intro: {
    ar: 'كل ما تحتاجه لتسويق مشاريعنا في مكان واحد: الوحدات المتاحة، المخططات، خطط الدفع، الصور، الفيديوهات، والمكتبة التسويقية.',
    en: 'Everything you need to market our projects in one place: available units, floor plans, payment plans, photos, videos and the full marketing library.',
  },
  projects: { ar: 'المشاريع', en: 'Projects' },
  units: { ar: 'الوحدات', en: 'Units' },
  available: { ar: 'متاحة', en: 'Available' },
  reserved: { ar: 'محجوزة', en: 'Reserved' },
  sold: { ar: 'مباعة', en: 'Sold' },
  all: { ar: 'الكل', en: 'All' },
  availableUnits: { ar: 'وحدة متاحة', en: 'available units' },
  from: { ar: 'تبدأ من', en: 'From' },
  soldOut: { ar: 'مباع بالكامل', en: 'Sold out' },
  comingSoon: { ar: 'قريباً', en: 'Coming soon' },
  back: { ar: 'كل المشاريع', en: 'All projects' },
  overview: { ar: 'نظرة عامة', en: 'Overview' },
  plans: { ar: 'المخططات', en: 'Floor plans' },
  paymentPlans: { ar: 'خطط الدفع', en: 'Payment plans' },
  photos: { ar: 'الصور', en: 'Photos' },
  videos: { ar: 'الفيديوهات', en: 'Videos' },
  library: { ar: 'المكتبة التسويقية', en: 'Marketing library' },
  documents: { ar: 'الملفات والبروشورات', en: 'Brochures & PDFs' },
  features: { ar: 'مميزات المشروع', en: 'Project features' },
  services: { ar: 'الخدمات', en: 'Services' },
  guarantees: { ar: 'الضمانات', en: 'Warranties' },
  landmarks: { ar: 'القرب من المعالم', en: 'Nearby landmarks' },
  location: { ar: 'الموقع', en: 'Location' },
  openMap: { ar: 'فتح في خرائط Google', en: 'Open in Google Maps' },
  handover: { ar: 'التسليم', en: 'Handover' },
  pricePerM2: { ar: 'متوسط سعر المتر', en: 'Avg. price / m²' },
  area: { ar: 'المساحة', en: 'Area' },
  price: { ar: 'السعر', en: 'Price' },
  bedrooms: { ar: 'غرف النوم', en: 'Bedrooms' },
  bathrooms: { ar: 'دورات المياه', en: 'Bathrooms' },
  floor: { ar: 'الدور', en: 'Floor' },
  building: { ar: 'المبنى', en: 'Building' },
  model: { ar: 'النموذج', en: 'Model' },
  type: { ar: 'النوع', en: 'Type' },
  unit: { ar: 'وحدة', en: 'Unit' },
  status: { ar: 'الحالة', en: 'Status' },
  components: { ar: 'مكونات الوحدة', en: 'Unit components' },
  down: { ar: 'الدفعة الأولى', en: 'Down payment' },
  duringConstruction: { ar: 'أثناء الإنشاء', en: 'During construction' },
  onHandover: { ar: 'عند التسليم', en: 'On handover' },
  afterHandover: { ar: 'بعد التسليم', en: 'After handover' },
  schedule: { ar: 'جدول السداد', en: 'Schedule' },
  amount: { ar: 'المبلغ', en: 'Amount' },
  noResults: { ar: 'لا توجد نتائج مطابقة', en: 'No matching results' },
  nothingHere: { ar: 'لا يوجد محتوى في هذا القسم بعد', en: 'Nothing in this section yet' },
  download: { ar: 'تحميل', en: 'Download' },
  open: { ar: 'عرض', en: 'View' },
  close: { ar: 'إغلاق', en: 'Close' },
  shareWhatsapp: { ar: 'مشاركة عبر واتساب', en: 'Share on WhatsApp' },
  copyLink: { ar: 'نسخ الرابط', en: 'Copy link' },
  copied: { ar: 'تم النسخ', en: 'Copied' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…' },
  notFoundTitle: { ar: 'الرابط غير متاح', en: 'Link not available' },
  notFoundBody: {
    ar: 'قد يكون الرابط منتهياً أو تم إيقافه. تواصل مع وصل العقارية للحصول على رابط جديد.',
    en: 'This link may have expired or been turned off. Contact Wassel Real Estate for a new one.',
  },
  errorTitle: { ar: 'تعذّر التحميل', en: 'Could not load' },
  retry: { ar: 'إعادة المحاولة', en: 'Try again' },
  sortBy: { ar: 'الترتيب', en: 'Sort' },
  sortPriceAsc: { ar: 'السعر: الأقل أولاً', en: 'Price: low to high' },
  sortPriceDesc: { ar: 'السعر: الأعلى أولاً', en: 'Price: high to low' },
  sortAreaDesc: { ar: 'المساحة: الأكبر أولاً', en: 'Area: largest first' },
  sortNumber: { ar: 'رقم الوحدة', en: 'Unit number' },
  anyType: { ar: 'كل الأنواع', en: 'All types' },
  anyBedrooms: { ar: 'كل الغرف', en: 'Any bedrooms' },
  anyBuilding: { ar: 'كل المباني', en: 'All buildings' },
  maxPrice: { ar: 'أقصى سعر', en: 'Max price' },
  unitsShown: { ar: 'وحدة', en: 'units' },
  viewPlan: { ar: 'المخطط', en: 'Plan' },
  unitsWithPlan: { ar: 'وحدات بهذا المخطط', en: 'units with this plan' },
  showUnits: { ar: 'عرض الوحدات', en: 'Show units' },
  images: { ar: 'صور', en: 'Images' },
  developerBrochure: { ar: 'بروشور المطور', en: 'Developer brochure' },
  brochure: { ar: 'البروشور', en: 'Brochure' },
  projectPage: { ar: 'صفحة المشروع', en: 'Project page' },
  externalLinks: { ar: 'روابط خارجية', en: 'External links' },
  contact: { ar: 'التواصل', en: 'Contact' },
  website: { ar: 'الموقع الإلكتروني', en: 'Website' },
  poweredBy: { ar: 'هدية من وصل العقارية', en: 'A gift from Wassel Real Estate' },
  searchProjects: { ar: 'ابحث عن مشروع أو حي…', en: 'Search a project or district…' },
  totalUnits: { ar: 'إجمالي الوحدات', en: 'Total units' },
  priceRange: { ar: 'نطاق الأسعار', en: 'Price range' },
  areaRange: { ar: 'نطاق المساحات', en: 'Area range' },
  sar: { ar: 'ر.س', en: 'SAR' },
  m2: { ar: 'م²', en: 'm²' },
  rooms: { ar: 'غرف', en: 'BR' },
  paymentNote: {
    ar: 'المبالغ تقديرية محسوبة من سعر الوحدة ونسب خطة الدفع.',
    en: 'Amounts are estimates calculated from the unit price and plan percentages.',
  },
  lastUpdated: { ar: 'البيانات مباشرة من نظام وصل', en: 'Live data from the Wassel system' },
  prev: { ar: 'السابق', en: 'Previous' },
  next: { ar: 'التالي', en: 'Next' },
  play: { ar: 'تشغيل', en: 'Play' },
} satisfies Record<string, Bi>;

export type TKey = keyof typeof DICT;

export function makeT(isAr: boolean) {
  return (key: TKey): string => (isAr ? DICT[key].ar : DICT[key].en);
}

export function bi(v: Bi | null | undefined, isAr: boolean): string {
  if (!v) return '';
  return isAr ? v.ar : v.en;
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function fmtNum(v: number | null | undefined, decimals = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return decimals ? nf1.format(v) : nf.format(v);
}

export function fmtMoney(v: number | null | undefined, isAr: boolean): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${nf.format(Math.round(v))} ${isAr ? 'ر.س' : 'SAR'}`;
}

/** Short money: 1.37M / 1.37 مليون — for cards. */
export function fmtMoneyShort(v: number | null | undefined, isAr: boolean): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) {
    const m = (v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '');
    return isAr ? `${m} مليون ر.س` : `SAR ${m}M`;
  }
  if (v >= 1_000) {
    const k = Math.round(v / 1_000);
    return isAr ? `${k} ألف ر.س` : `SAR ${k}K`;
  }
  return fmtMoney(v, isAr);
}

export function fmtPct(v: number | null | undefined, isAr: boolean): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${nf1.format(v)}${isAr ? '٪' : '%'}`;
}

export function fmtRange(r: Range | null | undefined, fmt: (n: number) => string): string | null {
  if (!r || (r.min == null && r.max == null)) return null;
  const min = r.min ?? r.max!;
  const max = r.max ?? r.min!;
  return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
}

export function fmtDate(iso: string | null | undefined, isAr: boolean): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(isAr ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { year: 'numeric', month: 'long' });
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function fmtDuration(s: number | null | undefined): string | null {
  if (!s || !Number.isFinite(s)) return null;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
