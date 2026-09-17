/**
 * Seed scenario for the private recruitment walkthrough (first content page).
 *
 * A single, continuous fictional-customer story used across all seven steps so
 * the candidate sees one coherent flow. Values are fictional but shaped exactly
 * like real Wassel records (field slugs, dropdown labels and option colors are
 * lifted from the live `clients` / `all_projects` / `units` schemas), so the
 * reproduced screens read as the real product — never marketing mockups.
 *
 * No PII, no live data: this page is a public, no-auth link sent to external
 * candidates, so everything here is static and self-contained by design.
 */

export interface PrefRow {
  label: string;
  value: string;
  /** true = value was captured by the AI during the call (green "من المكالمة" chip). */
  fromCall?: boolean;
  full?: boolean;
}

import type { RenderVariant } from './hireUi';

export interface ProjectCard {
  id: string;
  name: string;
  district: string;
  city: string;
  /** 'ours' → green pill, 'general' → charcoal pill (mirrors SourcePill). */
  source: 'ours' | 'general';
  price: string;
  area: string;
  type: string;
  bedrooms: string;
  available: string;
  /** match band → colored score pill (mirrors BandBadge). */
  band: 'strong' | 'good' | 'partial';
  score: number;
  offPlan: boolean;
  reason: string;
  image: RenderVariant;
}

export interface UnitRow {
  code: string;
  type: string;
  area: number;
  bedrooms: number;
  bathrooms: number;
  floor: string;
  price: number;
  /** matches the live units.unit_status option colors. */
  status: { label: string; color: string };
}

export interface ChatMessage {
  id: string;
  flow: 'in' | 'out';
  text: string;
  time: string;
  /** a prepared, fact-checked project message rendered with its image gallery. */
  project?: boolean;
}

// ── The customer ──────────────────────────────────────────────────────────────
export const CLIENT = {
  name: 'خالد العتيبي',
  code: 'CLT-1042',
  phone: '0554 128 337',
  status: 'مهتم جدًا',
  stage: 'الاتصال لحجز موعد',
  sources: ['اتصال وارد', 'واتساب وارد'],
  objective: 'سكن',
  city: 'الرياض',
};

// ── Step 1 — preferences captured during the call ─────────────────────────────
export const PREFERENCES: PrefRow[] = [
  { label: 'الميزانية', value: '1,600,000 – 2,100,000 ر.س', fromCall: true },
  { label: 'المساحة المفضلة', value: '300 – 400 م²', fromCall: true },
  { label: 'عدد غرف النوم', value: '4 – 5 غرف', fromCall: true },
  { label: 'نوع الوحدة', value: 'فيلا', fromCall: true },
  { label: 'عمر العقار (حد أقصى)', value: 'جديد فقط' },
  { label: 'المدينة المفضلة', value: 'الرياض' },
  { label: 'الأحياء المفضلة', value: 'النرجس · القيروان · الملقا', fromCall: true },
  { label: 'المرافق المفضلة', value: 'مجلس · مسبح · مصعد' },
  { label: 'هدف الشراء', value: 'سكن', fromCall: true },
  {
    label: 'ملاحظات التفضيلات',
    value: 'يفضّل فيلا بمدخلين، قريبة من مسجد ومدارس، بتشطيب حديث.',
    fromCall: true,
    full: true,
  },
];

// ── Step 2 — recommended projects ─────────────────────────────────────────────
export const RECOMMENDATIONS: ProjectCard[] = [
  {
    id: 'oasis',
    name: 'واحة النرجس',
    district: 'النرجس',
    city: 'الرياض',
    source: 'ours',
    price: '1,750,000 – 2,050,000 ر.س',
    area: '320 – 380 م²',
    type: 'فيلا',
    bedrooms: '5 – 6',
    available: '12 وحدة',
    band: 'strong',
    score: 94,
    offPlan: true,
    reason: 'يطابق الميزانية والحي المفضّل ونوع الوحدة، وبه وحدات متاحة الآن.',
    image: 'villaDay',
  },
  {
    id: 'qairawan',
    name: 'مشروع القيروان 18',
    district: 'القيروان',
    city: 'الرياض',
    source: 'ours',
    price: '1,600,000 – 1,900,000 ر.س',
    area: '300 – 360 م²',
    type: 'فيلا',
    bedrooms: '4 – 5',
    available: '8 وحدات',
    band: 'good',
    score: 86,
    offPlan: true,
    reason: 'ضمن الميزانية وفي حيّ مفضّل، مساحات أصغر قليلًا من المطلوب.',
    image: 'villaDusk',
  },
  {
    id: 'malqa',
    name: 'درة الملقا',
    district: 'الملقا',
    city: 'الرياض',
    source: 'general',
    price: '1,900,000 – 2,200,000 ر.س',
    area: '340 – 400 م²',
    type: 'فيلا',
    bedrooms: '5 – 6',
    available: '5 وحدات',
    band: 'partial',
    score: 72,
    offPlan: false,
    reason: 'مساحات مناسبة لكن أعلى من سقف الميزانية قليلًا، وحيّ مجاور للمفضّل.',
    image: 'tower',
  },
];

/** A compact echo of the captured preferences, reused across steps for continuity. */
export const JOURNEY_FILTERS = ['حتى 2.1 مليون ر.س', '4–5 غرف', 'فيلا', 'شمال الرياض'];

// ── Step 3 — the opened project (واحة النرجس) ─────────────────────────────────
export const PROJECT = {
  name: 'واحة النرجس',
  developer: 'شركة وصل للتطوير',
  district: 'النرجس، شمال الرياض',
  status: 'على الخارطة',
  construction: 'عظم',
  unitTypes: ['فيلا', 'دبلكس'],
  amenities: ['مسجد', 'مسبح', 'حديقة', 'مواقف قبو', 'نظام مراقبة أمنية', 'مصعد'],
  kpis: [
    { label: 'الوحدات', value: '48' },
    { label: 'متاحة', value: '12', tone: '#10B981' },
    { label: 'مباعة', value: '30', tone: '#8B5CF6' },
    { label: 'محجوزة', value: '6', tone: '#3B82F6' },
    { label: 'نطاق السعر', value: '1.75م – 2.05م' },
    { label: 'نطاق المساحة', value: '320 – 380' },
    { label: 'متوسط م²', value: '~5,500' },
  ],
  gallery: ['الواجهة الرئيسية', 'المدخل', 'المسبح', 'الإطلالة الليلية'],
  galleryVariants: ['villaDay', 'tower', 'pool', 'villaDusk'] as RenderVariant[],
  facts: [
    { label: 'المطوّر', value: 'شركة وصل للتطوير' },
    { label: 'الحي', value: 'النرجس، شمال الرياض' },
    { label: 'حالة المشروع', value: 'على الخارطة' },
    { label: 'حالة الإنشاء', value: 'عظم' },
    { label: 'أنواع الوحدات', value: 'فيلا · دبلكس' },
    { label: 'موعد الاستلام', value: 'الربع الرابع 2027' },
  ],
};

// ── Step 5 — units inside the project ─────────────────────────────────────────
const ST = {
  available: { label: 'متاحة', color: '#10B981' },
  reserved: { label: 'محجوزة', color: '#3B82F6' },
  sold: { label: 'مباعة', color: '#8B5CF6' },
};

export const UNITS: UnitRow[] = [
  { code: 'U-1207', type: 'فيلا', area: 340, bedrooms: 5, bathrooms: 6, floor: 'أرضي + أول', price: 1_950_000, status: ST.available },
  { code: 'U-1208', type: 'فيلا', area: 360, bedrooms: 5, bathrooms: 6, floor: 'أرضي + أول', price: 2_050_000, status: ST.available },
  { code: 'U-1210', type: 'دبلكس', area: 320, bedrooms: 4, bathrooms: 5, floor: 'أرضي', price: 1_780_000, status: ST.reserved },
  { code: 'U-1212', type: 'فيلا', area: 380, bedrooms: 6, bathrooms: 7, floor: 'أرضي + أول', price: 2_100_000, status: ST.available },
  { code: 'U-1215', type: 'فيلا', area: 330, bedrooms: 5, bathrooms: 6, floor: 'أرضي + أول', price: 1_900_000, status: ST.sold },
];

/** the unit the rep selects and sends (Step 5). */
export const SELECTED_UNIT_CODE = 'U-1207';

// ── Step 4 — WhatsApp conversation ────────────────────────────────────────────
export const PROJECT_MESSAGE = `🏡 مشروع واحة النرجس — شمال الرياض (حي النرجس)
فلل عصرية على الخارطة، بتشطيب فاخر ومدخلين.

• المساحات: من 320 إلى 380 م²
• الأسعار: تبدأ من 1,750,000 ر.س
• غرف النوم: 5–6 | مجلس + مسبح + مسجد داخل المشروع
• خطط سداد مرنة حتى الاستلام

يسعدنا ترتيب زيارة لك في أي وقت يناسبك 🌿`;

export const CHAT: ChatMessage[] = [
  { id: 'm1', flow: 'in', text: 'السلام عليكم، شفت إعلانكم عن فلل النرجس، ياليت تفاصيل أكثر 🙏', time: '10:24 ص' },
  { id: 'm2', flow: 'out', text: 'وعليكم السلام أستاذ خالد، حياك الله 🌿 معك مستشارك من وصل العقارية. أرسل لك الحين تفاصيل مشروع واحة النرجس.', time: '10:25 ص' },
  { id: 'm3', flow: 'out', text: PROJECT_MESSAGE, time: '10:25 ص', project: true },
  { id: 'm4', flow: 'in', text: 'ماشاء الله، متى أقرب موعد أقدر أزور؟', time: '10:31 ص' },
];

// ── Step 6 — the auto-created follow-up task ───────────────────────────────────
export const TASK = {
  client: CLIENT.name,
  phone: CLIENT.phone,
  type: 'اتصال لحجز موعد',
  objective: 'سكن',
  scheduled: 'غدًا · 11:00 صباحًا',
  channel: 'واتساب',
  statusLabel: 'ردّ العميل — دورك الآن',
  note: 'أنشأه النظام تلقائيًا بعد إرسال تفاصيل المشروع.',
};

// ── Step 7 — the AI client summary (mini-markdown) ────────────────────────────
export const CLIENT_SUMMARY = `**الوضع الحالي**
- العميل خالد العتيبي مهتم بفلل شمال الرياض، بميزانية حتى 2.1 مليون ر.س.
- أُرسلت له تفاصيل مشروع **واحة النرجس** عبر واتساب، وطلب تحديد موعد زيارة.

**آخر تواصل**
- مكالمة واردة قبل يومين، ومحادثة واتساب أمس.
- أبدى اهتمامًا بفيلا مساحة 340 م² (الوحدة U-1207).

**الخطوة التالية**
- الاتصال لتأكيد موعد الزيارة نهاية الأسبوع، وتجهيز عرض السعر.`;
