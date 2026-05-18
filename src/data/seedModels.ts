import { v4 as uuid } from 'uuid';
import { MAPS_CONFIG_DEFAULT } from '@/types';
import type { AppModel, FieldOption, ModelGroup } from '@/types';

// --- Groups ---
// Stable, deterministic ID for the Projects group. DO NOT CHANGE — returning users'
// stored models have `group_id` pointing to this value, and changing it would orphan them.
// This replaces an earlier `uuid()` that regenerated per module load, which caused
// project models to disappear from the Sidebar whenever the stored group went missing.
export const PROJECTS_GROUP_ID = '00000000-0000-4000-8000-000000000001';

// Stable id for the Designs group (Templates Library + Marketing Operations
// + Competitors reference). Same contract as PROJECTS_GROUP_ID — the UUID
// is preserved across the 2026-05-09 rename from "Marketing" → "Designs"
// so existing competitors records keep their group_id pointer.
export const DESIGNS_GROUP_ID = '00000000-0000-4000-8000-000000000002';

// Retired system models — names that USED to be seeded but have been
// removed from the codebase. On every `initialize()`, the store hard-
// deletes any row matching these names from BOTH Supabase AND local
// cache (via the existing deleteModel action which cascades records,
// workflows, views, and workflow runs). This is the propagation path
// from "deleted in code" → "deleted everywhere", so a deployed instance
// can't keep ghost models alive via stale localStorage, queued pending
// writes, or rogue upserts during the demolition cycle.
//
// Hard rule: only `is_system: true` rows are eligible for retirement —
// user-built models with these names (unlikely but possible) are
// untouched. Add a name here ONLY when retiring a system model.
//
// Why a set instead of "absent from SEED_MODELS = retired": the latter
// would silently delete production data the moment a developer removes
// a model from the seed list (e.g. mid-refactor). Explicit retirement
// is git-auditable and impossible to trigger by accident.
export const RETIRED_SYSTEM_MODEL_NAMES: ReadonlySet<string> = new Set([
  // 2026-05-09: agent-driven marketing pipeline retired in favor of the
  // template-driven design generator. The competitors model is preserved
  // (still listed in SEED_MODELS), the other four are dead.
  'reels',
  'posts',
  'research_questions',
  // Note: 'marketing_operations' is NOT here — the name was reused for
  // the rebuilt schema. The OLD UUID's row was already deleted in P1
  // and the new UUID is part of SEED_MODELS.
]);

// Dropdown-option helper: Arabic label is the value (stored verbatim); English label
// defaults to the Arabic when no transliteration is provided. Admin can edit in Builder.
function opt(ar: string, en?: string): FieldOption {
  return { id: uuid(), label_ar: ar, label_en: en ?? ar, value: ar };
}

// --- Saudi city + Riyadh-district dropdown options (user-provided, Apr 2026) ---
// English labels are provided for the most common places; the rest fall back to Arabic
// until an admin customizes them in the Builder.
const CITY_OPTIONS: FieldOption[] = [
  opt('الرياض', 'Riyadh'), opt('جدة', 'Jeddah'), opt('مكة المكرمة', 'Makkah'),
  opt('المدينة المنورة', 'Madinah'), opt('الدمام', 'Dammam'), opt('الخبر', 'Khobar'),
  opt('الظهران', 'Dhahran'), opt('الجبيل', 'Jubail'), opt('رأس تنورة', 'Ras Tanura'),
  opt('القطيف', 'Qatif'), opt('الأحساء', 'Al-Ahsa'), opt('الهفوف', 'Hofuf'),
  opt('حفر الباطن', 'Hafar Al-Batin'), opt('بريدة', 'Buraidah'), opt('عنيزة', 'Unaizah'),
  opt('الرس', 'Ar Rass'), opt('البكيرية', 'Al-Bukayriyah'), opt('البدائع', 'Al-Badaya'),
  opt('المذنب', 'Al-Muthnib'), opt('الأسياح', 'Al-Asyah'), opt('الخفجي', 'Khafji'),
  opt('النعيرية', 'An-Nairyah'), opt('القيصومة', 'Al-Qaisumah'), opt('سكاكا', 'Sakaka'),
  opt('دومة الجندل', 'Dumat Al-Jandal'), opt('طبرجل', 'Tabarjal'), opt('عرعر', 'Arar'),
  opt('رفحاء', 'Rafha'), opt('طريف', 'Turaif'), opt('القريات', 'Al-Qurayyat'),
  opt('تبوك', 'Tabuk'), opt('الوجه', 'Al-Wajh'), opt('ضباء', 'Duba'),
  opt('أملج', 'Umluj'), opt('حقل', 'Haql'), opt('البدع', 'Al-Bada'),
  opt('خيبر', 'Khaybar'), opt('العلا', 'AlUla'), opt('ينبع', 'Yanbu'),
  opt('بدر', 'Badr'), opt('المهد', 'Al-Mahd'), opt('الطائف', 'Taif'),
  opt('رنية', 'Ranyah'), opt('تربة', 'Turabah'), opt('الخرمة', 'Al-Khurma'),
  opt('المويه', 'Al-Muwayh'), opt('الرين', 'Al-Rayn'), opt('القويعية', 'Al-Quway\'iyah'),
  opt('الدوادمي', 'Ad-Dawadmi'), opt('عفيف', 'Afif'), opt('الزلفي', 'Az-Zulfi'),
  opt('المجمعة', 'Al-Majma\'ah'), opt('شقراء', 'Shaqra'), opt('حوطة بني تميم', 'Hawtat Bani Tamim'),
  opt('الحريق', 'Al-Hariq'), opt('الأفلاج', 'Al-Aflaj'), opt('السليل', 'As-Sulayyil'),
  opt('وادي الدواسر', 'Wadi Ad-Dawasir'), opt('بيشة', 'Bisha'), opt('النماص', 'An-Namas'),
  opt('تنومة', 'Tanumah'), opt('بلقرن', 'Balqarn'), opt('سبت العلاية', 'Sabt Al-Alaya'),
  opt('خميس مشيط', 'Khamis Mushait'), opt('أبها', 'Abha'), opt('رجال ألمع', 'Rijal Alma'),
  opt('ظهران الجنوب', 'Dhahran Al-Janub'), opt('سراة عبيدة', 'Sarat Abidah'),
  opt('الحرجة', 'Al-Harjah'), opt('تثليث', 'Tathlith'), opt('محايل عسير', 'Mahayel Asir'),
  opt('جازان', 'Jazan'), opt('صامطة', 'Samtah'), opt('صبيا', 'Sabya'),
  opt('أبوعريش', 'Abu Arish'), opt('بيش', 'Baysh'), opt('الدرب', 'Ad-Darb'),
  opt('الريث', 'Ar-Rayth'), opt('فيفاء', 'Fayfa'), opt('العيدابي', 'Al-Aydabi'),
  opt('الدائر', 'Ad-Dayir'), opt('العاصمة المقدسة (مكة)', 'Holy Capital (Makkah)'),
  opt('بحرة', 'Bahra'), opt('القنفذة', 'Al-Qunfudhah'), opt('الليث', 'Al-Lith'),
  opt('رابغ', 'Rabigh'), opt('خليص', 'Khulais'), opt('الجموم', 'Al-Jumum'),
  opt('الكامل', 'Al-Kamil'), opt('الطوال', 'At-Tuwal'), opt('العارضة', 'Al-Aridah'),
  opt('نجران', 'Najran'), opt('حبونا', 'Hubuna'), opt('يدمة', 'Yadamah'),
  opt('بدر الجنوب', 'Badr Al-Janub'), opt('ثادق', 'Thadiq'), opt('رماح', 'Rumah'),
  opt('مرات', 'Marat'), opt('حوطة سدير', 'Hawtat Sudair'), opt('تمير', 'Tumair'),
  opt('الأرطاوية', 'Al-Artawiyah'), opt('الأحساء (الهفوف والمبرز)', 'Al-Ahsa (Hofuf & Mubarraz)'),
  opt('سلوى', 'Salwa'), opt('العقير', 'Al-Uqair'), opt('العيون', 'Al-Uyun'),
  opt('بقيق', 'Buqayq'), opt('قرية العليا', 'Qaryat Al-Ulya'), opt('صفوى', 'Safwa'),
  opt('تاروت', 'Tarout'), opt('سيهات', 'Saihat'), opt('العوامية', 'Al-Awamiyah'),
  opt('سنابس', 'Sanabis'), opt('أم الساهك', 'Umm As-Sahik'), opt('حزم الجلاميد', 'Hazm Al-Jalamid'),
  opt('قارا', 'Qara'), opt('الردف', 'Ar-Rudf'), opt('الشعبة', 'Ash-Shu\'bah'),
  opt('الدلم', 'Ad-Dilam'), opt('الحوطة', 'Al-Hawtah'), opt('الخرج', 'Al-Kharj'),
  opt('الفرعة', 'Al-Far\'ah'), opt('الدرعية', 'Ad-Diriyah'), opt('العمارية', 'Al-Ammariyah'),
  opt('ملهم', 'Mulham'), opt('العيينة', 'Al-Uyaynah'), opt('حريملاء', 'Huraymila'),
  opt('صلبوخ', 'Salbukh'), opt('المزاحمية', 'Al-Muzahimiyah'), opt('لبخة', 'Labkhah'),
  opt('ضرما', 'Dhurma'), opt('نساح', 'Nisah'), opt('القصب', 'Al-Qasab'),
  opt('أشيقر', 'Ushayqir'), opt('الرويضة', 'Ar-Ruwaydah'), opt('جلاجل', 'Jalajel'),
  opt('البره', 'Al-Burrah'), opt('الشقراء', 'Ash-Shaqra'), opt('السر', 'As-Sirr'),
  opt('ساجر', 'Sajir'), opt('نفي', 'Nafi'), opt('البجادية', 'Al-Bijadiyah'),
  opt('عروى', 'Urwa'), opt('الرفيعة', 'Ar-Rafi\'ah'), opt('العقدة', 'Al-Uqdah'),
  opt('الشماسية', 'Ash-Shamasiyah'), opt('الخبراء', 'Al-Khabra'), opt('رياض الخبراء', 'Riyad Al-Khabra'),
  opt('البصر', 'Al-Basr'), opt('عقلة الصقور', 'Uqlat As-Suqur'), opt('النبهانية', 'An-Nabhaniyah'),
  opt('قبة', 'Qibbah'), opt('ميسان', 'Maysan'), opt('المظيلف', 'Al-Muzaylif'),
  opt('ثول', 'Thuwal'), opt('الحناكية', 'Al-Hanakiyah'), opt('العيص', 'Al-Ays'),
  opt('الحائط', 'Al-Hait'), opt('السليمي', 'As-Sulaymi'), opt('الشملي', 'Ash-Shamli'),
  opt('الحليفة', 'Al-Hulayfah'), opt('ثار', 'Thar'), opt('شرورة', 'Sharurah'),
  opt('الوديعة', 'Al-Wadi\'ah'), opt('الخرخير', 'Al-Kharkhir'),
];

const DISTRICT_OPTIONS: FieldOption[] = [
  opt('الملز', 'Al-Malaz'), opt('المروج', 'Al-Muruj'), opt('التعاون', 'At-Ta\'awun'),
  opt('الصفا', 'As-Safa'), opt('السليمانية', 'As-Sulaimaniyah'), opt('الروضة', 'Ar-Rawdah'),
  opt('السلام', 'As-Salam'), opt('الربوة', 'Ar-Rabwa'), opt('الريان', 'Ar-Rayyan'),
  opt('المعذر', 'Al-Ma\'athar'), opt('المربع', 'Al-Murabba'), opt('العليا', 'Al-Olaya'),
  opt('المرسلات', 'Al-Mursalat'), opt('النخيل', 'An-Nakheel'), opt('الغدير', 'Al-Ghadir'),
  opt('الواحة', 'Al-Wahah'), opt('الصحافة', 'As-Sahafah'), opt('الياسمين', 'Al-Yasmin'),
  opt('النرجس', 'An-Narjis'), opt('العقيق', 'Al-Aqiq'), opt('الربيع', 'Ar-Rabi'),
  opt('الازدهار', 'Al-Izdihar'), opt('الورود', 'Al-Wurud'), opt('المغرزات', 'Al-Mughrizat'),
  opt('المعيزيلة', 'Al-Mu\'aizilah'), opt('اليرموك', 'Al-Yarmuk'), opt('الحمراء', 'Al-Hamra'),
  opt('قرطبة', 'Qurtubah'), opt('الفلاح', 'Al-Falah'), opt('المونسية', 'Al-Munisiyah'),
  opt('النظيم', 'An-Nadheem'), opt('الجنادرية', 'Al-Janadriyah'), opt('الندوة', 'An-Nadwah'),
  opt('المنار', 'Al-Manar'), opt('الفيحاء', 'Al-Fayha'), opt('النسيم الشرقي', 'An-Naseem East'),
  opt('النسيم الغربي', 'An-Naseem West'), opt('المنصورة', 'Al-Mansurah'), opt('الفيصلية', 'Al-Faisaliyah'),
  opt('الشميسي', 'Ash-Shumaisi'), opt('الجرادية', 'Al-Jaradiyah'), opt('الديرة', 'Ad-Dirah'),
  opt('البطحاء', 'Al-Batha'), opt('الظهيرة', 'Adh-Dhahirah'), opt('عليشة', 'Olaishah'),
  opt('العريجاء الشرقية', 'Al-Uraija East'), opt('العريجاء الغربية', 'Al-Uraija West'),
  opt('العريجاء الوسطى', 'Al-Uraija Central'), opt('طويق', 'Tuwaiq'), opt('السويدي', 'As-Suwaidi'),
  opt('السويدي الغربي', 'As-Suwaidi West'), opt('السويدي الشرقي', 'As-Suwaidi East'),
  opt('الشفا', 'Ash-Shifa'), opt('بدر', 'Badr'), opt('الدريهمية', 'Ad-Duraihimiyah'),
  opt('العزيزية', 'Al-Aziziyah'), opt('الدار البيضاء', 'Ad-Dar Al-Bayda'), opt('الحزم', 'Al-Hazm'),
  opt('نمار', 'Namar'), opt('لبن', 'Laban'), opt('ظهرة لبن', 'Dhahrat Laban'),
  opt('جامعة الملك سعود', 'King Saud University'), opt('المعذر الشمالي', 'Al-Ma\'athar North'),
  opt('المعذر الجنوبي', 'Al-Ma\'athar South'), opt('الناصرية', 'An-Nasriyah'), opt('الخالدية', 'Al-Khalidiyah'),
  opt('عتيقة', 'Atiqah'), opt('منفوحة', 'Manfuha'), opt('منفوحة الجديدة', 'Manfuha Al-Jadidah'),
  opt('غبيراء', 'Ghubayra'), opt('الصالحية', 'As-Salihiyah'), opt('الفوطة', 'Al-Futah'),
  opt('الزهرة', 'Az-Zahrah'), opt('العريجا', 'Al-Uraija'), opt('ضاحية لبن', 'Dhahiyat Laban'),
  opt('الجامعة', 'Al-Jami\'ah'), opt('البديعة', 'Al-Badiah'), opt('الوشام', 'Al-Washm'),
  opt('المرقب', 'Al-Murqab'), opt('الجزيرة', 'Al-Jazirah'), opt('القدس', 'Al-Quds'),
  opt('الروابي', 'Ar-Rawabi'), opt('النسيم', 'An-Naseem'), opt('النهضة', 'An-Nahdah'),
  opt('غرناطة', 'Gharnatah'), opt('المصيف', 'Al-Musayif'), opt('الوزارات', 'Al-Wizarat'),
  opt('النخيل الشرقي', 'An-Nakheel East'), opt('النخيل الغربي', 'An-Nakheel West'),
  opt('السفارات', 'As-Safarat'), opt('حي الملقا', 'Al-Malqa'), opt('حي جامعة الملك سعود', 'KSU District'),
  opt('حي العارض', 'Al-Aridh'), opt('حي العارض الشمالي', 'Al-Aridh North'),
  opt('حي القيروان', 'Al-Qairawan'), opt('حي حطين', 'Hittin'), opt('حي الندى', 'An-Nada'),
  opt('حي النرجس الشمالي', 'An-Narjis North'), opt('حي الملقا الجنوبي', 'Al-Malqa South'),
  opt('حي الملقا الشمالي', 'Al-Malqa North'), opt('حي العارض الغربي', 'Al-Aridh West'),
  opt('حي الخير', 'Al-Khair'), opt('حي بنبان', 'Banban'), opt('حي المهدية', 'Al-Mahdiyah'),
  opt('حي ديراب', 'Dirab'), opt('حي نمار', 'Namar'), opt('حي طويق', 'Tuwaiq'),
  opt('حي ظهرة لبن', 'Dhahrat Laban'), opt('حي لبن الغربي', 'Laban West'),
  opt('حي السويدي الغربي', 'As-Suwaidi West'), opt('حي بدر', 'Badr'), opt('حي العزيزية', 'Al-Aziziyah'),
  opt('حي الدار البيضاء', 'Ad-Dar Al-Bayda'), opt('حي المنصورة', 'Al-Mansurah'),
  opt('حي الصناعية القديمة', 'Old Industrial'), opt('حي الصناعية الجديدة', 'New Industrial'),
  opt('حي الفاخرية', 'Al-Fakhiriyah'), opt('حي المصفاة', 'Al-Musaffah'),
  opt('حي السعادة', 'As-Sa\'adah'), opt('حي السلي', 'As-Sulay'), opt('حي الجزيرة', 'Al-Jazirah'),
  opt('حي الصناعية الثانية', 'Industrial 2nd'), opt('حي الخليج', 'Al-Khaleej'),
  opt('حي النهضة', 'An-Nahdah'), opt('حي القدس', 'Al-Quds'), opt('حي اليرموك', 'Al-Yarmuk'),
  opt('حي الحمراء الشرقية', 'Al-Hamra East'), opt('حي الحمراء الغربية', 'Al-Hamra West'),
  opt('حي قرطبة الشرقية', 'Qurtubah East'), opt('حي قرطبة الغربية', 'Qurtubah West'),
  opt('حي الفلاح', 'Al-Falah'), opt('حي غرناطة الشمالية', 'Gharnatah North'),
  opt('حي غرناطة الجنوبية', 'Gharnatah South'), opt('حي المونسية الشرقية', 'Al-Munisiyah East'),
  opt('حي المونسية الغربية', 'Al-Munisiyah West'), opt('حي الازدهار', 'Al-Izdihar'),
  opt('حي الربيع الشرقي', 'Ar-Rabi East'), opt('حي الربيع الغربي', 'Ar-Rabi West'),
  opt('حي العقيق الشمالي', 'Al-Aqiq North'), opt('حي العقيق الجنوبي', 'Al-Aqiq South'),
  opt('حي الصحافة الشمالية', 'As-Sahafah North'), opt('حي الصحافة الجنوبية', 'As-Sahafah South'),
  opt('حي النرجس الجنوبية', 'An-Narjis South'), opt('حي الياسمين الجنوبية', 'Al-Yasmin South'),
  opt('حي الملقا الوسطى', 'Al-Malqa Central'), opt('حي القيروان الجنوبي', 'Al-Qairawan South'),
  opt('حي القيروان الشمالي', 'Al-Qairawan North'), opt('حي حطين النرجس', 'Hittin An-Narjis'),
  opt('حي الياسمين الغربي', 'Al-Yasmin West'), opt('حي العارض الأوسط', 'Al-Aridh Central'),
];

// ============================================================
// Cross-model IDs — declared up-front so earlier models can reference later ones
// via lookup_model_id without a TDZ issue.
// ============================================================
const allProjectsId = uuid();
export const unitsId = uuid();
export const appointmentsId = uuid();
// Visits model (2026-05-10): user-built but seeded so fresh installs match
// the migrated production state. Schema lives near ourProjectsModel below.
// Field IDs are declared up-front because the followups model's
// custom_buttons reference visits by id, and visits' auto-link / auto-fill
// props on `phone` and `name` reference the sibling `client_id` lookup id.
export const visitsId = uuid();
const visitsBasicSectionId = uuid();
const visitsClientFieldId = uuid();
const visitsPhoneFieldId = uuid();
const visitsNameFieldId = uuid();
const visitsScheduledFieldId = uuid();
const visitsProjectFieldId = uuid();

// ============================================================
// DEVELOPERS MODEL (new 2026-04-18)
// ============================================================
const developersId = uuid();
const developersBaseSectionId = uuid();
const developerNameFieldId = uuid();
const developerPhoneFieldId = uuid();

const developersModel: AppModel = {
  id: developersId,
  name: 'developers',
  label_ar: 'المطورون',
  label_en: 'Developers',
  icon: 'briefcase',
  color: '#8E4E3A',
  group_id: PROJECTS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: developerNameFieldId,
    subtitle_field_id: developerPhoneFieldId,
    badge_field_id: null,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: developersBaseSectionId,
        label_ar: 'معلومات المطور',
        label_en: 'Developer Info',
        order: 0,
        is_base: true,
        color: '#8E4E3A',
        fields: [
          {
            id: developerNameFieldId,
            name: 'name',
            label_ar: 'اسم المطور',
            label_en: 'Developer Name',
            type: 'text',
            required: true,
            order: 0,
            section_id: developersBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: developerPhoneFieldId,
            name: 'phone',
            label_ar: 'رقم الهاتف',
            label_en: 'Phone',
            type: 'phone',
            required: false,
            order: 1,
            section_id: developersBaseSectionId,
            width: 'half',
            show_in_table: true,
            default_country_code: '+966',
          },
          {
            id: uuid(),
            name: 'email',
            label_ar: 'البريد الإلكتروني',
            label_en: 'Email',
            type: 'email',
            required: false,
            order: 2,
            section_id: developersBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'website',
            label_ar: 'الموقع الإلكتروني',
            label_en: 'Website',
            type: 'url',
            required: false,
            order: 3,
            section_id: developersBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 4,
            section_id: developersBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};


export const SEED_GROUPS: ModelGroup[] = [
  {
    id: PROJECTS_GROUP_ID,
    label_ar: 'المشاريع',
    label_en: 'Projects',
    order: 0,
  },
  {
    id: DESIGNS_GROUP_ID,
    label_ar: 'التصاميم',
    label_en: 'Designs',
    order: 1,
  },
];

// --- Helper ---
function now(): string {
  return new Date().toISOString();
}

// ============================================================
// 1. CLIENTS MODEL
// ============================================================
const clientsId = uuid();
const clientsBasicSectionId = uuid();
const clientsPrefsSectionId = uuid();
const clientsWhatsAppSectionId = uuid();
const clientsCallsSectionId = uuid();

const clientNameFieldId = uuid();
const clientStatusFieldId = uuid();

// --- Option lists for the Clients model ---
const CLIENT_SOURCE_OPTIONS: FieldOption[] = [
  opt('ترويج', 'Promotion'),
  opt('زيارة مشروع', 'Project Visit'),
  opt('واتساب وارد', 'WhatsApp Inbound'),
  opt('واتساب صادر', 'WhatsApp Outbound'),
  opt('اتصال وارد', 'Call Inbound'),
  opt('اتصال صادر', 'Call Outbound'),
  opt('عرض سعر', 'Quotation'),
  opt('تمويل', 'Financing'),
  opt('الإفراغ', 'Title Transfer'),
];

const CLIENT_STATUS_OPTIONS: FieldOption[] = [
  opt('لا يوجد رد', 'No Answer'),
  opt('الوقت غير مناسب', 'Inconvenient Time'),
  opt('مهتم', 'Interested'),
  opt('غير مهتم', 'Not Interested'),
  opt('غير مؤهل', 'Not Qualified'),
  opt('تم حجز موعد', 'Appointment Booked'),
  opt('لا يوجد رد 10 مرات', 'No Answer x10'),
  opt('تم تأكيد الحضور', 'Attendance Confirmed'),
  opt('تم إلغاء الموعد', 'Appointment Cancelled'),
  opt('تمت إعادة الجدولة', 'Rescheduled'),
  opt('لم يحضر الموعد', 'No-show'),
  opt('مهتم جدًا', 'Very Interested'),
  opt('تم طلب عرض سعر', 'Quote Requested'),
  opt('تم إرسال عرض السعر', 'Quote Sent'),
  opt('تم توقيع عرض السعر', 'Quote Signed'),
  opt('تم استلام شيك الحجز', 'Booking Cheque Received'),
  opt('تم إرسال نموذج الحجز', 'Booking Form Sent'),
  opt('تم توقيع نموذج الحجز', 'Booking Form Signed'),
  opt('تم الحجز', 'Booked'),
  opt('البنك', 'Bank'),
  opt('التقييم', 'Appraisal'),
  opt('تم إصدار نموذج الإفراغ', 'Title Form Issued'),
  opt('تم الإفراغ', 'Title Transferred'),
];

const CLIENT_STAGE_OPTIONS: FieldOption[] = [
  opt('جديد', 'New'),
  opt('غير مؤهل', 'Not Qualified'),
  opt('الاتصال لحجز موعد', 'Call to Book'),
  opt('موعد زيارة', 'Visit Appointment'),
  opt('زيارة', 'Visit'),
  opt('متابعة بعد الزيارة', 'Post-Visit Follow-up'),
  opt('عرض سعر', 'Quotation'),
  opt('حجز', 'Booking'),
  opt('تمويل', 'Financing'),
  opt('الإفراغ', 'Title Transfer'),
];

const DIRECTION_OPTIONS: FieldOption[] = [
  opt('شمال', 'North'),
  opt('شرق', 'East'),
  opt('جنوب', 'South'),
  opt('غرب', 'West'),
  opt('شمال شرق', 'North East'),
  opt('شمال غرب', 'North West'),
  opt('جنوب غرب', 'South West'),
  opt('جنوب شرق', 'South East'),
];

const LANGUAGE_OPTIONS: FieldOption[] = [
  opt('العربية', 'Arabic'),
  opt('الإنجليزية', 'English'),
];

const CLIENT_UNIT_TYPE_OPTIONS: FieldOption[] = [
  opt('فيلا', 'Villa'),
  opt('شقة', 'Apartment'),
  opt('دور', 'Floor'),
  opt('دبلكس', 'Duplex'),
  opt('تاون هاوس', 'Townhouse'),
  opt('استوديو', 'Studio'),
  opt('ملحق', 'Annex'),
];

const AMENITY_OPTIONS: FieldOption[] = [
  opt('مجلس', 'Majlis'),
  opt('غرفة خادمة', 'Maid Room'),
  opt('غرفة سائق', 'Driver Room'),
  opt('مسبح', 'Pool'),
  opt('حوش', 'Yard'),
  opt('سطح', 'Rooftop'),
  opt('مصعد', 'Elevator'),
];

const COUNTRY_OPTIONS: FieldOption[] = [
  opt('السعودية', 'Saudi Arabia'),
  opt('الإمارات العربية المتحدة', 'United Arab Emirates'),
  opt('الكويت', 'Kuwait'),
  opt('قطر', 'Qatar'),
  opt('البحرين', 'Bahrain'),
  opt('عُمان', 'Oman'),
  opt('اليمن', 'Yemen'),
  opt('الأردن', 'Jordan'),
  opt('لبنان', 'Lebanon'),
  opt('سوريا', 'Syria'),
  opt('فلسطين', 'Palestine'),
  opt('العراق', 'Iraq'),
  opt('مصر', 'Egypt'),
  opt('السودان', 'Sudan'),
  opt('ليبيا', 'Libya'),
  opt('تونس', 'Tunisia'),
  opt('الجزائر', 'Algeria'),
  opt('المغرب', 'Morocco'),
  opt('موريتانيا', 'Mauritania'),
  opt('جيبوتي', 'Djibouti'),
  opt('الصومال', 'Somalia'),
  opt('فرنسا', 'France'),
  opt('ألمانيا', 'Germany'),
  opt('إيطاليا', 'Italy'),
  opt('إسبانيا', 'Spain'),
  opt('البرتغال', 'Portugal'),
  opt('هولندا', 'Netherlands'),
  opt('بلجيكا', 'Belgium'),
  opt('السويد', 'Sweden'),
  opt('النرويج', 'Norway'),
  opt('الدنمارك', 'Denmark'),
  opt('فنلندا', 'Finland'),
  opt('سويسرا', 'Switzerland'),
  opt('النمسا', 'Austria'),
  opt('بولندا', 'Poland'),
  opt('تشيكيا', 'Czechia'),
  opt('سلوفاكيا', 'Slovakia'),
  opt('المجر', 'Hungary'),
  opt('رومانيا', 'Romania'),
  opt('بلغاريا', 'Bulgaria'),
  opt('اليونان', 'Greece'),
  opt('كرواتيا', 'Croatia'),
  opt('سلوفينيا', 'Slovenia'),
  opt('صربيا', 'Serbia'),
  opt('البوسنة والهرسك', 'Bosnia and Herzegovina'),
  opt('ألبانيا', 'Albania'),
  opt('إستونيا', 'Estonia'),
  opt('لاتفيا', 'Latvia'),
  opt('ليتوانيا', 'Lithuania'),
  opt('أيرلندا', 'Ireland'),
  opt('المملكة المتحدة', 'United Kingdom'),
  opt('آيسلندا', 'Iceland'),
  opt('لوكسمبورغ', 'Luxembourg'),
  opt('مالطا', 'Malta'),
  opt('قبرص', 'Cyprus'),
  opt('الصين', 'China'),
  opt('اليابان', 'Japan'),
  opt('كوريا الجنوبية', 'South Korea'),
  opt('كوريا الشمالية', 'North Korea'),
  opt('الهند', 'India'),
  opt('باكستان', 'Pakistan'),
  opt('إندونيسيا', 'Indonesia'),
  opt('ماليزيا', 'Malaysia'),
  opt('سنغافورة', 'Singapore'),
  opt('تايلاند', 'Thailand'),
  opt('فيتنام', 'Vietnam'),
  opt('الفلبين', 'Philippines'),
  opt('ميانمار', 'Myanmar'),
  opt('كمبوديا', 'Cambodia'),
  opt('لاوس', 'Laos'),
  opt('بنغلاديش', 'Bangladesh'),
  opt('نيبال', 'Nepal'),
  opt('سريلانكا', 'Sri Lanka'),
  opt('المالديف', 'Maldives'),
  opt('إيران', 'Iran'),
  opt('أفغانستان', 'Afghanistan'),
  opt('أوزبكستان', 'Uzbekistan'),
  opt('تركمانستان', 'Turkmenistan'),
  opt('كازاخستان', 'Kazakhstan'),
  opt('قرغيزستان', 'Kyrgyzstan'),
  opt('طاجيكستان', 'Tajikistan'),
  opt('منغوليا', 'Mongolia'),
  opt('أذربيجان', 'Azerbaijan'),
  opt('أرمينيا', 'Armenia'),
  opt('جورجيا', 'Georgia'),
  opt('تركيا', 'Turkey'),
  opt('جنوب أفريقيا', 'South Africa'),
  opt('نيجيريا', 'Nigeria'),
  opt('إثيوبيا', 'Ethiopia'),
  opt('كينيا', 'Kenya'),
  opt('تنزانيا', 'Tanzania'),
  opt('أوغندا', 'Uganda'),
  opt('رواندا', 'Rwanda'),
  opt('بوروندي', 'Burundi'),
  opt('الكونغو الديمقراطية', 'DR Congo'),
  opt('الكونغو', 'Congo'),
  opt('الكاميرون', 'Cameroon'),
  opt('غانا', 'Ghana'),
  opt('ساحل العاج', 'Ivory Coast'),
  opt('السنغال', 'Senegal'),
  opt('غامبيا', 'Gambia'),
  opt('غينيا', 'Guinea'),
  opt('غينيا بيساو', 'Guinea-Bissau'),
  opt('سيراليون', 'Sierra Leone'),
  opt('ليبيريا', 'Liberia'),
  opt('تشاد', 'Chad'),
  opt('النيجر', 'Niger'),
  opt('مالي', 'Mali'),
  opt('بوركينا فاسو', 'Burkina Faso'),
  opt('التوغو', 'Togo'),
  opt('بنين', 'Benin'),
  opt('جمهورية أفريقيا الوسطى', 'Central African Republic'),
  opt('الغابون', 'Gabon'),
  opt('أنغولا', 'Angola'),
  opt('زامبيا', 'Zambia'),
  opt('زيمبابوي', 'Zimbabwe'),
  opt('موزمبيق', 'Mozambique'),
  opt('بوتسوانا', 'Botswana'),
  opt('ناميبيا', 'Namibia'),
  opt('ليسوتو', 'Lesotho'),
  opt('إسواتيني', 'Eswatini'),
  opt('مدغشقر', 'Madagascar'),
  opt('جزر القمر', 'Comoros'),
  opt('سيشل', 'Seychelles'),
  opt('موريشيوس', 'Mauritius'),
];

const clientsModel: AppModel = {
  id: clientsId,
  name: 'clients',
  label_ar: 'العملاء',
  label_en: 'Clients',
  icon: 'users',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: clientNameFieldId,
    subtitle_field_id: null,
    badge_field_id: clientStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: clientsBasicSectionId,
        label_ar: 'أساسي',
        label_en: 'Basic',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: uuid(),
            name: 'client_code',
            label_ar: 'رمز العميل',
            label_en: 'Client Code',
            type: 'auto_id',
            required: false,
            order: 0,
            section_id: clientsBasicSectionId,
            width: 'half',
            show_in_table: true,
            auto_id_prefix: 'CLT-',
            auto_id_padding: 4,
            auto_id_start_value: 1,
            auto_id_scope_field_id: null,
            auto_id_counters: {},
          },
          {
            id: clientNameFieldId,
            name: 'client_name',
            label_ar: 'اسم العميل',
            label_en: 'Client Name',
            type: 'text',
            required: true,
            order: 1,
            section_id: clientsBasicSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'phone_number',
            label_ar: 'رقم الجوال',
            label_en: 'Mobile Number',
            type: 'phone',
            required: true,
            order: 2,
            section_id: clientsBasicSectionId,
            width: 'half',
            show_in_table: true,
            default_country_code: '+966',
          },
          {
            id: clientStatusFieldId,
            name: 'client_status',
            label_ar: 'حالة العميل',
            label_en: 'Client Status',
            type: 'dropdown',
            required: false,
            order: 3,
            section_id: clientsBasicSectionId,
            width: 'half',
            show_in_table: true,
            options: CLIENT_STATUS_OPTIONS,
          },
          {
            id: uuid(),
            name: 'client_stage',
            label_ar: 'مرحلة العميل',
            label_en: 'Client Stage',
            type: 'dropdown',
            required: false,
            order: 4,
            section_id: clientsBasicSectionId,
            width: 'half',
            show_in_table: true,
            options: CLIENT_STAGE_OPTIONS,
          },
          {
            id: uuid(),
            name: 'client_sources',
            label_ar: 'مصادر العميل',
            label_en: 'Client Sources',
            type: 'multiselect',
            required: false,
            order: 5,
            section_id: clientsBasicSectionId,
            width: 'half',
            show_in_table: true,
            options: CLIENT_SOURCE_OPTIONS,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'الملاحظات',
            label_en: 'Notes',
            type: 'notes',
            required: false,
            order: 6,
            section_id: clientsBasicSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
      {
        id: clientsPrefsSectionId,
        label_ar: 'تفضيلات العميل',
        label_en: 'Client Preferences',
        order: 1,
        is_base: true,
        color: '#C09B5F',
        fields: [
          {
            id: uuid(),
            name: 'preferred_projects',
            label_ar: 'المشاريع المفضلة',
            label_en: 'Preferred Projects',
            type: 'lookup',
            required: false,
            order: 0,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
            is_multi: true,
          },
          {
            id: uuid(),
            name: 'preferred_units',
            label_ar: 'الوحدات المفضلة',
            label_en: 'Preferred Units',
            type: 'lookup',
            required: false,
            order: 1,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: unitsId,
            lookup_display_field: 'unit_name',
            is_multi: true,
          },
          {
            id: uuid(),
            name: 'preferred_direction',
            label_ar: 'الإتجاه المفضل',
            label_en: 'Preferred Direction',
            type: 'multiselect',
            required: false,
            order: 2,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: DIRECTION_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_neighborhoods',
            label_ar: 'الأحياء المفضلة',
            label_en: 'Preferred Neighborhoods',
            type: 'multiselect',
            required: false,
            order: 3,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: DISTRICT_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_area',
            label_ar: 'المساحة المفضلة للعميل',
            label_en: 'Preferred Area',
            type: 'range',
            required: false,
            order: 4,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            range_min: 100,
            range_max: 2000,
            range_step: 50,
            range_unit_ar: 'م²',
            range_unit_en: 'm²',
          },
          {
            id: uuid(),
            name: 'preferred_city',
            label_ar: 'المدينة المفضلة',
            label_en: 'Preferred City',
            type: 'multiselect',
            required: false,
            order: 5,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: CITY_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_language',
            label_ar: 'اللغة المفضلة للعميل',
            label_en: 'Preferred Language',
            type: 'dropdown',
            required: false,
            order: 6,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: LANGUAGE_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_country',
            label_ar: 'الدولة المفضلة',
            label_en: 'Preferred Country',
            type: 'multiselect',
            required: false,
            order: 7,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: COUNTRY_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_unit_type',
            label_ar: 'نوع الوحدة المفضل للعميل',
            label_en: 'Preferred Unit Type',
            type: 'multiselect',
            required: false,
            order: 8,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: CLIENT_UNIT_TYPE_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_amenities',
            label_ar: 'المرافق المفضلة للعميل',
            label_en: 'Preferred Amenities',
            type: 'multiselect',
            required: false,
            order: 9,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: AMENITY_OPTIONS,
          },
          {
            id: uuid(),
            name: 'budget',
            label_ar: 'الميزانية',
            label_en: 'Budget',
            type: 'range',
            required: false,
            order: 10,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            range_min: 50000,
            range_max: 5000000,
            range_step: 50000,
            range_unit_ar: 'ر.س',
            range_unit_en: 'SAR',
          },
        ],
      },
      // WhatsApp History — derived view of every chat_messages row exchanged
      // with this client across every Haberchat device (i.e. every one of OUR
      // phone numbers). Single field of type `whatsapp_history`, no stored value.
      {
        id: clientsWhatsAppSectionId,
        label_ar: 'سجل واتساب',
        label_en: 'WhatsApp History',
        order: 2,
        is_base: false,
        color: '#25D366',
        fields: [
          {
            id: uuid(),
            name: 'whatsapp_history',
            label_ar: 'سجل واتساب',
            label_en: 'WhatsApp History',
            type: 'whatsapp_history',
            required: false,
            order: 0,
            section_id: clientsWhatsAppSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
      // Calls — derived view of every Hatif-logged call from/to any phone on
      // the client's record. Renders inline via the `call_history` field type
      // in SectionBlock. Only the clients model ships with this field; other
      // models that want call history can add the field via the Builder.
      // RecordFormPage no longer carries a bottom-of-form fallback — call
      // history is strictly opt-in via the field type.
      {
        id: clientsCallsSectionId,
        label_ar: 'سجل المكالمات',
        label_en: 'Calls',
        order: 3,
        is_base: false,
        color: '#3B82F6',
        fields: [
          {
            id: uuid(),
            name: 'call_history',
            label_ar: 'سجل المكالمات',
            label_en: 'Call History',
            type: 'call_history',
            required: false,
            order: 0,
            section_id: clientsCallsSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// 2. FOLLOW-UPS MODEL
// ============================================================
export const followupsId = uuid();
const fuBasicSectionId = uuid();
export const fuPrefsSectionId = uuid();
const fuCallSectionId = uuid();
const fuAppointmentSectionId = uuid();
// Exported — referenced by the D1 workflow seed (create_record action sets
// `followup_type = [<sectionId>]` to drop the created row into one of these types).
export const fuPostVisitSectionId = uuid();
export const fuWhatsAppSectionId = uuid();
export const fuCallToBookSectionId = uuid();

const fuClientFieldId = uuid();
const fuTypeFieldId = uuid();
const fuAppointmentFieldId = uuid(); // appointment_id lookup — now in base section, gated by call_result == 'rescheduled'
const fuCallResultFieldId = uuid();  // the consolidated `call_result` field — exported below for workflow seeding
const fuStatusFieldId = uuid();      // `status` field used by D2 cascade-cancel (active / cancelled / completed)

// Shared "call result" options — now the option list for the single
// `call_result` field that replaced the four per-section result fields. Uses
// English slugs to match the codebase convention (workflows / filters / scope
// rules reference these slugs as literal strings). The seed extends the
// original 6 values with three more slugs reused from `APPOINTMENT_STATUS_OPTIONS`
// (`scheduled` / `confirmed` / `cancelled`) so the consolidated result field
// can capture the full appointment lifecycle without introducing new slugs.
// Duplicated per-call with fresh option IDs to keep instances independent.
const CALL_RESULT_OPTIONS = (): FieldOption[] => [
  { id: uuid(), label_ar: 'مهتم',        label_en: 'Interested',         value: 'interested',     color: '#10B981' },
  { id: uuid(), label_ar: 'غير مهتم',    label_en: 'Not Interested',     value: 'not_interested', color: '#EF4444' },
  { id: uuid(), label_ar: 'لم يرد',      label_en: 'No Answer',          value: 'no_answer',      color: '#6B7280' },
  { id: uuid(), label_ar: 'مؤجل',        label_en: 'Postponed',          value: 'postponed',      color: '#F59E0B' },
  { id: uuid(), label_ar: 'يحتاج متابعة', label_en: 'Needs Follow-Up',   value: 'needs_followup', color: '#3B82F6' },
  // Appointment lifecycle outcomes — referenced by B2/B3/B4/B6 visible_if rules.
  { id: uuid(), label_ar: 'مجدول',       label_en: 'Scheduled',          value: 'scheduled',      color: '#3B82F6' },
  { id: uuid(), label_ar: 'مؤكد',        label_en: 'Confirmed',          value: 'confirmed',      color: '#10B981' },
  { id: uuid(), label_ar: 'ملغي',        label_en: 'Cancelled',          value: 'cancelled',      color: '#6B7280' },
  { id: uuid(), label_ar: 'معاد جدولته', label_en: 'Rescheduled',        value: 'rescheduled',    color: '#8B5CF6' },
];

// WHATSAPP_RESULT_OPTIONS was deleted 2026-05-18 — there's now a single
// `call_result` field on the base section that all follow-up types share.
// Per-section results (`appt_call_result`, `pv_call_result`, `whatsapp_result`)
// are gone. The data migration in `migration_10_to_11` consolidates legacy
// values into `call_result`.

// Status of an individual follow-up. Used by the appointment-date-change
// cascade (D2) to mark follow-ups linked to the rescheduled appointment as
// cancelled rather than deleting them — preserves the audit trail.
const FOLLOWUP_STATUS_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'نشطة',  label_en: 'Active',    value: 'active',    color: '#10B981' },
  { id: uuid(), label_ar: 'منجزة', label_en: 'Completed', value: 'completed', color: '#8B5CF6' },
  { id: uuid(), label_ar: 'ملغاة', label_en: 'Cancelled', value: 'cancelled', color: '#6B7280' },
];

// Local options for the WhatsApp branch's `next_followup_type` field. Two
// values only — picks whether the auto-created next follow-up is a recall or
// another WhatsApp message. The D1 workflow branches on this value (and on
// client visit history when 'recall').
const NEXT_FOLLOWUP_TYPE_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'اتصال',  label_en: 'Recall',   value: 'recall',   color: '#3B82F6' },
  { id: uuid(), label_ar: 'واتساب', label_en: 'WhatsApp', value: 'whatsapp', color: '#25D366' },
];

const followupsModel: AppModel = {
  id: followupsId,
  name: 'followups',
  label_ar: 'المتابعات',
  label_en: 'Follow-ups',
  icon: 'phone-call',
  color: '#C09B5F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: fuClientFieldId,
    subtitle_field_id: null,
    badge_field_id: fuTypeFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    section_selector_field_id: fuTypeFieldId,
    sections: [
      {
        id: fuBasicSectionId,
        label_ar: 'المعلومات الأساسية',
        label_en: 'Basic Info',
        order: 0,
        is_base: true,
        color: '#C09B5F',
        fields: [
          {
            id: fuClientFieldId,
            name: 'client_id',
            label_ar: 'العميل',
            label_en: 'Client',
            type: 'lookup',
            required: true,
            order: 0,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: clientsId,
            lookup_display_field: 'client_name',
          },
          {
            id: uuid(),
            name: 'client_name',
            label_ar: 'اسم العميل',
            label_en: 'Client Name',
            type: 'mirror',
            required: false,
            order: 1,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: false,
            mirror_via_lookup_field_id: fuClientFieldId,
            mirror_target_field_name: 'client_name',
          },
          {
            id: uuid(),
            name: 'client_phone',
            label_ar: 'رقم جوال العميل',
            label_en: 'Client Phone',
            type: 'mirror',
            required: false,
            order: 2,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
            mirror_via_lookup_field_id: fuClientFieldId,
            mirror_target_field_name: 'phone_number',
          },
          {
            id: uuid(),
            name: 'scheduled_datetime',
            label_ar: 'موعد المتابعة المجدول',
            label_en: 'Scheduled Follow-up',
            type: 'datetime',
            required: true,
            order: 3,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'actual_datetime',
            label_ar: 'موعد المتابعة الفعلي',
            label_en: 'Actual Follow-up',
            type: 'datetime',
            required: false,
            order: 4,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'sales_rep',
            label_ar: 'مندوب المبيعات',
            label_en: 'Sales Rep',
            type: 'assignee',
            required: false,
            order: 5,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
            assignee_role_ids: [],
          },
          {
            id: fuTypeFieldId,
            name: 'followup_type',
            label_ar: 'نوع المتابعة',
            label_en: 'Follow-up Type',
            type: 'section_selector',
            required: true,
            order: 6,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: fuCallSectionId,       label_ar: 'مكالمة',                label_en: 'Call',                     value: fuCallSectionId,       color: '#3B82F6', is_section_option: true },
              { id: fuAppointmentSectionId,label_ar: 'تأكيد موعد',            label_en: 'Appointment Confirmation', value: fuAppointmentSectionId,color: '#10B981', is_section_option: true },
              { id: fuPostVisitSectionId,  label_ar: 'متابعة بعد الزيارة',     label_en: 'Post-Visit Follow-Up',     value: fuPostVisitSectionId,  color: '#F59E0B', is_section_option: true },
              { id: fuWhatsAppSectionId,   label_ar: 'متابعة واتساب',         label_en: 'WhatsApp Follow-Up',       value: fuWhatsAppSectionId,   color: '#25D366', is_section_option: true },
              { id: fuCallToBookSectionId, label_ar: 'اتصال لحجز موعد',        label_en: 'Call to Book Appointment', value: fuCallToBookSectionId, color: '#0EA5E9', is_section_option: true },
            ],
          },
          {
            // Single shared result field across every follow-up type. Moved
            // from the Call section 2026-05-18; the per-type result fields
            // (appt_call_result, pv_call_result, whatsapp_result) were deleted
            // at the same time. Conditional fields (reason_*, next_followup_*,
            // appointment_id) gate their visibility on this field's value.
            id: fuCallResultFieldId,
            name: 'call_result',
            label_ar: 'النتيجة',
            label_en: 'Result',
            type: 'dropdown',
            required: false,
            order: 7,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
            options: CALL_RESULT_OPTIONS(),
          },
          {
            // Set by the D2 cascade workflow when the parent appointment's
            // date changes — every linked follow-up gets status=cancelled so
            // the user can re-fire the appointment workflow on the new date
            // without dangling stale calls.
            id: fuStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 8,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: true,
            options: FOLLOWUP_STATUS_OPTIONS,
          },
          {
            // Conditional — shows only when result == 'not_interested'.
            id: uuid(),
            name: 'reason_not_interested',
            label_ar: 'سبب عدم الاهتمام',
            label_en: 'Reason for not interested',
            type: 'textarea',
            required: false,
            order: 9,
            section_id: fuBasicSectionId,
            width: 'full',
            show_in_table: false,
            visible_if: { all: [{ field_name: 'call_result', operator: 'equals', value: 'not_interested' }] },
          },
          {
            // Conditional — shows only when result == 'cancelled'.
            id: uuid(),
            name: 'reason_cancellation',
            label_ar: 'سبب الإلغاء',
            label_en: 'Reason for cancellation',
            type: 'textarea',
            required: false,
            order: 10,
            section_id: fuBasicSectionId,
            width: 'full',
            show_in_table: false,
            visible_if: { all: [{ field_name: 'call_result', operator: 'equals', value: 'cancelled' }] },
          },
          {
            // Rescheduling sub-flow: when the agent picks "rescheduled" as
            // the result, they pick the appointment to reschedule via this
            // lookup. Once selected, rescheduled_appointment_date /
            // rescheduled_appointment_project below become visible — editing
            // them triggers D3, which writes back to the appointment record
            // and (via D2) cascades cancellation to all linked follow-ups.
            //
            // Moved here from the Appointment Confirmation section so it
            // doesn't depend on the user having also picked that section in
            // followup_type — `result == 'rescheduled'` is the only gate.
            id: fuAppointmentFieldId,
            name: 'appointment_id',
            label_ar: 'الموعد',
            label_en: 'Appointment',
            type: 'lookup',
            required: false,
            order: 11,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: appointmentsId,
            lookup_display_field: 'appointment_date',
            visible_if: { all: [{ field_name: 'call_result', operator: 'equals', value: 'rescheduled' }] },
          },
          {
            // The new date & time the appointment is being moved to. Written
            // back to appointments.appointment_date by D3 on save.
            id: uuid(),
            name: 'rescheduled_appointment_date',
            label_ar: 'تاريخ ووقت الموعد الجديد',
            label_en: 'New Appointment Date & Time',
            type: 'datetime',
            required: false,
            order: 12,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: false,
            visible_if: { all: [
              { field_name: 'call_result',    operator: 'equals', value: 'rescheduled' },
              { field_name: 'appointment_id', operator: 'is_set' },
            ] },
          },
          {
            // The (optionally new) project the customer wants for the
            // rescheduled appointment. Written back to appointments.project_id
            // by D3 on save.
            id: uuid(),
            name: 'rescheduled_appointment_project',
            label_ar: 'مشروع الموعد الجديد',
            label_en: 'New Appointment Project',
            type: 'lookup',
            required: false,
            order: 13,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
            visible_if: { all: [
              { field_name: 'call_result',    operator: 'equals', value: 'rescheduled' },
              { field_name: 'appointment_id', operator: 'is_set' },
            ] },
          },
          {
            // Set by the on_due sweeper (api/sweep-due-followups.ts) the
            // first time it fires this row, so we don't double-fire on the
            // next sweep tick. Hidden from the table; users shouldn't edit.
            id: uuid(),
            name: 'fired_at',
            label_ar: 'وقت تشغيل التذكير الآلي',
            label_en: 'Auto-Reminder Fired At',
            type: 'datetime',
            required: false,
            order: 99,
            section_id: fuBasicSectionId,
            width: 'half',
            show_in_table: false,
          },
        ],
      },
      {
        // Client Preferences — mirrored entirely from the linked client's Preferences section.
        // Fields are empty locally; resolved at render time by sectionMirrorResolver.
        id: fuPrefsSectionId,
        label_ar: 'تفضيلات العميل',
        label_en: 'Client Preferences',
        order: 1,
        is_base: true,
        color: '#C09B5F',
        fields: [],
        is_mirrored: true,
        mirror_via_lookup_field_id: fuClientFieldId,
        mirror_source_section_id: clientsPrefsSectionId,
      },
      {
        // "Call" type — section body is now empty; the consolidated
        // `call_result` field on the base section captures the outcome.
        // The section still exists so the user can pick "Call" as a
        // follow-up type via the section_selector.
        id: fuCallSectionId,
        label_ar: 'مكالمة',
        label_en: 'Call',
        order: 2,
        is_base: false,
        color: '#3B82F6',
        fields: [],
      },
      {
        id: fuAppointmentSectionId,
        label_ar: 'تأكيد الموعد',
        label_en: 'Appointment Confirmation',
        order: 3,
        is_base: false,
        color: '#10B981',
        fields: [
          {
            // Inline list of every appointment for this client. Click a row
            // to open the appointment record in a nested modal. Read-only —
            // for picking an appointment to reschedule, use the base-section
            // `appointment_id` lookup which appears when result=rescheduled.
            id: uuid(),
            name: 'client_appointments',
            label_ar: 'مواعيد العميل',
            label_en: 'Client Appointments',
            type: 'related_records',
            required: false,
            order: 0,
            section_id: fuAppointmentSectionId,
            width: 'full',
            show_in_table: false,
            related_records_model_id: appointmentsId,
            related_records_match_field_name: 'client_id',
            related_records_match_source_field_name: 'client_id',
            related_records_display_fields: ['appointment_date', 'project_id'],
            related_records_status_field: 'status',
          },
        ],
      },
      {
        id: fuPostVisitSectionId,
        label_ar: 'متابعة بعد الزيارة',
        label_en: 'Post-Visit Follow-Up',
        order: 4,
        is_base: false,
        color: '#F59E0B',
        fields: [
          {
            id: uuid(),
            name: 'post_visit_project',
            label_ar: 'المشروع',
            label_en: 'Project',
            type: 'lookup',
            required: false,
            order: 0,
            section_id: fuPostVisitSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
          },
          {
            id: uuid(),
            name: 'post_visit_unit',
            label_ar: 'الوحدة',
            label_en: 'Unit',
            type: 'lookup',
            required: false,
            order: 1,
            section_id: fuPostVisitSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: unitsId,
            lookup_display_field: 'unit_name',
          },
          {
            // Inline list of every visit for this client. Click a row to
            // open the visit record in a nested modal. Same UX as
            // client_appointments above.
            id: uuid(),
            name: 'client_visits',
            label_ar: 'زيارات العميل',
            label_en: 'Client Visits',
            type: 'related_records',
            required: false,
            order: 2,
            section_id: fuPostVisitSectionId,
            width: 'full',
            show_in_table: false,
            related_records_model_id: visitsId,
            related_records_match_field_name: 'client_id',
            related_records_match_source_field_name: 'client_id',
            related_records_display_fields: ['scheduled_datetime', 'project_id'],
          },
        ],
      },
      {
        id: fuWhatsAppSectionId,
        label_ar: 'متابعة واتساب',
        label_en: 'WhatsApp Follow-Up',
        order: 5,
        is_base: false,
        color: '#25D366',
        fields: [
          {
            // The date & time the next follow-up is scheduled for. The D1
            // workflow reads this on save and creates a new follow-up record.
            // Hidden when `call_result` is one of the terminal outcomes
            // (booked / confirmed / cancelled / not_interested) since those
            // close the conversation.
            id: uuid(),
            name: 'next_followup_datetime',
            label_ar: 'تاريخ ووقت المتابعة التالية',
            label_en: 'Next Follow-up Date & Time',
            type: 'datetime',
            required: false,
            order: 0,
            section_id: fuWhatsAppSectionId,
            width: 'half',
            show_in_table: false,
            visible_if: { all: [
              { field_name: 'followup_type', operator: 'contains', value: fuWhatsAppSectionId },
              { field_name: 'call_result',   operator: 'not_in',   value: ['not_interested', 'scheduled', 'cancelled', 'confirmed'] },
            ] },
          },
          {
            // Type of the next follow-up — D1 reads this to decide what
            // follow-up to create. `whatsapp` → another WhatsApp follow-up.
            // `recall` → branches on client visit history: any visit →
            // Post-Visit Follow-Up; no visit → Call to Book Appointment.
            id: uuid(),
            name: 'next_followup_type',
            label_ar: 'نوع المتابعة التالية',
            label_en: 'Next Follow-up Type',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: fuWhatsAppSectionId,
            width: 'half',
            show_in_table: false,
            options: NEXT_FOLLOWUP_TYPE_OPTIONS,
            visible_if: { all: [
              { field_name: 'followup_type', operator: 'contains', value: fuWhatsAppSectionId },
              { field_name: 'call_result',   operator: 'not_in',   value: ['not_interested', 'scheduled', 'cancelled', 'confirmed'] },
            ] },
          },
        ],
      },
      {
        // "Call to Book Appointment" — the type that D1 creates for clients
        // who have never visited. Section body is empty; the `call_result`
        // field on the base section captures the outcome.
        id: fuCallToBookSectionId,
        label_ar: 'اتصال لحجز موعد',
        label_en: 'Call to Book Appointment',
        order: 6,
        is_base: false,
        color: '#0EA5E9',
        fields: [],
      },
    ],
    // Three action buttons surfaced in the follow-up record form. All
    // three carry the trigger record's client through to the target via
    // a `client_id → client_id` prefill mapping. "Register a visit" runs
    // a find-or-create against the visits model: latest visit for this
    // client wins; if there is none, a blank visit form opens prefilled.
    custom_buttons: [
      {
        // Was "Book a visit" → renamed 2026-05-18 to "Schedule an appointment"
        // and re-targeted from visits to appointments. Only asks for the
        // appointment date + project — client info flows in via prefill +
        // the appointment model's own auto-fill from client_id.
        id: uuid(),
        label_ar: 'حجز موعد',
        label_en: 'Schedule an appointment',
        icon: 'calendar-plus',
        locations: ['record_form'],
        action: {
          type: 'create_record',
          target_model_id: appointmentsId,
          prefill: [{ target_field_name: 'client_id', source_field_name: 'client_id' }],
          visible_field_names: ['appointment_date', 'project_id'],
        },
      },
      {
        // Schedule follow-up — only asks for the scheduled date & time.
        // Client info, follow-up type, etc. are all left to the agent to
        // fill in on the resulting record (or via auto-link).
        id: uuid(),
        label_ar: 'جدولة متابعة',
        label_en: 'Schedule follow-up',
        icon: 'calendar-clock',
        locations: ['record_form'],
        action: {
          type: 'create_record',
          target_model_id: followupsId,
          prefill: [{ target_field_name: 'client_id', source_field_name: 'client_id' }],
          visible_field_names: ['scheduled_datetime'],
        },
      },
      {
        // Unchanged — find-or-create on visits. Used after an actual visit
        // happens so the agent can log it without leaving the follow-up.
        id: uuid(),
        label_ar: 'تسجيل زيارة',
        label_en: 'Register a visit',
        icon: 'map-pin-check',
        locations: ['record_form'],
        action: {
          type: 'find_or_create_record',
          target_model_id: visitsId,
          search_by: [{ target_field_name: 'client_id', source_field_name: 'client_id' }],
          order_by: 'created_at_desc',
          prefill: [{ target_field_name: 'client_id', source_field_name: 'client_id' }],
        },
      },
    ],
  },
};

// ============================================================
// APPOINTMENTS MODEL (new)
// ============================================================
const apptBaseSectionId = uuid();
const apptClientFieldId = uuid();
const apptDateFieldId = uuid();
const apptStatusFieldId = uuid();

const APPOINTMENT_STATUS_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'مجدول', label_en: 'Scheduled', value: 'scheduled', color: '#3B82F6' },
  { id: uuid(), label_ar: 'مؤكد', label_en: 'Confirmed', value: 'confirmed', color: '#10B981' },
  { id: uuid(), label_ar: 'معاد جدولته', label_en: 'Rescheduled', value: 'rescheduled', color: '#F59E0B' },
  { id: uuid(), label_ar: 'منتهي', label_en: 'Completed', value: 'completed', color: '#8B5CF6' },
  { id: uuid(), label_ar: 'لم يحضر', label_en: 'No-show', value: 'no_show', color: '#EF4444' },
  { id: uuid(), label_ar: 'ملغي', label_en: 'Cancelled', value: 'cancelled', color: '#6B7280' },
];

const appointmentsModel: AppModel = {
  id: appointmentsId,
  name: 'appointments',
  label_ar: 'المواعيد',
  label_en: 'Appointments',
  icon: 'calendar-check',
  color: '#10B981',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: apptDateFieldId,
    subtitle_field_id: apptClientFieldId,
    badge_field_id: apptStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: apptBaseSectionId,
        label_ar: 'الأساسية',
        label_en: 'Basic',
        order: 0,
        is_base: true,
        color: '#10B981',
        fields: [
          {
            // Phone-first entry. Typing a phone debounce-searches clients;
            // exact match → links via client_id; zero matches → creates a
            // new minimal client (just the phone) and links to it. Same
            // bidirectional auto-fill as the visits model. Order 0 so the
            // form opens with the phone as the first focus.
            id: uuid(),
            name: 'phone_number',
            label_ar: 'رقم جوال العميل',
            label_en: 'Client Phone',
            type: 'phone',
            required: false,
            order: 0,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: true,
            default_country_code: '+966',
            auto_link_lookup_field_id: apptClientFieldId,
            auto_link_target_field_name: 'phone_number',
            auto_link_normalize: 'phone',
            // Create new client if no match: minimum 12 chars in the
            // normalized phone (E.164 SA mobile = +9665xxxxxxxx = 13).
            auto_link_create_if_missing: true,
            auto_link_create_min_length: 12,
            auto_fill_from_lookup_field_id: apptClientFieldId,
            auto_fill_source_field_name: 'phone_number',
          },
          {
            id: apptClientFieldId,
            name: 'client_id',
            label_ar: 'العميل',
            label_en: 'Client',
            type: 'lookup',
            required: true,
            order: 1,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: clientsId,
            lookup_display_field: 'client_name',
          },
          {
            // Auto-fills from the linked client's client_name. Editable;
            // overrides survive until the user picks a different client.
            id: uuid(),
            name: 'client_name',
            label_ar: 'اسم العميل',
            label_en: 'Client Name',
            type: 'text',
            required: false,
            order: 2,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: false,
            auto_fill_from_lookup_field_id: apptClientFieldId,
            auto_fill_source_field_name: 'client_name',
          },
          {
            id: apptDateFieldId,
            name: 'appointment_date',
            label_ar: 'تاريخ الموعد',
            label_en: 'Appointment Date',
            type: 'datetime',
            required: true,
            order: 3,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'project_id',
            label_ar: 'المشروع',
            label_en: 'Project',
            type: 'lookup',
            required: false,
            order: 4,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
          },
          {
            id: uuid(),
            name: 'sales_rep',
            label_ar: 'مندوب المبيعات',
            label_en: 'Sales Rep',
            type: 'assignee',
            required: false,
            order: 5,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: true,
            assignee_role_ids: [],
          },
          {
            id: apptStatusFieldId,
            name: 'appointment_status',
            label_ar: 'حالة الموعد',
            label_en: 'Appointment Status',
            type: 'dropdown',
            required: false,
            order: 6,
            section_id: apptBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: APPOINTMENT_STATUS_OPTIONS,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 7,
            section_id: apptBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// UNITS MODEL (new) — lives in the Projects group
// ============================================================
const unitsBaseSectionId = uuid();
const unitNameFieldId = uuid();
const unitProjectFieldId = uuid();
const unitStatusFieldId = uuid();

const UNIT_STATUS_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'متاحة', label_en: 'Available', value: 'available', color: '#10B981' },
  { id: uuid(), label_ar: 'محجوزة', label_en: 'Reserved', value: 'reserved', color: '#F59E0B' },
  { id: uuid(), label_ar: 'مباعة', label_en: 'Sold', value: 'sold', color: '#8B5CF6' },
];

const unitsModel: AppModel = {
  id: unitsId,
  name: 'units',
  label_ar: 'الوحدات',
  label_en: 'Units',
  icon: 'home',
  color: '#8E4E3A',
  group_id: PROJECTS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: unitNameFieldId,
    subtitle_field_id: unitProjectFieldId,
    badge_field_id: unitStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: unitsBaseSectionId,
        label_ar: 'الأساسية',
        label_en: 'Basic',
        order: 0,
        is_base: true,
        color: '#8E4E3A',
        fields: [
          {
            id: unitNameFieldId,
            name: 'unit_name',
            label_ar: 'اسم الوحدة',
            label_en: 'Unit Name',
            type: 'text',
            required: true,
            order: 0,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: unitProjectFieldId,
            name: 'project_id',
            label_ar: 'المشروع',
            label_en: 'Project',
            type: 'lookup',
            required: true,
            order: 1,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
          },
          {
            id: uuid(),
            name: 'unit_type',
            label_ar: 'نوع الوحدة',
            label_en: 'Unit Type',
            type: 'dropdown',
            required: false,
            order: 2,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: CLIENT_UNIT_TYPE_OPTIONS.map((o) => ({ ...o, id: uuid() })),
          },
          {
            id: unitStatusFieldId,
            name: 'unit_status',
            label_ar: 'حالة الوحدة',
            label_en: 'Unit Status',
            type: 'dropdown',
            required: false,
            order: 3,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: UNIT_STATUS_OPTIONS,
          },
          {
            id: uuid(),
            name: 'area_sqm',
            label_ar: 'المساحة (م²)',
            label_en: 'Area (m²)',
            type: 'number',
            required: false,
            order: 4,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'price',
            label_ar: 'السعر',
            label_en: 'Price',
            type: 'currency',
            required: false,
            order: 5,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 6,
            section_id: unitsBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// 3. ALL PROJECTS MODEL
// ============================================================
// allProjectsId is declared at the top of the file so earlier models (clients)
// can reference it via lookup_model_id.
const apBaseSectionId = uuid();
const apWebsiteSectionId = uuid();
const apNameFieldId = uuid();
const apStatusFieldId = uuid();
const apLocationFieldId = uuid();

const allProjectsModel: AppModel = {
  id: allProjectsId,
  name: 'all_projects',
  label_ar: 'جميع المشاريع',
  label_en: 'All Projects',
  icon: 'building-2',
  color: '#8E4E3A',
  group_id: PROJECTS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: apNameFieldId,
    subtitle_field_id: null,
    badge_field_id: apStatusFieldId,
    shown_field_ids: [],
  },
  // Wired so the CRM Maps view AND the public website map page resolve
  // project locations from the `location` text field (admin pastes a Google
  // Maps URL or a bare "lat,lng" pair — both are handled by parseGoogleMapsUrl
  // in lib/locationUtils). Pin label = project name, color = status option's
  // color. Admins can repoint these in the Maps Builder.
  maps_config: {
    ...MAPS_CONFIG_DEFAULT,
    location_url_field_id: apLocationFieldId,
    pin_label_field_id: apNameFieldId,
    pin_color_field_id: apStatusFieldId,
    popup_title_field_id: apNameFieldId,
    popup_badge_field_id: apStatusFieldId,
  },
  schema: {
    sections: [
      {
        id: apBaseSectionId,
        label_ar: 'معلومات المشروع',
        label_en: 'Project Information',
        order: 0,
        is_base: true,
        color: '#8E4E3A',
        fields: [
          {
            id: apNameFieldId,
            name: 'project_name',
            label_ar: 'اسم المشروع',
            label_en: 'Project Name',
            type: 'text',
            required: true,
            order: 0,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'developer',
            label_ar: 'المطور',
            label_en: 'Developer',
            type: 'text',
            required: false,
            order: 1,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: apLocationFieldId,
            name: 'location',
            label_ar: 'الموقع',
            label_en: 'Location',
            type: 'text',
            required: false,
            order: 2,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: apStatusFieldId,
            name: 'project_status',
            label_ar: 'حالة المشروع',
            label_en: 'Project Status',
            type: 'dropdown',
            required: false,
            order: 3,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'على الخارطة', label_en: 'Off-plan', value: 'off_plan', color: '#3B82F6' },
              { id: uuid(), label_ar: 'قيد الإنشاء', label_en: 'Under Construction', value: 'under_construction', color: '#F59E0B' },
              { id: uuid(), label_ar: 'جاهز', label_en: 'Ready', value: 'ready', color: '#10B981' },
            ],
          },
          {
            id: uuid(),
            name: 'min_price',
            label_ar: 'أقل سعر',
            label_en: 'Min Price',
            type: 'currency',
            required: false,
            order: 4,
            section_id: apBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'max_price',
            label_ar: 'أعلى سعر',
            label_en: 'Max Price',
            type: 'currency',
            required: false,
            order: 5,
            section_id: apBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'units_available',
            label_ar: 'الوحدات المتاحة',
            label_en: 'Available Units',
            type: 'number',
            required: false,
            order: 6,
            section_id: apBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'project_url',
            label_ar: 'رابط المشروع',
            label_en: 'Project URL',
            type: 'url',
            required: false,
            order: 7,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'brochure_link',
            label_ar: 'رابط البروشور',
            label_en: 'Brochure Link',
            type: 'url',
            required: false,
            order: 8,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'city',
            label_ar: 'المدينة',
            label_en: 'City',
            type: 'dropdown',
            required: false,
            order: 9,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: CITY_OPTIONS,
          },
          {
            id: uuid(),
            name: 'district',
            label_ar: 'الحي',
            label_en: 'District',
            type: 'dropdown',
            required: false,
            order: 10,
            section_id: apBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: DISTRICT_OPTIONS,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 11,
            section_id: apBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
      // Website-only knobs live in their own non-base section so admins see
      // them grouped together in the form. The public site reads `image_url`
      // (hero photo) and gates visibility on `is_public` (default off — RLS
      // policy in 2026-05-09_j only lets `is_public = true` rows reach anon).
      {
        id: apWebsiteSectionId,
        label_ar: 'إعدادات الموقع',
        label_en: 'Website Settings',
        order: 1,
        is_base: false,
        color: '#B8734F',
        fields: [
          {
            id: uuid(),
            name: 'image_url',
            label_ar: 'صورة المشروع',
            label_en: 'Project Image',
            type: 'image',
            // Drop-zone uploader → marketing-assets bucket → public URL
            // stored as the field value. Same string shape as a `url`
            // field so the website's <img src=…> rendering keeps working.
            image_folder: 'reference',
            image_accept: 'image/png,image/jpeg,image/webp',
            image_max_size_mb: 10,
            required: false,
            order: 0,
            section_id: apWebsiteSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'is_public',
            label_ar: 'عرض على الموقع',
            label_en: 'Show on Website',
            type: 'checkbox',
            required: false,
            order: 1,
            section_id: apWebsiteSectionId,
            width: 'half',
            show_in_table: true,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// 4. TARGETED PROJECTS MODEL
// ============================================================
const targetedProjectsId = uuid();
const tpBaseSectionId = uuid();
const tpNameFieldId = uuid();
const tpPriorityFieldId = uuid();

const targetedProjectsModel: AppModel = {
  id: targetedProjectsId,
  name: 'targeted_projects',
  label_ar: 'المشاريع المستهدفة',
  label_en: 'Targeted Projects',
  icon: 'target',
  color: '#4A2C2A',
  group_id: PROJECTS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: tpNameFieldId,
    subtitle_field_id: null,
    badge_field_id: tpPriorityFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: tpBaseSectionId,
        label_ar: 'معلومات المشروع',
        label_en: 'Project Information',
        order: 0,
        is_base: true,
        color: '#4A2C2A',
        fields: [
          {
            id: tpNameFieldId,
            name: 'project_name',
            label_ar: 'اسم المشروع',
            label_en: 'Project Name',
            type: 'text',
            required: true,
            order: 0,
            section_id: tpBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'developer',
            label_ar: 'المطور',
            label_en: 'Developer',
            type: 'text',
            required: false,
            order: 1,
            section_id: tpBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: tpPriorityFieldId,
            name: 'priority',
            label_ar: 'الأولوية',
            label_en: 'Priority',
            type: 'dropdown',
            required: false,
            order: 2,
            section_id: tpBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'عالية', label_en: 'High', value: 'high', color: '#EF4444' },
              { id: uuid(), label_ar: 'متوسطة', label_en: 'Medium', value: 'medium', color: '#F59E0B' },
              { id: uuid(), label_ar: 'منخفضة', label_en: 'Low', value: 'low', color: '#10B981' },
            ],
          },
          {
            id: uuid(),
            name: 'target_date',
            label_ar: 'التاريخ المستهدف',
            label_en: 'Target Date',
            type: 'date',
            required: false,
            order: 3,
            section_id: tpBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'contact_person',
            label_ar: 'جهة الاتصال',
            label_en: 'Contact Person',
            type: 'text',
            required: false,
            order: 4,
            section_id: tpBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'contact_phone',
            label_ar: 'هاتف جهة الاتصال',
            label_en: 'Contact Phone',
            type: 'phone',
            required: false,
            order: 5,
            section_id: tpBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 6,
            section_id: tpBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// 5. OUR PROJECTS MODEL
// ============================================================
const ourProjectsId = uuid();
const opBaseSectionId = uuid();
const opNameFieldId = uuid();
const opPhaseFieldId = uuid();

const ourProjectsModel: AppModel = {
  id: ourProjectsId,
  name: 'our_projects',
  label_ar: 'مشاريعنا',
  label_en: 'Our Projects',
  icon: 'star',
  color: '#C09B5F',
  group_id: PROJECTS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: opNameFieldId,
    subtitle_field_id: null,
    badge_field_id: opPhaseFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: opBaseSectionId,
        label_ar: 'معلومات المشروع',
        label_en: 'Project Information',
        order: 0,
        is_base: true,
        color: '#C09B5F',
        fields: [
          {
            id: opNameFieldId,
            name: 'project_name',
            label_ar: 'اسم المشروع',
            label_en: 'Project Name',
            type: 'text',
            required: true,
            order: 0,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'location',
            label_ar: 'الموقع',
            label_en: 'Location',
            type: 'text',
            required: false,
            order: 1,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: opPhaseFieldId,
            name: 'phase',
            label_ar: 'المرحلة',
            label_en: 'Phase',
            type: 'dropdown',
            required: false,
            order: 2,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'تخطيط', label_en: 'Planning', value: 'planning', color: '#3B82F6' },
              { id: uuid(), label_ar: 'تسويق', label_en: 'Marketing', value: 'marketing', color: '#F59E0B' },
              { id: uuid(), label_ar: 'بيع', label_en: 'Selling', value: 'selling', color: '#10B981' },
              { id: uuid(), label_ar: 'مكتمل', label_en: 'Completed', value: 'completed', color: '#6B7280' },
            ],
          },
          {
            id: uuid(),
            name: 'total_units',
            label_ar: 'إجمالي الوحدات',
            label_en: 'Total Units',
            type: 'number',
            required: false,
            order: 3,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'sold_units',
            label_ar: 'الوحدات المباعة',
            label_en: 'Sold Units',
            type: 'number',
            required: false,
            order: 4,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 5,
            section_id: opBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// VISITS MODEL (2026-05-10)
// ============================================================
// Records of physical visits to projects. Reached from the Follow-Ups
// "Book a visit" / "Register a visit" buttons (which trigger the
// create_record / find_or_create_record button actions).
//
// Two pieces of UX worth knowing about:
//
// 1. The `client_id` lookup displays the client's `client_code` auto-ID
//    (e.g. "CLT-0001") in the dropdown rather than the client's name.
//    This is on purpose — the user identifies clients by code in the
//    visits flow.
//
// 2. The form is bidirectional on phone vs client_id:
//      - Typing into `phone` runs `useAutoLink` → searches clients by
//        `phone_number` (with normalizePhone()) → on a unique match
//        sets `client_id`.
//      - Picking `client_id` runs `useAutoFill` → fills `name` from
//        `client_name`. The phone field also auto-fills from
//        `phone_number`, but is editable and the user's typed value
//        wins until the lookup id changes.
//
// Kept as a builder model (NOT frozen) per explicit request — the
// schema is expected to evolve before being promoted to a typed table.
const visitsModel: AppModel = {
  id: visitsId,
  name: 'visits',
  label_ar: 'الزيارات',
  label_en: 'Visits',
  icon: 'map-pin',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: visitsNameFieldId,
    subtitle_field_id: visitsScheduledFieldId,
    badge_field_id: null,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: visitsBasicSectionId,
        label_ar: 'تفاصيل الزيارة',
        label_en: 'Visit Details',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: visitsClientFieldId,
            name: 'client_id',
            label_ar: 'العميل',
            label_en: 'Client',
            type: 'lookup',
            required: true,
            order: 0,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: clientsId,
            // Show the client's auto-id (CLT-0001 …) in the picker, not the name.
            lookup_display_field: 'client_code',
          },
          {
            id: visitsPhoneFieldId,
            name: 'phone',
            label_ar: 'رقم الجوال',
            label_en: 'Phone',
            type: 'phone',
            required: false,
            order: 1,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
            default_country_code: '+966',
            // Reverse-search: typing a phone hunts a client by phone_number
            // (after normalization) and sets client_id on a unique match.
            auto_link_lookup_field_id: visitsClientFieldId,
            auto_link_target_field_name: 'phone_number',
            auto_link_normalize: 'phone',
            // Forward auto-fill: when the user picks a client_id directly,
            // pull the client's phone_number into this editable field.
            auto_fill_from_lookup_field_id: visitsClientFieldId,
            auto_fill_source_field_name: 'phone_number',
          },
          {
            id: visitsNameFieldId,
            name: 'name',
            label_ar: 'الاسم',
            label_en: 'Name',
            type: 'text',
            required: false,
            order: 2,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
            auto_fill_from_lookup_field_id: visitsClientFieldId,
            auto_fill_source_field_name: 'client_name',
          },
          {
            id: visitsScheduledFieldId,
            name: 'scheduled_datetime',
            label_ar: 'موعد الزيارة',
            label_en: 'Scheduled Date & Time',
            type: 'datetime',
            required: false,
            order: 3,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: visitsProjectFieldId,
            name: 'project_id',
            label_ar: 'المشروع',
            label_en: 'Project',
            type: 'lookup',
            required: false,
            order: 4,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: ourProjectsId,
            lookup_display_field: 'project_name',
          },
        ],
      },
    ],
  },
};

// ============================================================
// 6. PROJECTS RESEARCH MODEL — REMOVED (2026-05-06)
// ============================================================
// The Projects Research model and its associated UI (research view editor,
// research-prompt modal on Targeted Projects creation, dedicated research
// PDF) have been removed. The seed entry, schema migrations, i18n labels,
// special-case branches in RecordFormPage, and the dedicated component
// files were deleted in the same change. To bring it back, restore from
// git history before commit 5110513..HEAD.


// ============================================================
// CHATS MODEL (WhatsApp conversations via Haberchat)
// ============================================================
// Conversations surface as ordinary records in the `records` table (keyed by
// uuidv5(chat_wid)). Messages live in a separate `chat_messages` table and
// are streamed via Supabase Realtime. See docs/prd/chats.md.
// The detail route is overridden to render ChatDetailPage instead of the
// generic RecordFormPage — see App.tsx dispatcher.

export const chatsId = uuid();
const chatsBaseSectionId = uuid();
const chatsNameFieldId = uuid();
const chatsPhoneFieldId = uuid();
const chatsStatusFieldId = uuid();

const chatsModel: AppModel = {
  id: chatsId,
  name: 'chats',
  label_ar: 'المحادثات',
  label_en: 'Chats',
  icon: 'message-circle',
  color: '#25D366',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: chatsNameFieldId,
    subtitle_field_id: chatsPhoneFieldId,
    badge_field_id: chatsStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: chatsBaseSectionId,
        label_ar: 'معلومات المحادثة',
        label_en: 'Conversation Info',
        order: 0,
        is_base: true,
        color: '#25D366',
        fields: [
          {
            id: uuid(),
            name: 'wid',
            label_ar: 'المعرف',
            label_en: 'WID',
            type: 'text',
            required: false,
            order: 0,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: chatsNameFieldId,
            name: 'name',
            label_ar: 'الاسم',
            label_en: 'Name',
            type: 'text',
            required: false,
            order: 1,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: chatsPhoneFieldId,
            name: 'phone',
            label_ar: 'رقم الهاتف',
            label_en: 'Phone',
            type: 'phone',
            required: false,
            order: 2,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: true,
            default_country_code: '+966',
          },
          {
            id: uuid(),
            name: 'kind',
            label_ar: 'النوع',
            label_en: 'Kind',
            type: 'dropdown',
            required: false,
            order: 3,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'محادثة', label_en: 'Direct', value: 'user' },
              { id: uuid(), label_ar: 'مجموعة', label_en: 'Group', value: 'group' },
              { id: uuid(), label_ar: 'قناة', label_en: 'Channel', value: 'channel' },
            ],
          },
          {
            id: uuid(),
            name: 'device_id',
            label_ar: 'الرقم المرتبط',
            label_en: 'Linked Number',
            type: 'text',
            required: false,
            order: 4,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: chatsStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 5,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'نشط', label_en: 'Active', value: 'active', color: '#22c55e' },
              { id: uuid(), label_ar: 'تم الحل', label_en: 'Resolved', value: 'resolved', color: '#6b7280' },
              { id: uuid(), label_ar: 'مؤرشف', label_en: 'Archived', value: 'archived', color: '#9ca3af' },
            ],
          },
          {
            id: uuid(),
            name: 'owner',
            label_ar: 'المسؤول',
            label_en: 'Owner',
            type: 'assignee',
            required: false,
            order: 6,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'labels',
            label_ar: 'التصنيفات',
            label_en: 'Labels',
            type: 'multiselect',
            required: false,
            order: 7,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: false,
            options: [],
          },
          {
            id: uuid(),
            name: 'unread_count',
            label_ar: 'غير مقروءة',
            label_en: 'Unread',
            type: 'number',
            required: false,
            order: 8,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'last_message_at',
            label_ar: 'آخر رسالة',
            label_en: 'Last Message',
            type: 'datetime',
            required: false,
            order: 9,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'last_message_preview',
            label_ar: 'معاينة',
            label_en: 'Preview',
            type: 'text',
            required: false,
            order: 10,
            section_id: chatsBaseSectionId,
            width: 'full',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'client_link',
            label_ar: 'العميل المرتبط',
            label_en: 'Linked Client',
            type: 'lookup',
            required: false,
            order: 11,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: clientsId,
            lookup_display_field: 'name',
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// AI CHATS MODEL (internal Wassel AI sales agent conversations)
// ============================================================
// Each record is one chat session between a user and the AI agent. Messages
// live inline in `record.data.messages` as a JSONB array — no separate table
// (unlike `chat_messages` for WhatsApp, which has external writers). The
// detail route is overridden to render AiAgentPage instead of the generic
// RecordFormPage — see App.tsx dispatcher.

export const aiChatsId = uuid();
const aiChatsBaseSectionId = uuid();
const aiChatsTitleFieldId = uuid();
const aiChatsStatusFieldId = uuid();
const aiChatsLastMessageFieldId = uuid();

const aiChatsModel: AppModel = {
  id: aiChatsId,
  name: 'ai_chats',
  label_ar: 'المساعد الذكي',
  label_en: 'AI Agent',
  icon: 'sparkles',
  color: '#7C3AED',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: aiChatsTitleFieldId,
    subtitle_field_id: aiChatsLastMessageFieldId,
    badge_field_id: aiChatsStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: aiChatsBaseSectionId,
        label_ar: 'معلومات المحادثة',
        label_en: 'Conversation',
        order: 0,
        is_base: true,
        color: '#7C3AED',
        fields: [
          {
            id: aiChatsTitleFieldId,
            name: 'title',
            label_ar: 'العنوان',
            label_en: 'Title',
            type: 'text',
            required: false,
            order: 0,
            section_id: aiChatsBaseSectionId,
            width: 'full',
            show_in_table: true,
          },
          {
            id: aiChatsStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: aiChatsBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'نشط', label_en: 'Active', value: 'active', color: '#22c55e' },
              { id: uuid(), label_ar: 'مؤرشف', label_en: 'Archived', value: 'archived', color: '#9ca3af' },
            ],
          },
          {
            id: uuid(),
            name: 'message_count',
            label_ar: 'عدد الرسائل',
            label_en: 'Messages',
            type: 'number',
            required: false,
            order: 2,
            section_id: aiChatsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: aiChatsLastMessageFieldId,
            name: 'last_message_at',
            label_ar: 'آخر رسالة',
            label_en: 'Last Message',
            type: 'datetime',
            required: false,
            order: 3,
            section_id: aiChatsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'linked_client_id',
            label_ar: 'العميل المرتبط',
            label_en: 'Linked Client',
            type: 'lookup',
            required: false,
            order: 4,
            section_id: aiChatsBaseSectionId,
            width: 'full',
            show_in_table: false,
            lookup_model_id: clientsId,
            lookup_display_field: 'name',
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// PHONE CALLS MODEL (Hatif call events as user-facing records)
// ============================================================
// Every inbound, outbound-IVR, and agent-placed call Hatif logs gets a
// lightweight "header" row in this model, keyed by uuidv5(callId), so the
// Builder machinery — views, filters, workflows, dashboards — works on
// calls out of the box. Full audio/AI data (word-level transcription,
// evaluation array, raw webhook JSON) lives in the dedicated `call_logs`
// table; the webhook writes to BOTH on every event. See docs/prd/calling.md.
//
// Workflow triggers: use `create_record` on this model with conditions.
// Examples:
//   - "missed incoming call":     direction = incoming AND status IN (missed, no_answer)
//   - "customer pressed 2 in IVR": dtmf_digit = 2
//   - "long call w/ negative tone": duration_seconds > 300 AND sentiment = negative

export const phoneCallsId = uuid();
const phoneCallsBaseSectionId = uuid();
const phoneCallsDirectionFieldId = uuid();
const phoneCallsStatusFieldId = uuid();
const phoneCallsCustomerPhoneFieldId = uuid();

const phoneCallsModel: AppModel = {
  id: phoneCallsId,
  name: 'phone_calls',
  label_ar: 'المكالمات',
  label_en: 'Phone Calls',
  icon: 'phone-call',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: phoneCallsCustomerPhoneFieldId,
    subtitle_field_id: phoneCallsStatusFieldId,
    badge_field_id: phoneCallsDirectionFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: phoneCallsBaseSectionId,
        label_ar: 'تفاصيل المكالمة',
        label_en: 'Call Details',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: uuid(),
            name: 'call_id',
            label_ar: 'معرّف المكالمة',
            label_en: 'Call ID',
            type: 'text',
            required: false,
            order: 0,
            section_id: phoneCallsBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: phoneCallsDirectionFieldId,
            name: 'direction',
            label_ar: 'الاتجاه',
            label_en: 'Direction',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'واردة',  label_en: 'Incoming', value: 'inbound',  color: '#3b82f6' },
              { id: uuid(), label_ar: 'صادرة', label_en: 'Outgoing', value: 'outbound', color: '#8b5cf6' },
            ],
          },
          {
            id: phoneCallsStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 2,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'مكتملة',   label_en: 'Completed',          value: 'completed',          color: '#22c55e' },
              { id: uuid(), label_ar: 'فائتة',    label_en: 'Missed',             value: 'missed',             color: '#ef4444' },
              { id: uuid(), label_ar: 'بدون رد',  label_en: 'No Answer',          value: 'no_answer',          color: '#f97316' },
              { id: uuid(), label_ar: 'مرفوضة',   label_en: 'Rejected (by them)', value: 'rejected_by_callee', color: '#dc2626' },
              { id: uuid(), label_ar: 'ملغاة',    label_en: 'Rejected (by us)',   value: 'rejected_by_caller', color: '#a3a3a3' },
              { id: uuid(), label_ar: 'ملغاة',    label_en: 'Cancelled',          value: 'cancelled',          color: '#a3a3a3' },
              { id: uuid(), label_ar: 'فشلت',     label_en: 'Failed',             value: 'failed',             color: '#991b1b' },
              { id: uuid(), label_ar: 'يرن',      label_en: 'Ringing',            value: 'ringing',            color: '#eab308' },
              { id: uuid(), label_ar: 'نشطة',     label_en: 'Active',             value: 'active',             color: '#eab308' },
            ],
          },
          {
            id: phoneCallsCustomerPhoneFieldId,
            name: 'customer_phone',
            label_ar: 'رقم العميل',
            label_en: 'Customer Phone',
            type: 'phone',
            required: false,
            order: 3,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
            default_country_code: '+966',
          },
          {
            id: uuid(),
            name: 'caller_number',
            label_ar: 'رقم المتصل',
            label_en: 'Caller Number',
            type: 'phone',
            required: false,
            order: 4,
            section_id: phoneCallsBaseSectionId,
            width: 'half',
            show_in_table: false,
            default_country_code: '+966',
          },
          {
            id: uuid(),
            name: 'callee_number',
            label_ar: 'رقم المتلقي',
            label_en: 'Callee Number',
            type: 'phone',
            required: false,
            order: 5,
            section_id: phoneCallsBaseSectionId,
            width: 'half',
            show_in_table: false,
            default_country_code: '+966',
          },
          {
            id: uuid(),
            name: 'duration_seconds',
            label_ar: 'مدة المكالمة (ثوانٍ)',
            label_en: 'Duration (seconds)',
            type: 'number',
            required: false,
            order: 6,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'call_time',
            label_ar: 'وقت المكالمة',
            label_en: 'Call Time',
            type: 'datetime',
            required: false,
            order: 7,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'agent_name',
            label_ar: 'الوكيل',
            label_en: 'Agent',
            type: 'text',
            required: false,
            order: 8,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'dtmf_digit',
            label_ar: 'الرقم المضغوط',
            label_en: 'DTMF Digit',
            type: 'text',
            required: false,
            order: 9,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'dtmf_label',
            label_ar: 'تسمية الخيار',
            label_en: 'DTMF Label',
            type: 'text',
            required: false,
            order: 10,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'sentiment',
            label_ar: 'الانطباع',
            label_en: 'Sentiment',
            type: 'dropdown',
            required: false,
            order: 11,
            section_id: phoneCallsBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'إيجابي', label_en: 'Positive', value: 'positive', color: '#22c55e' },
              { id: uuid(), label_ar: 'محايد',  label_en: 'Neutral',  value: 'neutral',  color: '#6b7280' },
              { id: uuid(), label_ar: 'سلبي',   label_en: 'Negative', value: 'negative', color: '#ef4444' },
              { id: uuid(), label_ar: 'متباين', label_en: 'Mixed',    value: 'mixed',    color: '#eab308' },
              { id: uuid(), label_ar: 'غير معروف', label_en: 'Unknown', value: 'unknown', color: '#9ca3af' },
            ],
          },
          {
            id: uuid(),
            name: 'ai_summary',
            label_ar: 'ملخص الذكاء الاصطناعي',
            label_en: 'AI Summary',
            type: 'textarea',
            required: false,
            order: 12,
            section_id: phoneCallsBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'transcription_text',
            label_ar: 'نص التفريغ الكامل',
            label_en: 'Full Transcript',
            type: 'textarea',
            required: false,
            order: 13,
            section_id: phoneCallsBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'pickup_time',
            label_ar: 'وقت الرد',
            label_en: 'Picked Up At',
            type: 'datetime',
            required: false,
            order: 14,
            section_id: phoneCallsBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'hangup_time',
            label_ar: 'وقت الإنهاء',
            label_en: 'Hung Up At',
            type: 'datetime',
            required: false,
            order: 15,
            section_id: phoneCallsBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'recording_url',
            label_ar: 'رابط التسجيل',
            label_en: 'Recording URL',
            type: 'url',
            required: false,
            order: 16,
            section_id: phoneCallsBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'client_link',
            label_ar: 'العميل المرتبط',
            label_en: 'Linked Client',
            type: 'lookup',
            required: false,
            order: 17,
            section_id: phoneCallsBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: clientsId,
            lookup_display_field: 'name',
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// MARKETING REFERENCE — COMPETITORS LIBRARY
// ============================================================
//
// Reusable library of competitor content samples. Standalone reference
// data; the old agent-driven marketing pipeline that consumed this was
// replaced by the template-driven design generator (2026-05-09 rebuild).

// --- COMPETITORS MODEL ---
const competitorsId = uuid();
const competitorsBaseId = uuid();
const competitorsModel: AppModel = {
  id: competitorsId,
  name: 'competitors',
  label_ar: 'مكتبة المنافسين',
  label_en: 'Competitors',
  icon: 'megaphone',
  color: '#B8734F',
  group_id: DESIGNS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: { title_field_id: null, shown_field_ids: [] },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: competitorsBaseId,
        label_ar: 'التفاصيل',
        label_en: 'Details',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: uuid(), name: 'name', label_ar: 'الاسم', label_en: 'Name', type: 'text', required: true, order: 0, section_id: competitorsBaseId, width: 'half', show_in_table: true },
          { id: uuid(), name: 'type', label_ar: 'النوع', label_en: 'Type', type: 'dropdown', required: true, order: 1, section_id: competitorsBaseId, width: 'half', show_in_table: true, options: [opt('reel_script', 'Reel Script'), opt('post_example', 'Post Example')] },
          { id: uuid(), name: 'content', label_ar: 'المحتوى', label_en: 'Content', type: 'textarea', required: true, order: 2, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'notes', label_ar: 'ملاحظات', label_en: 'Notes', type: 'textarea', required: false, order: 3, section_id: competitorsBaseId, width: 'full', show_in_table: false },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// DESIGN TEMPLATES MODEL — Templates Library
// ============================================================
// Reusable catalog of design templates feeding the Marketing Operations
// generator. Each row carries: a reference image (visual target), three
// prompts (cleanup → editing → design) with `{{PLACEHOLDER}}` tokens,
// and a typed `variables` table listing the placeholders.
// Marketing-Operation records pick a template via lookup and fill its
// variables; the orchestrator runs the three phases and writes each
// phase's output back to the record.
const designTemplatesId = uuid();
const designTemplatesBaseId = uuid();
const designTemplatesModel: AppModel = {
  id: designTemplatesId,
  name: 'design_templates',
  label_ar: 'مكتبة القوالب',
  label_en: 'Templates Library',
  icon: 'layout-template',
  color: '#0D9488',
  group_id: DESIGNS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: { title_field_id: null, shown_field_ids: [] },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: designTemplatesBaseId,
        label_ar: 'تفاصيل القالب',
        label_en: 'Template Details',
        order: 0,
        is_base: true,
        color: '#0D9488',
        fields: [
          { id: uuid(), name: 'name', label_ar: 'اسم القالب', label_en: 'Template Name', type: 'text', required: true, order: 0, section_id: designTemplatesBaseId, width: 'half', show_in_table: true },
          { id: uuid(), name: 'reference_image', label_ar: 'الصورة المرجعية', label_en: 'Reference Image', type: 'image', required: true, order: 1, section_id: designTemplatesBaseId, width: 'full', show_in_table: false, image_folder: 'reference', image_max_size_mb: 10 },
          { id: uuid(), name: 'cleanup_prompt', label_ar: 'تعليمة التنظيف (مرحلة ١)', label_en: 'Cleanup Prompt (Phase 1)', type: 'textarea', required: true, order: 2, section_id: designTemplatesBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'editing_prompt', label_ar: 'تعليمة التعديل (مرحلة ٢)', label_en: 'Editing Prompt (Phase 2)', type: 'textarea', required: true, order: 3, section_id: designTemplatesBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'design_prompt', label_ar: 'تعليمة التصميم (مرحلة ٣)', label_en: 'Design Prompt (Phase 3)', type: 'textarea', required: true, order: 4, section_id: designTemplatesBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'variables', label_ar: 'المتغيرات', label_en: 'Variables', type: 'table', required: false, order: 5, section_id: designTemplatesBaseId, width: 'full', show_in_table: false,
            table_columns: [
              { id: uuid(), name: 'name', label_ar: 'الاسم', label_en: 'Name', type: 'text', required: true },
              { id: uuid(), name: 'label_ar', label_ar: 'العنوان (عربي)', label_en: 'Label (AR)', type: 'text', required: true },
              { id: uuid(), name: 'label_en', label_ar: 'العنوان (إنجليزي)', label_en: 'Label (EN)', type: 'text', required: true },
              { id: uuid(), name: 'type', label_ar: 'النوع', label_en: 'Type', type: 'dropdown', required: true, options: [
                opt('text', 'Text'),
                opt('number', 'Number'),
                opt('currency', 'Currency'),
              ] },
            ] },
          { id: uuid(), name: 'notes', label_ar: 'ملاحظات', label_en: 'Notes', type: 'textarea', required: false, order: 6, section_id: designTemplatesBaseId, width: 'full', show_in_table: false },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// MARKETING OPERATIONS MODEL — Template-driven design generator
// ============================================================
// Each row = one design generation. The user picks a project, the
// project info auto-mirrors in read-only, picks a template from the
// Templates Library, fills the template's variables (manual entry or
// link to a project field), uploads a raw building photo, then clicks
// Generate. The Generate button hits /api/marketing/generate which
// runs the THREE-phase Higgsfield orchestration:
//
//   1. Cleanup — strip distractions from the raw building photograph.
//   2. Editing — regenerate a hero camera angle from the cleaned photo.
//   3. Design  — composite the edited photo + reference layout + logo
//                into the finished social post.
//
// Each phase has its own intermediate image saved on the record so the
// marketer can inspect / approve mid-way. `cleanup_input_hash` and
// `editing_input_hash` are written by the server (not declared as
// fields) on `record.data` so the orchestrator can skip phases whose
// inputs haven't changed across re-runs.
const marketingOperationsId = uuid();
const marketingOperationsOpSectionId = uuid();
const marketingOperationsInfoSectionId = uuid();
const marketingOperationsVarsSectionId = uuid();
const marketingOperationsIoSectionId = uuid();
const marketingOperationsProjectFieldId = uuid();
const marketingOperationsGenerateButtonId = uuid();

const marketingOperationsModel: AppModel = {
  id: marketingOperationsId,
  name: 'marketing_operations',
  label_ar: 'عمليات التسويق',
  label_en: 'Marketing Operations',
  icon: 'megaphone',
  color: '#0D9488',
  group_id: DESIGNS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: { title_field_id: null, shown_field_ids: [] },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: marketingOperationsOpSectionId,
        label_ar: 'العملية',
        label_en: 'Operation',
        order: 0,
        is_base: true,
        color: '#0D9488',
        fields: [
          { id: uuid(), name: 'auto_id', label_ar: 'الرقم', label_en: 'ID', type: 'auto_id', required: false, order: 0, section_id: marketingOperationsOpSectionId, width: 'half', show_in_table: true, auto_id_prefix: 'MO-', auto_id_padding: 3, auto_id_start_value: 1 },
          { id: marketingOperationsProjectFieldId, name: 'project', label_ar: 'المشروع', label_en: 'Project', type: 'lookup', required: true, order: 1, section_id: marketingOperationsOpSectionId, width: 'half', show_in_table: true, lookup_model_id: allProjectsId, lookup_display_field: 'project_name' },
          // Per-template status badges live on the picker chips below
          // (driven by record.data.generations[tid].status). The old
          // single-record `status` dropdown was meaningless for a
          // multi-template run — dropped 2026-05-10.
          { id: uuid(), name: 'templates', label_ar: 'القوالب', label_en: 'Templates', type: 'templates_picker', required: true, order: 2, section_id: marketingOperationsOpSectionId, width: 'full', show_in_table: true },
        ],
      },
      {
        id: marketingOperationsInfoSectionId,
        label_ar: 'معلومات المشروع',
        label_en: 'Project Info',
        order: 1,
        is_base: true,
        color: '#8E4E3A',
        // Ten individual `mirror` fields hopping through the `project`
        // lookup. Section_mirror would have been more compact, but the
        // requested fields span three different sections on the
        // all_projects model (info / geographic / details), and
        // section_mirror only ever mirrors a single source section.
        fields: [
          { id: uuid(), name: 'mirror_project_name', label_ar: 'اسم المشروع', label_en: 'Project Name', type: 'mirror', required: false, order: 0, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'project_name' },
          { id: uuid(), name: 'mirror_developer',    label_ar: 'المطور',       label_en: 'Developer',    type: 'mirror', required: false, order: 1, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'item_mo4ul4p0' },
          { id: uuid(), name: 'mirror_unit_types',   label_ar: 'أنواع الوحدات', label_en: 'Unit Types',   type: 'mirror', required: false, order: 2, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'item_mo4kz61h' },
          { id: uuid(), name: 'mirror_amenities',    label_ar: 'المرافق',       label_en: 'Amenities',    type: 'mirror', required: false, order: 3, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'preferred_amenities' },
          { id: uuid(), name: 'mirror_city',         label_ar: 'المدينة',       label_en: 'City',         type: 'mirror', required: false, order: 4, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'preferred_city' },
          { id: uuid(), name: 'mirror_district',     label_ar: 'الحي',          label_en: 'District',     type: 'mirror', required: false, order: 5, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'preferred_neighborhoods' },
          { id: uuid(), name: 'mirror_price_range', label_ar: 'نطاق السعر',     label_en: 'Price Range',  type: 'mirror', required: false, order: 6, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'price_range' },
          { id: uuid(), name: 'mirror_area_range',  label_ar: 'نطاق المساحة',   label_en: 'Area Range',   type: 'mirror', required: false, order: 7, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'area_range' },
          { id: uuid(), name: 'mirror_bedrooms',    label_ar: 'نطاق غرف النوم',  label_en: 'Bedrooms Range', type: 'mirror', required: false, order: 8, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'bedroom_range' },
          { id: uuid(), name: 'mirror_bathrooms',   label_ar: 'نطاق دورات المياة', label_en: 'Bathrooms Range', type: 'mirror', required: false, order: 9, section_id: marketingOperationsInfoSectionId, width: 'half', show_in_table: false, mirror_via_lookup_field_id: marketingOperationsProjectFieldId, mirror_target_field_name: 'bathroom_range' },
        ],
      },
      {
        id: marketingOperationsVarsSectionId,
        label_ar: 'متغيرات القالب',
        label_en: 'Template Variables',
        order: 2,
        is_base: true,
        color: '#7C3AED',
        fields: [
          { id: uuid(), name: 'template_field_values', label_ar: 'القيم', label_en: 'Values', type: 'template_variables', required: false, order: 0, section_id: marketingOperationsVarsSectionId, width: 'full', show_in_table: false },
        ],
      },
      {
        id: marketingOperationsIoSectionId,
        label_ar: 'الإدخال والإخراج',
        label_en: 'Input & Output',
        order: 3,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: uuid(), name: 'raw_photo', label_ar: 'الصورة الخام', label_en: 'Raw Photo', type: 'image', required: true, order: 0, section_id: marketingOperationsIoSectionId, width: 'full', show_in_table: false, image_folder: 'raw' },
          { id: uuid(), name: 'generations_view', label_ar: 'التوليدات', label_en: 'Generations', type: 'generations_gallery', required: false, order: 1, section_id: marketingOperationsIoSectionId, width: 'full', show_in_table: true },
          { id: uuid(), name: 'error_message', label_ar: 'رسالة الخطأ العامة', label_en: 'Overall Error', type: 'textarea', required: false, order: 2, section_id: marketingOperationsIoSectionId, width: 'full', show_in_table: false },
        ],
      },
    ],
    section_selector_field_id: null,
    custom_buttons: [
      {
        id: marketingOperationsGenerateButtonId,
        label_ar: 'توليد التصميم',
        label_en: 'Generate Design',
        icon: 'wand-2',
        color: '#0D9488',
        locations: ['record_form'],
        action: { type: 'generate_design' },
        enabled: true,
      },
    ],
  },
};

// ============================================================
// CHAT TEMPLATES MODEL
// ============================================================
// Pre-written WhatsApp message templates with optional media. Each
// template is one row on this system model. The Chats Composer shows a
// "Templates" button that opens a picker; selecting a template fills
// the textarea with the body and attaches the pre-uploaded media (no
// re-upload needed — we store Haberchat's file id on the record).
// The generic record list shows them as a table; create/edit uses a
// custom ChatTemplateFormPage because the media upload doesn't fit the
// generic record form. See docs/prd/chats.md.

export const chatTemplatesId = uuid();
const chatTemplatesBaseSectionId = uuid();
const chatTemplatesNameFieldId = uuid();
const chatTemplatesLanguageFieldId = uuid();

const chatTemplatesModel: AppModel = {
  id: chatTemplatesId,
  name: 'chat_templates',
  label_ar: 'قوالب الرسائل',
  label_en: 'Chat Templates',
  icon: 'message-square',
  color: '#25D366',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: chatTemplatesNameFieldId,
    subtitle_field_id: chatTemplatesLanguageFieldId,
    badge_field_id: null,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: chatTemplatesBaseSectionId,
        label_ar: 'القالب',
        label_en: 'Template',
        order: 0,
        is_base: true,
        color: '#25D366',
        fields: [
          {
            id: chatTemplatesNameFieldId,
            name: 'name',
            label_ar: 'اسم القالب',
            label_en: 'Name',
            type: 'text',
            required: true,
            order: 0,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: chatTemplatesLanguageFieldId,
            name: 'language',
            label_ar: 'اللغة',
            label_en: 'Language',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'العربية', label_en: 'Arabic', value: 'ar' },
              { id: uuid(), label_ar: 'الإنجليزية', label_en: 'English', value: 'en' },
              { id: uuid(), label_ar: 'الاثنان', label_en: 'Both', value: 'both' },
            ],
          },
          {
            id: uuid(),
            name: 'tags',
            label_ar: 'التصنيفات',
            label_en: 'Tags',
            type: 'multiselect',
            required: false,
            order: 2,
            section_id: chatTemplatesBaseSectionId,
            width: 'full',
            show_in_table: true,
            options: [],
          },
          {
            id: uuid(),
            name: 'body_ar',
            label_ar: 'النص العربي',
            label_en: 'Arabic body',
            type: 'textarea',
            required: false,
            order: 3,
            section_id: chatTemplatesBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'body_en',
            label_ar: 'النص الإنجليزي',
            label_en: 'English body',
            type: 'textarea',
            required: false,
            order: 4,
            section_id: chatTemplatesBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'media_kind',
            label_ar: 'نوع المرفق',
            label_en: 'Media kind',
            type: 'dropdown',
            required: false,
            order: 5,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'صورة', label_en: 'Image', value: 'image' },
              { id: uuid(), label_ar: 'فيديو', label_en: 'Video', value: 'video' },
              { id: uuid(), label_ar: 'صوت', label_en: 'Audio', value: 'audio' },
              { id: uuid(), label_ar: 'مستند', label_en: 'Document', value: 'document' },
            ],
          },
          {
            id: uuid(),
            name: 'media_filename',
            label_ar: 'اسم الملف',
            label_en: 'Filename',
            type: 'text',
            required: false,
            order: 6,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          // Haberchat file id — opaque token. Stored as text so the form
          // preserves it; the custom editor owns the upload flow.
          {
            id: uuid(),
            name: 'media_file_id',
            label_ar: 'معرّف الملف',
            label_en: 'Haberchat file id',
            type: 'text',
            required: false,
            order: 7,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'media_mime',
            label_ar: 'نوع MIME',
            label_en: 'MIME type',
            type: 'text',
            required: false,
            order: 8,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'media_size',
            label_ar: 'حجم الملف',
            label_en: 'File size (bytes)',
            type: 'number',
            required: false,
            order: 9,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// SITE SETTINGS MODEL
// ============================================================
// Singleton-style model that backs the public marketing site (Wassel Website).
// Holds editable hero copy, contact info, social links, and working hours so
// the website can be re-skinned without a code redeploy. The website fetches
// the first record (treats it as a singleton); admins should not create more
// than one. Backed by the public-read RLS policy in the
// `2026-05-09_j_website_integration.sql` migration so anon traffic from the
// website can SELECT it.
const siteSettingsId = uuid();
const ssBaseSectionId = uuid();
const ssMapCardSectionId = uuid();
const ssProjectCardSectionId = uuid();
const ssHeroTitleFieldId = uuid();
const ssHeroSubtitleFieldId = uuid();

const siteSettingsModel: AppModel = {
  id: siteSettingsId,
  name: 'site_settings',
  label_ar: 'إعدادات الموقع',
  label_en: 'Website Settings',
  icon: 'globe',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: ssHeroTitleFieldId,
    subtitle_field_id: ssHeroSubtitleFieldId,
    badge_field_id: null,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: ssBaseSectionId,
        label_ar: 'إعدادات الموقع',
        label_en: 'Website Settings',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: ssHeroTitleFieldId,    name: 'hero_title',        label_ar: 'عنوان البطل',           label_en: 'Hero Title',            type: 'text',     required: false, order: 0,  section_id: ssBaseSectionId, width: 'half', show_in_table: true },
          { id: ssHeroSubtitleFieldId, name: 'hero_subtitle',     label_ar: 'العنوان الفرعي',        label_en: 'Hero Subtitle',         type: 'text',     required: false, order: 1,  section_id: ssBaseSectionId, width: 'half', show_in_table: true },
          { id: uuid(),                name: 'hero_description',  label_ar: 'وصف البطل',             label_en: 'Hero Description',      type: 'textarea', required: false, order: 2,  section_id: ssBaseSectionId, width: 'full', show_in_table: false },
          { id: uuid(),                name: 'hero_bg_image_url', label_ar: 'صورة خلفية البطل',      label_en: 'Hero Background Image', type: 'url',      required: false, order: 3,  section_id: ssBaseSectionId, width: 'full', show_in_table: false },
          { id: uuid(),                name: 'contact_phone',     label_ar: 'رقم التواصل',           label_en: 'Contact Phone',         type: 'phone',    required: false, order: 4,  section_id: ssBaseSectionId, width: 'half', show_in_table: true },
          { id: uuid(),                name: 'contact_email',     label_ar: 'البريد الإلكتروني',     label_en: 'Contact Email',         type: 'email',    required: false, order: 5,  section_id: ssBaseSectionId, width: 'half', show_in_table: true },
          { id: uuid(),                name: 'address_ar',        label_ar: 'العنوان (عربي)',        label_en: 'Address (AR)',          type: 'text',     required: false, order: 6,  section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'address_en',        label_ar: 'العنوان (إنجليزي)',     label_en: 'Address (EN)',          type: 'text',     required: false, order: 7,  section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'hours_ar',          label_ar: 'ساعات العمل (عربي)',    label_en: 'Working Hours (AR)',    type: 'text',     required: false, order: 8,  section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'hours_en',          label_ar: 'ساعات العمل (إنجليزي)', label_en: 'Working Hours (EN)',    type: 'text',     required: false, order: 9,  section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'linkedin_url',      label_ar: 'لينكدإن',               label_en: 'LinkedIn URL',          type: 'url',      required: false, order: 10, section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'instagram_url',     label_ar: 'إنستغرام',              label_en: 'Instagram URL',         type: 'url',      required: false, order: 11, section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'tiktok_url',        label_ar: 'تيك توك',               label_en: 'TikTok URL',            type: 'url',      required: false, order: 12, section_id: ssBaseSectionId, width: 'half', show_in_table: false },
          { id: uuid(),                name: 'whatsapp_phone',    label_ar: 'رقم الواتساب',          label_en: 'WhatsApp Phone',        type: 'phone',    required: false, order: 13, section_id: ssBaseSectionId, width: 'half', show_in_table: false },
        ],
      },
      // "Map Card" section — admin picks which all_projects field populates
      // each slot in the website's map info-window card. Empty selections
      // fall back to heuristics (first popup_shown_field_ids → chips,
      // label-match → price, first URL → CTA). For fresh installs the
      // dropdown options are EMPTY: the website's
      // 2026-05-09_l_site_settings_map_card_config.sql migration snapshots
      // all_projects fields into these dropdowns; for a brand-new tenant
      // the admin will run that migration after first using the Builder.
      {
        id: ssMapCardSectionId,
        label_ar: 'بطاقة الخريطة',
        label_en: 'Map Card',
        order: 1,
        is_base: false,
        color: '#B8734F',
        fields: [
          { id: uuid(), name: 'card_status_field',  label_ar: 'حقل حالة المشروع (اختياري)', label_en: 'Status Field (optional)', type: 'dropdown', required: false, order: 0, section_id: ssMapCardSectionId, width: 'full', show_in_table: false, options: [] },
          { id: uuid(), name: 'card_chip1_field',   label_ar: 'البطاقة الأولى',             label_en: 'Card 1',                  type: 'dropdown', required: false, order: 1, section_id: ssMapCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'card_chip2_field',   label_ar: 'البطاقة الثانية',            label_en: 'Card 2',                  type: 'dropdown', required: false, order: 2, section_id: ssMapCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'card_chip3_field',   label_ar: 'البطاقة الثالثة',            label_en: 'Card 3',                  type: 'dropdown', required: false, order: 3, section_id: ssMapCardSectionId, width: 'full', show_in_table: false, options: [] },
          { id: uuid(), name: 'card_price_field',   label_ar: 'حقل السعر (في الذيل)',       label_en: 'Price Field (footer)',    type: 'dropdown', required: false, order: 4, section_id: ssMapCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'card_cta_url_field', label_ar: 'رابط زر "فتح السجل"',        label_en: 'CTA URL Field',           type: 'dropdown', required: false, order: 5, section_id: ssMapCardSectionId, width: 'half', show_in_table: false, options: [] },
        ],
      },
      // "Project Card" section — admin picks which all_projects field
      // populates each slot in the website's projects-listing card
      // (projects.html grid). Empty selections fall back to heuristics:
      // image → record.data.image_url; title/subtitle/status →
      // all_projects.card_config; chip1/2 → first two of card_config
      // shown_field_ids; price hides if unset; CTA defaults to
      // project.html?id=<record id>. Dropdown options are EMPTY for
      // fresh installs — the 2026-05-14_b_site_settings_project_card_config.sql
      // migration snapshots all_projects fields into these dropdowns.
      {
        id: ssProjectCardSectionId,
        label_ar: 'بطاقة المشروع',
        label_en: 'Project Card',
        order: 2,
        is_base: false,
        color: '#B8734F',
        fields: [
          { id: uuid(), name: 'proj_card_image_field',    label_ar: 'حقل صورة المشروع',     label_en: 'Image Field',     type: 'dropdown', required: false, order: 0, section_id: ssProjectCardSectionId, width: 'full', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_title_field',    label_ar: 'حقل العنوان',          label_en: 'Title Field',     type: 'dropdown', required: false, order: 1, section_id: ssProjectCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_subtitle_field', label_ar: 'حقل العنوان الفرعي',   label_en: 'Subtitle Field',  type: 'dropdown', required: false, order: 2, section_id: ssProjectCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_status_field',   label_ar: 'حقل حالة المشروع',     label_en: 'Status Field',    type: 'dropdown', required: false, order: 3, section_id: ssProjectCardSectionId, width: 'full', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_chip1_field',    label_ar: 'الشريحة الأولى',       label_en: 'Chip 1',          type: 'dropdown', required: false, order: 4, section_id: ssProjectCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_chip2_field',    label_ar: 'الشريحة الثانية',      label_en: 'Chip 2',          type: 'dropdown', required: false, order: 5, section_id: ssProjectCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_price_field',    label_ar: 'حقل السعر',            label_en: 'Price Field',     type: 'dropdown', required: false, order: 6, section_id: ssProjectCardSectionId, width: 'half', show_in_table: false, options: [] },
          { id: uuid(), name: 'proj_card_cta_url_field',  label_ar: 'رابط زر "عرض المشروع"', label_en: 'CTA URL Field',  type: 'dropdown', required: false, order: 7, section_id: ssProjectCardSectionId, width: 'half', show_in_table: false, options: [] },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// DECKS MODEL (AI-generated Wassel-branded PowerPoints)
// ============================================================
// Each record is one user-requested deck. The brief field stores the user's
// prompt; status starts at 'queued' and the /api/generate-deck endpoint
// updates it through 'generating' → 'ready' (file_url + file_path set) or
// 'failed' (error_message set). Detail and list routes are overridden to
// render DecksPage instead of the generic record form / list — see
// App.tsx dispatcher.
//
// File storage: /api/generate-deck calls the Anthropic API with the
// `wassel-general-ppt` skill (registered via Skills API, id stored in
// ANTHROPIC_WASSEL_SKILL_ID) and the code_execution tool. Claude writes a
// .pptx in its sandbox; the endpoint downloads it via the Files API and
// uploads to the private `wassel-decks` Supabase Storage bucket at
// {auth.uid()}/{record_id}/{filename}. file_url is a 7-day signed URL;
// DecksPage re-signs from file_path when the URL expires.
// See docs/prd/decks.md.

export const decksId = uuid();
const decksBaseSectionId = uuid();
const decksTitleFieldId = uuid();
const decksBriefFieldId = uuid();
const decksStatusFieldId = uuid();
const decksFileUrlFieldId = uuid();
const decksFilePathFieldId = uuid();
const decksFilenameFieldId = uuid();
const decksAnthropicFileIdFieldId = uuid();
const decksErrorMessageFieldId = uuid();
const decksModelUsedFieldId = uuid();
const decksLanguageFieldId = uuid();
const decksSizeFieldId = uuid();

const decksModel: AppModel = {
  id: decksId,
  name: 'decks',
  label_ar: 'العروض التقديمية',
  label_en: 'Decks',
  icon: 'presentation',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: decksTitleFieldId,
    subtitle_field_id: decksBriefFieldId,
    badge_field_id: decksStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: decksBaseSectionId,
        label_ar: 'العرض التقديمي',
        label_en: 'Deck',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: decksTitleFieldId,
            name: 'title',
            label_ar: 'العنوان',
            label_en: 'Title',
            type: 'text',
            required: true,
            order: 0,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: true,
          },
          {
            id: decksBriefFieldId,
            name: 'brief',
            label_ar: 'الموجز',
            label_en: 'Brief',
            type: 'textarea',
            required: true,
            order: 1,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: decksStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 2,
            section_id: decksBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'بانتظار المعالجة', label_en: 'Queued', value: 'queued', color: '#9ca3af' },
              { id: uuid(), label_ar: 'قيد التوليد', label_en: 'Generating', value: 'generating', color: '#3b82f6' },
              { id: uuid(), label_ar: 'جاهز', label_en: 'Ready', value: 'ready', color: '#22c55e' },
              { id: uuid(), label_ar: 'فشل', label_en: 'Failed', value: 'failed', color: '#ef4444' },
            ],
          },
          {
            id: decksLanguageFieldId,
            name: 'language',
            label_ar: 'اللغة',
            label_en: 'Language',
            type: 'dropdown',
            required: false,
            order: 3,
            section_id: decksBaseSectionId,
            width: 'third',
            show_in_table: false,
            options: [
              { id: uuid(), label_ar: 'عربي', label_en: 'Arabic', value: 'ar' },
              { id: uuid(), label_ar: 'إنجليزي', label_en: 'English', value: 'en' },
              { id: uuid(), label_ar: 'مختلط', label_en: 'Mixed', value: 'mixed' },
            ],
          },
          {
            id: decksModelUsedFieldId,
            name: 'model_used',
            label_ar: 'النموذج المستخدم',
            label_en: 'Model',
            type: 'dropdown',
            required: false,
            order: 4,
            section_id: decksBaseSectionId,
            width: 'third',
            show_in_table: false,
            options: [
              { id: uuid(), label_ar: 'Opus 4.7', label_en: 'Opus 4.7', value: 'claude-opus-4-7' },
              { id: uuid(), label_ar: 'Sonnet 4.6', label_en: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
            ],
          },
          {
            // Output orientation. Stored as a free-form aspect-ratio string
            // ('16:9' / '9:16' / '4:3' / '1:1'); the API maps this to the
            // python-pptx slide_width/slide_height in inches when invoking
            // the wassel-general-ppt skill. Defaulting to 16:9 in the form
            // (most common) — the schema field itself has no default; older
            // records read as undefined → endpoint coerces to 16:9.
            id: decksSizeFieldId,
            name: 'size',
            label_ar: 'الحجم',
            label_en: 'Size',
            type: 'dropdown',
            required: false,
            order: 5,
            section_id: decksBaseSectionId,
            width: 'third',
            show_in_table: false,
            options: [
              { id: uuid(), label_ar: '١٦:٩ (أفقي)', label_en: '16:9 (Widescreen)', value: '16:9' },
              { id: uuid(), label_ar: '٩:١٦ (رأسي)', label_en: '9:16 (Vertical)', value: '9:16' },
              { id: uuid(), label_ar: '٤:٣ (قياسي)', label_en: '4:3 (Standard)', value: '4:3' },
              { id: uuid(), label_ar: '١:١ (مربع)', label_en: '1:1 (Square)', value: '1:1' },
            ],
          },
          {
            id: decksFilenameFieldId,
            name: 'filename',
            label_ar: 'اسم الملف',
            label_en: 'Filename',
            type: 'text',
            required: false,
            order: 6,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: true,
          },
          {
            id: decksFileUrlFieldId,
            name: 'file_url',
            label_ar: 'رابط الملف',
            label_en: 'File URL',
            type: 'url',
            required: false,
            order: 7,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: decksFilePathFieldId,
            name: 'file_path',
            label_ar: 'مسار التخزين',
            label_en: 'Storage path',
            type: 'text',
            required: false,
            order: 8,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: decksAnthropicFileIdFieldId,
            name: 'anthropic_file_id',
            label_ar: 'معرّف الملف لدى Anthropic',
            label_en: 'Anthropic file id',
            type: 'text',
            required: false,
            order: 9,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: decksErrorMessageFieldId,
            name: 'error_message',
            label_ar: 'رسالة الخطأ',
            label_en: 'Error message',
            type: 'textarea',
            required: false,
            order: 10,
            section_id: decksBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// EXPORTS
// ============================================================
export const SEED_MODELS: AppModel[] = [
  clientsModel,
  followupsModel,
  appointmentsModel,
  visitsModel,
  developersModel,
  unitsModel,
  allProjectsModel,
  targetedProjectsModel,
  ourProjectsModel,
  chatsModel,
  chatTemplatesModel,
  aiChatsModel,
  decksModel,
  phoneCallsModel,
  // Designs group: Templates Library + Marketing Operations + Competitors
  // reference (template-driven design generator, 2026-05-09 rebuild).
  competitorsModel,
  designTemplatesModel,
  marketingOperationsModel,
  // Website (2026-05-09): backs the public marketing site at /, /projects, /map.
  siteSettingsModel,
];
