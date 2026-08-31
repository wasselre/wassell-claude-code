import { v4 as uuid } from 'uuid';
import { MAPS_CONFIG_DEFAULT } from '@/types';
import type { AppModel, FieldOption, ModelGroup } from '@/types';
import { OUTCOME_CATALOG } from '@/lib/salesProcess/outcomes';

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

/**
 * Build the option ladder for a `range` field from one or more step segments.
 *
 * A range field carries a SINGLE `range_step`, which cannot express a
 * non-uniform increment schedule (e.g. "10 m² up to 500, then 100 m² up to
 * 5,000"). `field.options` can: RangeField renders the min/max inputs as two
 * <select> pickers when the field has options, and option `value`s are NUMERIC
 * strings so the stored value stays `{min,max}` numeric. So the ladder IS the
 * step spec. `range_step` stays on the field as Builder-editor metadata and
 * should carry the FINEST step in the ladder.
 *
 * Segments are inclusive of both ends; a value repeated across two adjacent
 * segments (e.g. 500 ending one and starting the next) is emitted once.
 * Ids are deterministic (`<prefix>_<value>`) — never `uuid()` — so re-seeding
 * cannot silently break filters that reference an option value (see the
 * "Inline-create UUID drift" incident in CLAUDE.md).
 *
 * Mirrors the SQL in supabase/migrations/2026-08-18_client_pref_area_budget_ranges.sql.
 */
function rangeLadder(
  prefix: string,
  segments: ReadonlyArray<{ from: number; to: number; step: number }>,
): FieldOption[] {
  const values: number[] = [];
  for (const { from, to, step } of segments) {
    for (let v = from; v <= to; v += step) {
      if (values[values.length - 1] !== v) values.push(v);
    }
  }
  return values.map((v) => {
    const label = v.toLocaleString('en-US');
    return { id: `${prefix}_${v}`, label_ar: label, label_en: label, value: String(v) };
  });
}

// Client preference ranges. Preferred area (م²): 10 m² steps from 50 to 500,
// then 100 m² steps to 5,000 (91 values). Budget (ر.س): uniform 50,000 steps
// from 500,000 to 10,000,000 (191 values).
const PREFERRED_AREA_OPTIONS: FieldOption[] = rangeLadder('area_opt', [
  { from: 50, to: 500, step: 10 },
  { from: 500, to: 5000, step: 100 },
]);
const BUDGET_OPTIONS: FieldOption[] = rangeLadder('budget_opt', [
  { from: 500000, to: 10000000, step: 50000 },
]);

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
//
// PINNED to fixed literals (2026-08-18), NOT uuid(). These MUST match the live
// production model ids. Rationale: profiles store `model_permissions` keyed by
// model UUID. When `uuid()` was used here, every re-seed of the system models
// (a restore to before they existed, a DB reset, or the boot "backfill missing
// SEED_MODELS by name" path running against an empty models table) minted NEW
// random ids, orphaning every profile's permissions — the recurring
// "records RLS flood + user sees 0 records" incident. Deterministic ids make a
// re-seed idempotent-by-id, so permissions can never orphan again. (Roles and
// profiles already use fixed literal ids for the same reason.) If you add a new
// system model, give it a fixed literal id here too — never uuid().
// ============================================================
const allProjectsId = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
export const unitsId = '7ca3014d-f658-418e-9c53-2d279c97f009';
export const appointmentsId = 'b032a675-6237-4436-9783-a1a253855f74';
// Visits model (2026-05-10): user-built but seeded so fresh installs match
// the migrated production state. Schema lives near ourProjectsModel below.
// Field IDs are declared up-front because the followups model's
// custom_buttons reference visits by id, and visits' auto-link / auto-fill
// props on `phone` and `name` reference the sibling `client_id` lookup id.
export const visitsId = '372ed642-3753-40b4-9dd7-e8390f91b1f8';
const visitsBasicSectionId = uuid();
const visitsClientFieldId = uuid();
const visitsPhoneFieldId = uuid();
const visitsNameFieldId = uuid();
const visitsScheduledFieldId = uuid();
const visitsProjectFieldId = uuid();
const visitsUnitsFieldId = uuid();
const visitsSalesRepFieldId = uuid();
const visitsNotesFieldId = uuid();
const visitsSourceFollowupFieldId = uuid();

// ============================================================
// DEVELOPERS MODEL (new 2026-04-18)
// ============================================================
const developersId = '11bade2c-7da9-4d00-b045-eaab37153da2';
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
const clientsId = '2e86f197-385f-4853-908f-b4cb7237f7d8';
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
            // Guided location cascade (country → region → city → district) for
            // client preferences. Added in-app 2026-08-19; a full system-model
            // re-seed on 2026-08-20 reverted the clients baseline and DROPPED it
            // — record data survived in `data.location` / `data.location_items`,
            // but the field DEFINITION was gone until it was restored by hand.
            // It is seeded here so any future re-seed keeps it.
            //
            // `location_multi: true` is the CLIENTS variant: region/city stay
            // single (1-element arrays) while the deepest level can hold many;
            // the record form renders it via ClientLocationField (navigation
            // capped at city — districts + drawn map areas live in the
            // `location_items` sidecar). The geography model ids + default
            // record ids are STABLE live literals (the geography models are
            // created out-of-band by the geography migration, not seeded here),
            // same posture as `preferred_market_listings` below — avoids the
            // seed-backfill-broken-lookup hazard of per-load uuids.
            id: uuid(),
            name: 'location',
            label_ar: 'الموقع',
            label_en: 'Location',
            type: 'location',
            required: false,
            order: 0,
            section_id: clientsPrefsSectionId,
            width: 'full',
            show_in_table: true,
            location_multi: true,
            location_levels: [
              { key: 'country', model_id: 'd15a0001-0000-4000-8000-000000000003', display_field: 'name_ar' },
              { key: 'region', model_id: 'd15a0001-0000-4000-8000-000000000001', display_field: 'name_ar', parent_link_field: 'country_lookup' },
              { key: 'city', model_id: 'd15a0001-0000-4000-8000-000000000002', display_field: 'display_name', parent_link_field: 'region_lookup' },
              { key: 'district', model_id: 'd9a9db7e-b602-470c-b81b-5d6ff17048e9', display_field: 'display_name', parent_link_field: 'city_lookup' },
            ],
            location_default: {
              city: '44254a38-ce40-938f-17b7-55814a44e45c',
              region: '9c0c7a82-738d-6456-2101-b7226cc84e20',
              country: 'd15a0003-0000-4000-8000-000000000001',
            },
          },
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
            // Lookup → the live market_listings model. We use the STABLE live model
            // id literal (NOT a per-load uuid) so a seed re-apply / heal can never
            // write a stale lookup_model_id (the "seed-backfill broken lookups"
            // hazard). market_listings is created out-of-band (Aqar import), not
            // seeded here, so there is no constant to reference. Mirrors the live
            // migration 2026-06-29_clients_preferred_market_listings.sql.
            id: uuid(),
            name: 'preferred_market_listings',
            label_ar: 'إعلانات السوق المفضلة',
            label_en: 'Preferred Market Listings',
            type: 'lookup',
            required: false,
            order: 60,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: '8f06bc39-4bee-42e9-9fab-77023fb89ede',
            lookup_display_field: 'title',
            is_multi: true,
            lookup_max_records: 1000,
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
            range_min: 50,
            range_max: 5000,
            range_step: 10, // finest step; the full ladder lives in `options`
            range_unit_ar: 'م²',
            range_unit_en: 'm²',
            options: PREFERRED_AREA_OPTIONS,
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
            // Mirror of the live field added by 2026-07-17_unit_age_preference.sql:
            // max acceptable عمر العقار as a dropdown; the STRING option value is
            // the number of years ('0' = new only) — draftToMatchRequirements
            // parses it into requirements.max_unit_age.
            id: uuid(),
            name: 'preferred_max_unit_age',
            label_ar: 'عمر العقار (حد أقصى)',
            label_en: 'Unit age (max)',
            type: 'dropdown',
            required: false,
            order: 8,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            options: [
              { id: uuid(), label_ar: 'جديد فقط', label_en: 'New only', value: '0', color: '#C09B5F' },
              { id: uuid(), label_ar: 'حتى سنتين', label_en: 'Up to 2 years', value: '2', color: '#B8734F' },
              { id: uuid(), label_ar: 'حتى 5 سنوات', label_en: 'Up to 5 years', value: '5', color: '#8E4E3A' },
              { id: uuid(), label_ar: 'حتى 10 سنوات', label_en: 'Up to 10 years', value: '10', color: '#4A4E54' },
            ],
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
            range_min: 500000,
            range_max: 10000000,
            range_step: 50000,
            range_unit_ar: 'ر.س',
            range_unit_en: 'SAR',
            options: BUDGET_OPTIONS,
          },
          {
            id: uuid(),
            name: 'preferred_bedrooms',
            label_ar: 'عدد غرف النوم المفضل',
            label_en: 'Preferred Bedrooms',
            type: 'range',
            required: false,
            order: 11,
            section_id: clientsPrefsSectionId,
            width: 'half',
            show_in_table: false,
            range_min: 1,
            range_max: 10,
            range_step: 1,
            range_unit_ar: 'غرفة',
            range_unit_en: 'rooms',
          },
          {
            id: uuid(),
            name: 'preference_notes',
            label_ar: 'ملاحظات التفضيلات',
            label_en: 'Preference Notes',
            type: 'textarea',
            required: false,
            order: 12,
            section_id: clientsPrefsSectionId,
            width: 'full',
            show_in_table: false,
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
export const followupsId = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63';
const fuBasicSectionId = uuid();
export const fuPrefsSectionId = uuid();
const fuCallSectionId = uuid();
const fuAppointmentSectionId = uuid();
const fuPostVisitSectionId = uuid();
const fuWhatsAppSectionId = uuid();

const fuClientFieldId = uuid();
const fuTypeFieldId = uuid();
const fuAppointmentFieldId = uuid();

// Shared "call result" options — duplicated per-section with fresh IDs to keep option
// instances independent in the builder.
// Sales-OS: the follow-up outcome vocabulary now has ONE source of truth — the
// OUTCOME_CATALOG (src/lib/salesProcess/outcomes.ts). A fresh install seeds the
// full set so the custom Follow-up Workspace's outcomes are all storable and the
// runtime enum guard passes. (The live prod model is maintained by the
// 2026-06-16_sales_os_phase1 migration; this keeps brand-new installs in sync.)
const OUTCOME_TONE_COLOR: Record<string, string> = {
  positive: '#10B981',
  neutral: '#C09B5F',
  negative: '#EF4444',
};
const CALL_RESULT_OPTIONS = (): FieldOption[] =>
  OUTCOME_CATALOG.map((o) => ({
    id: uuid(),
    label_ar: o.label_ar,
    label_en: o.label_en,
    value: o.value,
    color: OUTCOME_TONE_COLOR[o.tone],
  }));

const WHATSAPP_RESULT_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'تم الرد', label_en: 'Replied', value: 'replied', color: '#10B981' },
  { id: uuid(), label_ar: 'لم يرد', label_en: 'No Reply', value: 'no_reply', color: '#6B7280' },
  { id: uuid(), label_ar: 'يحتاج معلومات', label_en: 'Needs Info', value: 'needs_info', color: '#3B82F6' },
  { id: uuid(), label_ar: 'غير مهتم', label_en: 'Not Interested', value: 'not_interested', color: '#EF4444' },
  { id: uuid(), label_ar: 'سيرد لاحقاً', label_en: 'Will Reply Later', value: 'will_reply_later', color: '#F59E0B' },
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
              { id: fuCallSectionId, label_ar: 'مكالمة', label_en: 'Call', value: fuCallSectionId, color: '#3B82F6' },
              { id: fuAppointmentSectionId, label_ar: 'تأكيد موعد', label_en: 'Appointment Confirmation', value: fuAppointmentSectionId, color: '#10B981' },
              { id: fuPostVisitSectionId, label_ar: 'متابعة بعد الزيارة', label_en: 'Post-Visit Follow-Up', value: fuPostVisitSectionId, color: '#F59E0B' },
              { id: fuWhatsAppSectionId, label_ar: 'متابعة واتساب', label_en: 'WhatsApp Follow-Up', value: fuWhatsAppSectionId, color: '#25D366' },
            ],
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
        id: fuCallSectionId,
        label_ar: 'مكالمة',
        label_en: 'Call',
        order: 2,
        is_base: false,
        color: '#3B82F6',
        fields: [
          {
            id: uuid(),
            name: 'call_result',
            label_ar: 'نتيجة المكالمة',
            label_en: 'Call Result',
            type: 'dropdown',
            required: false,
            order: 0,
            section_id: fuCallSectionId,
            width: 'full',
            show_in_table: true,
            options: CALL_RESULT_OPTIONS(),
          },
        ],
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
            id: fuAppointmentFieldId,
            name: 'appointment_id',
            label_ar: 'الموعد',
            label_en: 'Appointment',
            type: 'lookup',
            required: false,
            order: 0,
            section_id: fuAppointmentSectionId,
            width: 'half',
            show_in_table: false,
            lookup_model_id: appointmentsId,
            lookup_display_field: 'appointment_date',
          },
          {
            id: uuid(),
            name: 'appt_call_result',
            label_ar: 'نتيجة المكالمة',
            label_en: 'Call Result',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: fuAppointmentSectionId,
            width: 'half',
            show_in_table: false,
            options: CALL_RESULT_OPTIONS(),
          },
          {
            id: uuid(),
            name: 'appointment_date',
            label_ar: 'تاريخ الموعد',
            label_en: 'Appointment Date',
            type: 'mirror',
            required: false,
            order: 2,
            section_id: fuAppointmentSectionId,
            width: 'half',
            show_in_table: false,
            mirror_via_lookup_field_id: fuAppointmentFieldId,
            mirror_target_field_name: 'appointment_date',
          },
          {
            id: uuid(),
            name: 'appointment_project',
            label_ar: 'المشروع المجدول',
            label_en: 'Scheduled Project',
            type: 'mirror',
            required: false,
            order: 3,
            section_id: fuAppointmentSectionId,
            width: 'half',
            show_in_table: false,
            mirror_via_lookup_field_id: fuAppointmentFieldId,
            mirror_target_field_name: 'project_id',
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
            id: uuid(),
            name: 'pv_call_result',
            label_ar: 'نتيجة المكالمة',
            label_en: 'Call Result',
            type: 'dropdown',
            required: false,
            order: 2,
            section_id: fuPostVisitSectionId,
            width: 'full',
            show_in_table: false,
            options: CALL_RESULT_OPTIONS(),
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
            id: uuid(),
            name: 'whatsapp_result',
            label_ar: 'نتيجة الواتساب',
            label_en: 'WhatsApp Result',
            type: 'dropdown',
            required: false,
            order: 0,
            section_id: fuWhatsAppSectionId,
            width: 'half',
            show_in_table: false,
            options: WHATSAPP_RESULT_OPTIONS,
          },
          {
            id: uuid(),
            name: 'next_followup_after_days',
            label_ar: 'المتابعة التالية بعد (أيام)',
            label_en: 'Next Follow-up After (days)',
            type: 'number',
            required: false,
            order: 1,
            section_id: fuWhatsAppSectionId,
            width: 'half',
            show_in_table: false,
          },
        ],
      },
    ],
    // Three action buttons surfaced in the follow-up record form. All
    // three carry the trigger record's client through to the target via
    // a `client_id → client_id` prefill mapping. "Register a visit" runs
    // a find-or-create against the visits model: latest visit for this
    // client wins; if there is none, a blank visit form opens prefilled.
    custom_buttons: [
      {
        id: uuid(),
        label_ar: 'حجز زيارة',
        label_en: 'Book a visit',
        icon: 'calendar-plus',
        locations: ['record_form'],
        action: {
          type: 'create_record',
          target_model_id: visitsId,
          prefill: [{ target_field_name: 'client_id', source_field_name: 'client_id' }],
        },
      },
      {
        id: uuid(),
        label_ar: 'جدولة متابعة',
        label_en: 'Schedule follow-up',
        icon: 'calendar-clock',
        locations: ['record_form'],
        action: {
          type: 'create_record',
          target_model_id: followupsId,
          prefill: [{ target_field_name: 'client_id', source_field_name: 'client_id' }],
        },
      },
      {
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
            // an exact match links via client_id LIVE while typing. A zero
            // match creates a new client — but only at SAVE (see
            // auto_link_create_timing below), never mid-typing, so a
            // half-typed phone can't spawn a stray client. Same bidirectional
            // auto-fill as the visits model. Order 0 so the form opens with
            // the phone as the first focus.
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
            // Create a new client if no match: minimum 12 chars in the
            // normalized phone (E.164 SA mobile = +9665xxxxxxxx = 13).
            auto_link_create_if_missing: true,
            auto_link_create_min_length: 12,
            // Defer creation to the Save commit (createMissingLinkedRecords),
            // not the typing debounce — so a partial phone never creates a
            // client. The form shows a "new client created" popup afterwards.
            auto_link_create_timing: 'on_save',
            // Seed the new client's name from the appointment's typed
            // client_name (beyond the phone, which is always copied).
            auto_link_create_copy_fields: [{ from: 'client_name', to: 'client_name' }],
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
            name: 'units',
            label_ar: 'الوحدات',
            label_en: 'Units',
            type: 'unit_picker',
            required: false,
            order: 5,
            section_id: apptBaseSectionId,
            width: 'full',
            show_in_table: true,
            is_multi: true,
            unit_picker_unit_model_id: unitsId,
            unit_picker_project_link_field: 'project_id',
            // land the picker on the appointment's own selected project.
            unit_picker_project_from_field: 'project_id',
          },
          {
            id: uuid(),
            name: 'sales_rep',
            label_ar: 'مندوب المبيعات',
            label_en: 'Sales Rep',
            type: 'assignee',
            required: false,
            order: 6,
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
            order: 7,
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
            order: 8,
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
          // Live schema uses `unit_area` (the unit's main living area in m²)
          // and `total_price` (the unit's currency price). The rollups on
          // our_projects read these slugs — keep them in sync if you rename.
          {
            id: uuid(),
            name: 'unit_area',
            label_ar: 'مساحة الوحدة',
            label_en: 'Unit Area (m²)',
            type: 'number',
            required: false,
            order: 4,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'total_price',
            label_ar: 'إجمالي السعر',
            label_en: 'Total Price',
            type: 'currency',
            required: false,
            order: 5,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          // Bedrooms / bathrooms — required by the our_projects bedroom_range
          // and bathroom_range rollups (see src/lib/ourProjectsRollup.ts).
          // Read by slug `bedrooms` / `bathrooms`.
          {
            id: uuid(),
            name: 'bedrooms',
            label_ar: 'عدد غرف النوم',
            label_en: 'Bedrooms',
            type: 'number',
            required: false,
            order: 6,
            section_id: unitsBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'bathrooms',
            label_ar: 'عدد دورات المياه',
            label_en: 'Bathrooms',
            type: 'number',
            required: false,
            order: 7,
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
            order: 8,
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
    // The project detail page embeds a units inventory (UnitsInventory), whose
    // link lives on the child (units.project → all_projects). Declared here so
    // the reference-dependency resolver includes `units` when a profile is
    // granted this module — otherwise the inventory loads nothing for a
    // non-admin. See src/lib/moduleDependencies.ts.
    displayed_child_models: ['units'],
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
          {
            // The Arabic source-of-truth marketing document written by the
            // Data Migration PROJECT-PROFILE mode (docs/prd/data-migration.md).
            // Mirrors the field added to the LIVE all_projects on 2026-06-11 —
            // the by-name backfill never overwrites prod; this is for fresh
            // installs. The copywriter's get_project surfaces it automatically.
            id: uuid(),
            name: 'marketing_document',
            label_ar: 'الوثيقة التسويقية',
            label_en: 'Marketing Document',
            type: 'textarea',
            required: false,
            order: 12,
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
const targetedProjectsId = '8550651a-8d65-4e4d-a842-c800be336f78';
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
const ourProjectsId = '6609286a-f95a-45db-94e6-48cfa915ccbd';
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
          // 1:1 pointer to the master all_projects record. The unit rollups
          // (below) traverse this lookup → all_projects.id ← units.project_id
          // to find which units belong to this our_projects record. If this
          // field is empty the rollups all return 0 / null and the form
          // shows blank counts and ranges.
          {
            id: uuid(),
            name: 'project',
            label_ar: 'المشروع (من جميع المشاريع)',
            label_en: 'Master Project',
            type: 'lookup',
            required: false,
            order: 2.5,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
          },
          // ── Stored unit rollups (read-only) ──────────────────────────────
          // All eleven fields below are auto-calculated from the units
          // model — the rollup walks units whose `project_id` matches the
          // all_projects record this our_projects record links to via the
          // `project` lookup. See src/lib/ourProjectsRollup.ts for the
          // recipe per `rollup_kind`. Never user-edited: a DB trigger
          // (re)computes and STORES them on every write; the form disables
          // the input and the permissions resolver forces read-only.
          //
          // The existing `total_units` and `sold_units` field SLUGS are
          // preserved (the user opted to keep them as the destination
          // for units_count / units_sold_count) so dashboards, exports,
          // and downstream consumers that reference these slugs keep
          // working without a rename migration.
          {
            id: uuid(),
            name: 'total_units',
            label_ar: 'عدد الوحدات',
            label_en: 'Units Count',
            type: 'number',
            required: false,
            order: 3,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'units_count',
          },
          {
            id: uuid(),
            name: 'units_available',
            label_ar: 'الوحدات المتاحة',
            label_en: 'Units Available',
            type: 'number',
            required: false,
            order: 4,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'units_available_count',
          },
          {
            id: uuid(),
            name: 'sold_units',
            label_ar: 'الوحدات المباعة',
            label_en: 'Units Sold',
            type: 'number',
            required: false,
            order: 5,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'units_sold_count',
          },
          {
            id: uuid(),
            name: 'units_reserved',
            label_ar: 'الوحدات المحجوزة',
            label_en: 'Units Reserved',
            type: 'number',
            required: false,
            order: 6,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'units_reserved_count',
          },
          {
            id: uuid(),
            name: 'price_range',
            label_ar: 'نطاق السعر',
            label_en: 'Price Range',
            type: 'range',
            required: false,
            order: 7,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            range_unit_ar: 'ر.س',
            range_unit_en: 'SAR',
            is_rollup: true,
            read_only: true,
            rollup_kind: 'price_range',
          },
          {
            id: uuid(),
            name: 'area_range',
            label_ar: 'نطاق المساحة',
            label_en: 'Area Range',
            type: 'range',
            required: false,
            order: 8,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: true,
            range_unit_ar: 'م²',
            range_unit_en: 'm²',
            is_rollup: true,
            read_only: true,
            rollup_kind: 'area_range',
          },
          {
            id: uuid(),
            name: 'bedroom_range',
            label_ar: 'نطاق غرف النوم',
            label_en: 'Bedrooms Range',
            type: 'range',
            required: false,
            order: 9,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: false,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'bedroom_range',
          },
          {
            id: uuid(),
            name: 'bathroom_range',
            label_ar: 'نطاق دورات المياه',
            label_en: 'Bathrooms Range',
            type: 'range',
            required: false,
            order: 10,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: false,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'bathroom_range',
          },
          {
            id: uuid(),
            name: 'min_price_per_meter',
            label_ar: 'أدنى متوسط لسعر المتر',
            label_en: 'Min Avg Price per m²',
            type: 'currency',
            required: false,
            order: 11,
            section_id: opBaseSectionId,
            width: 'third',
            show_in_table: false,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'min_price_per_meter',
          },
          {
            id: uuid(),
            name: 'max_price_per_meter',
            label_ar: 'أعلى متوسط لسعر المتر',
            label_en: 'Max Avg Price per m²',
            type: 'currency',
            required: false,
            order: 12,
            section_id: opBaseSectionId,
            width: 'third',
            show_in_table: false,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'max_price_per_meter',
          },
          {
            id: uuid(),
            name: 'avg_price_per_meter',
            label_ar: 'متوسط سعر المتر',
            label_en: 'Avg Price per m²',
            type: 'currency',
            required: false,
            order: 13,
            section_id: opBaseSectionId,
            width: 'third',
            show_in_table: false,
            is_rollup: true,
            read_only: true,
            rollup_kind: 'avg_price_per_meter',
          },
          // Available-only price/area ranges (QA-003). Same recipe as
          // price_range / area_range but aggregated over units whose
          // unit_status matches the "available" option only — customer-facing
          // outputs read these so sold/reserved units never skew the quoted
          // starting price or area.
          {
            id: uuid(),
            name: 'available_price_range',
            label_ar: 'نطاق سعر الوحدات المتاحة',
            label_en: 'Available Price Range',
            type: 'range',
            required: false,
            order: 14,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: false,
            range_unit_ar: 'ر.س',
            range_unit_en: 'SAR',
            is_rollup: true,
            read_only: true,
            rollup_kind: 'available_price_range',
          },
          {
            id: uuid(),
            name: 'available_area_range',
            label_ar: 'نطاق مساحة الوحدات المتاحة',
            label_en: 'Available Area Range',
            type: 'range',
            required: false,
            order: 15,
            section_id: opBaseSectionId,
            width: 'half',
            show_in_table: false,
            range_unit_ar: 'م²',
            range_unit_en: 'm²',
            is_rollup: true,
            read_only: true,
            rollup_kind: 'available_area_range',
          },
          {
            id: uuid(),
            name: 'notes',
            label_ar: 'ملاحظات',
            label_en: 'Notes',
            type: 'textarea',
            required: false,
            order: 16,
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
            // Show the client's auto-id (CLT-0001 …) in the picker + table, not
            // the record UUID. The clients auto-id field's slug is `client_id`
            // (an earlier value of 'client_code' did not exist on the clients
            // model, so the lookup fell back to a truncated UUID).
            lookup_display_field: 'client_id',
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
            // Create-if-missing, deferred to Save: a typed phone that matches no
            // client spawns a NEW client (with phone + the typed name) only when
            // the visit is committed — never mid-typing. See
            // createMissingLinkedRecords + RecordFormPage.handleSave.
            auto_link_create_if_missing: true,
            auto_link_create_timing: 'on_save',
            auto_link_create_min_length: 9,
            auto_link_create_copy_fields: [{ from: 'name', to: 'client_name' }],
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
            // Default a new visit's date/time to now (seeded by useFieldDefaults).
            default_dynamic: 'now',
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
          {
            id: visitsUnitsFieldId,
            name: 'units',
            label_ar: 'الوحدات',
            label_en: 'Units',
            type: 'unit_picker',
            required: false,
            order: 5,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
            is_multi: true,
            // Cascading project → unit picker. The project step is a FILTER only
            // (sourced from All Projects, which own the units); the stored value
            // is the selected unit id(s). Units render as cards (units card_config).
            unit_picker_unit_model_id: unitsId,
            unit_picker_project_link_field: 'project_id',
          },
          {
            id: visitsSalesRepFieldId,
            name: 'sales_representative',
            label_ar: 'ممثل المبيعات',
            label_en: 'Sales Representative',
            type: 'assignee',
            required: false,
            order: 6,
            section_id: visitsBasicSectionId,
            width: 'half',
            show_in_table: true,
            // Default a new visit's rep to the signed-in user (useFieldDefaults).
            default_dynamic: 'current_user',
          },
          {
            id: visitsNotesFieldId,
            name: 'visit_notes',
            label_ar: 'ملاحظات الزيارة',
            label_en: 'Visit Notes',
            type: 'notes',
            required: false,
            order: 7,
            section_id: visitsBasicSectionId,
            width: 'full',
            show_in_table: true,
          },
          {
            // FOLLOWUP_4: links a visit back to the follow-up it was registered
            // from (the Follow-up Workspace "Register Visit" action sets this).
            // Mirrors appointments.source_followup_id — hidden from tables, not a
            // field the rep edits. Drives the "Visit already registered" badge.
            id: visitsSourceFollowupFieldId,
            name: 'source_followup_id',
            label_ar: 'المتابعة المصدر',
            label_en: 'Source Follow-up',
            type: 'lookup',
            required: false,
            order: 50,
            section_id: visitsBasicSectionId,
            width: 'half',
            is_multi: false,
            show_in_table: false,
            lookup_model_id: followupsId,
            lookup_display_field: 'scheduled_datetime',
            lookup_max_records: 20,
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

export const chatsId = '7e6c23b5-5492-413a-bc34-d928086f6e7e';
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
          {
            // Read-only mirror of the linked client's owner (clients.client_owner,
            // a public.users.id). Populated by DB triggers, NOT the user. Exists so
            // the per-profile view-scope engine — which can't traverse the
            // client_link lookup — can gate chats by "client_owner equals current
            // user" (managed from Settings → WhatsApp Permissions). See migration
            // 2026-08-14_chat_client_owner_mirror.sql.
            id: uuid(),
            name: 'client_owner',
            label_ar: 'مستشار المبيعات',
            label_en: 'Sales Consultant',
            type: 'assignee',
            required: false,
            read_only: true,
            order: 12,
            section_id: chatsBaseSectionId,
            width: 'half',
            show_in_table: false,
            assignee_role_ids: [],
          },
          {
            // Direction of the newest message ('in' = customer spoke last).
            // Stamped by the Haberchat webhook + the Realtime bump; drives
            // the chat list's "needs reply" filter.
            id: uuid(),
            name: 'last_message_flow',
            label_ar: 'اتجاه آخر رسالة',
            label_en: 'Last Message Flow',
            type: 'dropdown',
            required: false,
            order: 12,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: false,
            options: [
              { id: uuid(), label_ar: 'وارد', label_en: 'Inbound', value: 'in', color: '#10B981' },
              { id: uuid(), label_ar: 'صادر', label_en: 'Outbound', value: 'out', color: '#B8734F' },
            ],
          },
          {
            // When this app's user last opened the conversation (markChatAsRead
            // stamps it alongside persisting unread_count = 0). unread_count is
            // CRM-owned: the webhook increments, opening the chat clears —
            // Haberchat's own unread (the phone's read state) only seeds chats
            // we've never tracked.
            id: uuid(),
            name: 'last_read_at',
            label_ar: 'آخر قراءة',
            label_en: 'Last Read At',
            type: 'datetime',
            required: false,
            order: 13,
            section_id: chatsBaseSectionId,
            width: 'third',
            show_in_table: false,
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

export const aiChatsId = 'ca95e4eb-da23-47fa-9f77-3149ba5fa37c';
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
// COPYWRITER MODEL — real-estate copywriter agent conversations
// ============================================================
// Each record is one copywriter conversation; messages live inline in
// record.data.messages (same shape as ai_chats). Renders a custom split-pane
// UI (src/pages/Copywriter), backed by api/copywriter.ts. The agent retrieves
// over the enriched `competitors` reel library (proven patterns) + our
// projects, and writes/improves/analyzes reel scripts + hooks. Phase 3 of the
// copywriter intelligence system — see docs/prd/copywriter-intelligence.md.
export const copywriterChatsId = '09ba91d8-692f-4aed-a557-4af5888c81be';
const copywriterChatsBaseSectionId = uuid();
const copywriterChatsTitleFieldId = uuid();
const copywriterChatsStatusFieldId = uuid();
const copywriterChatsLastMessageFieldId = uuid();

const copywriterChatsModel: AppModel = {
  id: copywriterChatsId,
  name: 'copywriter_chats',
  label_ar: 'كاتب المحتوى',
  label_en: 'Copywriter',
  icon: 'pen-line',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: copywriterChatsTitleFieldId,
    subtitle_field_id: copywriterChatsLastMessageFieldId,
    badge_field_id: copywriterChatsStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: copywriterChatsBaseSectionId,
        label_ar: 'معلومات المحادثة',
        label_en: 'Conversation',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: copywriterChatsTitleFieldId, name: 'title', label_ar: 'العنوان', label_en: 'Title', type: 'text', required: false, order: 0, section_id: copywriterChatsBaseSectionId, width: 'full', show_in_table: true },
          { id: copywriterChatsStatusFieldId, name: 'status', label_ar: 'الحالة', label_en: 'Status', type: 'dropdown', required: false, order: 1, section_id: copywriterChatsBaseSectionId, width: 'third', show_in_table: true, options: [
            { id: uuid(), label_ar: 'نشط', label_en: 'Active', value: 'active', color: '#22c55e' },
            { id: uuid(), label_ar: 'مؤرشف', label_en: 'Archived', value: 'archived', color: '#9ca3af' },
          ] },
          { id: uuid(), name: 'message_count', label_ar: 'عدد الرسائل', label_en: 'Messages', type: 'number', required: false, order: 2, section_id: copywriterChatsBaseSectionId, width: 'third', show_in_table: true },
          { id: copywriterChatsLastMessageFieldId, name: 'last_message_at', label_ar: 'آخر رسالة', label_en: 'Last Message', type: 'datetime', required: false, order: 3, section_id: copywriterChatsBaseSectionId, width: 'third', show_in_table: true },
          { id: uuid(), name: 'feedback_score', label_ar: 'تقييم الجودة', label_en: 'Feedback Score', type: 'dropdown', required: false, order: 4, section_id: copywriterChatsBaseSectionId, width: 'third', show_in_table: false, options: [
            { id: uuid(), label_ar: '⭐ ضعيف', label_en: '1 - Poor', value: '1', color: '#ef4444' },
            { id: uuid(), label_ar: '⭐⭐ مقبول', label_en: '2 - Fair', value: '2', color: '#f59e0b' },
            { id: uuid(), label_ar: '⭐⭐⭐ جيد', label_en: '3 - Good', value: '3', color: '#eab308' },
            { id: uuid(), label_ar: '⭐⭐⭐⭐ ممتاز', label_en: '4 - Great', value: '4', color: '#84cc16' },
            { id: uuid(), label_ar: '⭐⭐⭐⭐⭐ مذهل', label_en: '5 - Excellent', value: '5', color: '#22c55e' },
          ] },
          { id: uuid(), name: 'linked_project_id', label_ar: 'المشروع المرتبط', label_en: 'Linked Project', type: 'lookup', required: false, order: 5, section_id: copywriterChatsBaseSectionId, width: 'full', show_in_table: false, lookup_model_id: allProjectsId, lookup_display_field: 'project_name' },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// MATCHING ASSISTANT CHATS (matching_chats) — live-call Project Matching Assistant
// ============================================================
// Custom split-pane chat UI (src/pages/Matching) backed by api/match — the
// Phase 1 Project Matching Assistant. Each record is one matching session;
// messages live inline in record.data.messages (a JSON array). The agent's
// structured recommendation (emit_recommendation → ProjectMatchCard) is
// display-only, so this model carries NO lookup field (avoids the seed-backfill
// stale-lookup-id drift) and needs no extra columns.
//
// Stable id so the prod migration (supabase/migrations/2026-06-18_matching_chats_model.sql)
// and this seed share one model id. Found by NAME in the UI, so the id only
// matters for deterministic creation. The slug `matching_chats` is NOT in
// RETIRED_SYSTEM_MODEL_NAMES.
export const MATCHING_CHATS_MODEL_ID = '7c0ffee2-5cab-4b0a-9d3e-12ab34cd56ef';
const matchingChatsBaseSectionId = uuid();
const matchingChatsTitleFieldId = uuid();
const matchingChatsStatusFieldId = uuid();
const matchingChatsLastMessageFieldId = uuid();

const matchingChatsModel: AppModel = {
  id: MATCHING_CHATS_MODEL_ID,
  // User-facing name is the UNIFIED "Sales Assistant" (مساعد المبيعات). Project
  // matching is its FIRST active capability; future capabilities (next-best-
  // action, follow-ups, comparison) expand this SAME assistant — no second face.
  // Technical name stays `matching_chats` (Option B — no destabilizing rename).
  name: 'matching_chats',
  label_ar: 'مساعد المبيعات',
  label_en: 'Sales Assistant',
  icon: 'compass',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: matchingChatsTitleFieldId,
    subtitle_field_id: matchingChatsLastMessageFieldId,
    badge_field_id: matchingChatsStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: matchingChatsBaseSectionId,
        label_ar: 'معلومات المحادثة',
        label_en: 'Conversation',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: matchingChatsTitleFieldId, name: 'title', label_ar: 'العنوان', label_en: 'Title', type: 'text', required: false, order: 0, section_id: matchingChatsBaseSectionId, width: 'full', show_in_table: true },
          { id: matchingChatsStatusFieldId, name: 'status', label_ar: 'الحالة', label_en: 'Status', type: 'dropdown', required: false, order: 1, section_id: matchingChatsBaseSectionId, width: 'third', show_in_table: true, options: [
            { id: uuid(), label_ar: 'نشط', label_en: 'Active', value: 'active', color: '#22c55e' },
            { id: uuid(), label_ar: 'مؤرشف', label_en: 'Archived', value: 'archived', color: '#9ca3af' },
          ] },
          { id: uuid(), name: 'message_count', label_ar: 'عدد الرسائل', label_en: 'Messages', type: 'number', required: false, order: 2, section_id: matchingChatsBaseSectionId, width: 'third', show_in_table: true },
          { id: matchingChatsLastMessageFieldId, name: 'last_message_at', label_ar: 'آخر رسالة', label_en: 'Last Message', type: 'datetime', required: false, order: 3, section_id: matchingChatsBaseSectionId, width: 'third', show_in_table: true },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// REELS MODEL (reel_scripts) — production records for marketing reels
// ============================================================
// Manages reel production + content. The copywriter agent (above) emits a
// structured reel script via its emit_reel_script tool; the chat renders it as
// a table with a "Create Reel" button that opens a PREFILLED record of this
// model (project + script table auto-filled) for the user to review and Save.
//
// Slug is `reel_scripts`, NOT `reels` — `reels` is in RETIRED_SYSTEM_MODEL_NAMES
// (the retired 2026-05-09 marketing pipeline) and would be hard-deleted on load.
// The user-facing label is "Reels".
//
// Stable id so the prod migration (supabase/migrations/2026-06-10_reel_scripts_model.sql)
// and this seed share one model id. The seed's `project` lookup targets the seed
// allProjectsId (fresh installs); the prod row targets the LIVE all_projects id.
export const REEL_SCRIPTS_MODEL_ID = '7c0ffee1-5cab-4b0a-9d3e-12ab34cd56ef';
const reelScriptsBasicSectionId = uuid();
const reelScriptsBriefSectionId = uuid();
const reelScriptsScriptSectionId = uuid();
const reelScriptsProductionSectionId = uuid();
const reelScriptsTitleFieldId = uuid();
const reelScriptsStatusFieldId = uuid();

const reelScriptsModel: AppModel = {
  id: REEL_SCRIPTS_MODEL_ID,
  name: 'reel_scripts',
  label_ar: 'الريلز',
  label_en: 'Reels',
  icon: 'clapperboard',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: reelScriptsTitleFieldId,
    subtitle_field_id: null,
    badge_field_id: reelScriptsStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: reelScriptsBasicSectionId,
        label_ar: 'معلومات أساسية',
        label_en: 'Basic Information',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: reelScriptsTitleFieldId, name: 'title', label_ar: 'العنوان', label_en: 'Title', type: 'text', required: true, order: 0, section_id: reelScriptsBasicSectionId, width: 'half', show_in_table: true },
          { id: uuid(), name: 'project', label_ar: 'المشروع', label_en: 'Project', type: 'lookup', required: false, order: 1, section_id: reelScriptsBasicSectionId, width: 'half', show_in_table: true, lookup_model_id: allProjectsId, lookup_display_field: 'project_name', is_multi: false },
          { id: reelScriptsStatusFieldId, name: 'status', label_ar: 'الحالة', label_en: 'Status', type: 'dropdown', required: false, order: 2, section_id: reelScriptsBasicSectionId, width: 'half', show_in_table: true, options: [
            { id: uuid(), label_ar: 'مسودة', label_en: 'Draft', value: 'draft', color: '#9ca3af' },
            { id: uuid(), label_ar: 'كتابة السيناريو', label_en: 'Scripting', value: 'scripting', color: '#3b82f6' },
            { id: uuid(), label_ar: 'قيد الإنتاج', label_en: 'In Production', value: 'in_production', color: '#f59e0b' },
            { id: uuid(), label_ar: 'قيد المراجعة', label_en: 'In Review', value: 'in_review', color: '#eab308' },
            { id: uuid(), label_ar: 'معتمد', label_en: 'Approved', value: 'approved', color: '#22c55e' },
            { id: uuid(), label_ar: 'منشور', label_en: 'Published', value: 'published', color: '#8b5cf6' },
          ] },
        ],
      },
      {
        id: reelScriptsBriefSectionId,
        label_ar: 'الفكرة',
        label_en: 'Brief',
        order: 1,
        is_base: true,
        color: '#C09B5F',
        fields: [
          { id: uuid(), name: 'reel_idea', label_ar: 'فكرة الريل', label_en: 'Reel Idea', type: 'textarea', required: false, order: 0, section_id: reelScriptsBriefSectionId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'objective', label_ar: 'الهدف', label_en: 'Objective', type: 'text', required: false, order: 1, section_id: reelScriptsBriefSectionId, width: 'half', show_in_table: false },
          { id: uuid(), name: 'target_audience', label_ar: 'الجمهور المستهدف', label_en: 'Target Audience', type: 'text', required: false, order: 2, section_id: reelScriptsBriefSectionId, width: 'half', show_in_table: false },
          { id: uuid(), name: 'key_message', label_ar: 'الرسالة الأساسية', label_en: 'Key Message', type: 'textarea', required: false, order: 3, section_id: reelScriptsBriefSectionId, width: 'full', show_in_table: false },
        ],
      },
      {
        id: reelScriptsScriptSectionId,
        label_ar: 'السيناريو',
        label_en: 'Script',
        order: 2,
        is_base: true,
        color: '#8E4E3A',
        fields: [
          { id: uuid(), name: 'hook', label_ar: 'الخطّاف', label_en: 'Hook', type: 'textarea', required: false, order: 0, section_id: reelScriptsScriptSectionId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'angle', label_ar: 'الزاوية / المحفّز', label_en: 'Angle / Trigger', type: 'text', required: false, order: 1, section_id: reelScriptsScriptSectionId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'script_table', label_ar: 'جدول السيناريو', label_en: 'Script Table', type: 'table', required: false, order: 2, section_id: reelScriptsScriptSectionId, width: 'full', show_in_table: false,
            table_columns: [
              { id: uuid(), name: 'scene', label_ar: 'المشهد', label_en: 'Scene', type: 'text', required: false },
              { id: uuid(), name: 'voiceover', label_ar: 'التعليق الصوتي', label_en: 'Voiceover', type: 'textarea', required: false },
              { id: uuid(), name: 'visual', label_ar: 'التوجيه البصري', label_en: 'Visual Direction', type: 'textarea', required: false },
              { id: uuid(), name: 'on_screen_text', label_ar: 'نص على الشاشة', label_en: 'On-Screen Text', type: 'textarea', required: false },
              { id: uuid(), name: 'notes', label_ar: 'ملاحظات', label_en: 'Notes', type: 'text', required: false },
            ] },
          { id: uuid(), name: 'cta', label_ar: 'الدعوة', label_en: 'CTA', type: 'textarea', required: false, order: 3, section_id: reelScriptsScriptSectionId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'alt_hooks', label_ar: 'خطّافات بديلة', label_en: 'Alternative Hooks', type: 'textarea', required: false, order: 4, section_id: reelScriptsScriptSectionId, width: 'full', show_in_table: false },
        ],
      },
      {
        id: reelScriptsProductionSectionId,
        label_ar: 'الإنتاج',
        label_en: 'Production',
        order: 3,
        is_base: true,
        color: '#4A2C2A',
        fields: [
          { id: uuid(), name: 'approval_status', label_ar: 'حالة الاعتماد', label_en: 'Approval Status', type: 'dropdown', required: false, order: 0, section_id: reelScriptsProductionSectionId, width: 'half', show_in_table: true, options: [
            { id: uuid(), label_ar: 'معلّق', label_en: 'Pending', value: 'pending', color: '#9ca3af' },
            { id: uuid(), label_ar: 'معتمد', label_en: 'Approved', value: 'approved', color: '#22c55e' },
            { id: uuid(), label_ar: 'تعديلات مطلوبة', label_en: 'Changes Requested', value: 'changes_requested', color: '#ef4444' },
          ] },
          { id: uuid(), name: 'review_comments', label_ar: 'ملاحظات المراجعة', label_en: 'Review Comments', type: 'notes', required: false, order: 1, section_id: reelScriptsProductionSectionId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'production_notes', label_ar: 'ملاحظات الإنتاج', label_en: 'Production Notes', type: 'notes', required: false, order: 2, section_id: reelScriptsProductionSectionId, width: 'full', show_in_table: false },
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

export const phoneCallsId = '1ef36cc7-a5bb-4fdc-b3ef-9fc965c2b2d4';
const phoneCallsBaseSectionId = uuid();
const phoneCallsTranscriptSectionId = uuid();
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
            // Linked app user who handled the call. Populated by the webhook
            // matching Hatif's agent (by email, then name) to a CRM user; left
            // empty when no app user matches. The raw Hatif name lives on in
            // call_logs.agent_name for the Call History panel.
            id: uuid(),
            name: 'agent_name',
            label_ar: 'الموظف',
            label_en: 'Agent',
            type: 'assignee',
            assignee_user_filter_mode: 'all',
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
      {
        // Dedicated section so staff can read the full call transcript. The
        // webhook mirrors call_logs.transcription.text into the record's
        // `transcription_text` slug, which this textarea renders.
        id: phoneCallsTranscriptSectionId,
        label_ar: 'نص المكالمة',
        label_en: 'Call Transcript',
        order: 1,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: uuid(),
            name: 'transcription_text',
            label_ar: 'النص الكامل للمكالمة',
            label_en: 'Full Transcript',
            type: 'textarea',
            required: false,
            order: 0,
            section_id: phoneCallsTranscriptSectionId,
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
// MARKETING REFERENCE — COMPETITORS LIBRARY
// ============================================================
//
// Reusable library of competitor content samples. Standalone reference
// data; the old agent-driven marketing pipeline that consumed this was
// replaced by the template-driven design generator (2026-05-09 rebuild).

// --- COMPETITORS MODEL ---
const competitorsId = '484b5157-ed8c-4013-9dd7-442476a7f9ff';
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
          { id: uuid(), name: 'type', label_ar: 'النوع', label_en: 'Type', type: 'dropdown', required: true, order: 1, section_id: competitorsBaseId, width: 'half', show_in_table: true, options: [opt('reel_script', 'Reel Script'), opt('post_example', 'Post Example'), { id: uuid(), value: 'our_script', label_ar: 'نصّنا', label_en: 'Our Script' }] },
          { id: uuid(), name: 'content', label_ar: 'المحتوى', label_en: 'Content', type: 'textarea', required: true, order: 2, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'notes', label_ar: 'ملاحظات', label_en: 'Notes', type: 'textarea', required: false, order: 3, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          // --- Reel marketing-analysis fields (added 2026-06-09, mirrors
          // supabase/migrations/2026-06-09_competitor_reel_analysis_fields.sql).
          // Populated by api/_lib/reelAnalyst.ts via the "Clean & Analyze"
          // button + scripts/backfill-reel-analysis.mjs. These are the
          // knowledge base the copywriter agent retrieves over.
          { id: uuid(), name: 'clean_content', label_ar: 'النص المنقّح', label_en: 'Clean Transcript', type: 'textarea', required: false, order: 4, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'hook', label_ar: 'الخطّاف (الجملة الافتتاحية)', label_en: 'Hook', type: 'textarea', required: false, order: 5, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'hook_type', label_ar: 'نوع الخطّاف', label_en: 'Hook Type', type: 'dropdown', required: false, order: 6, section_id: competitorsBaseId, width: 'half', show_in_table: true, options: [
            { id: uuid(), value: 'question', label_ar: 'سؤال', label_en: 'Question' },
            { id: uuid(), value: 'curiosity', label_ar: 'فضول', label_en: 'Curiosity' },
            { id: uuid(), value: 'shock', label_ar: 'صدمة', label_en: 'Shock' },
            { id: uuid(), value: 'lifestyle', label_ar: 'نمط حياة', label_en: 'Lifestyle' },
            { id: uuid(), value: 'investment', label_ar: 'فرصة استثمارية', label_en: 'Investment' },
            { id: uuid(), value: 'problem', label_ar: 'طرح مشكلة', label_en: 'Problem' },
            { id: uuid(), value: 'statement', label_ar: 'تصريح جريء', label_en: 'Statement' },
          ] },
          { id: uuid(), name: 'angle', label_ar: 'الزاوية الرئيسية', label_en: 'Main Angle', type: 'multiselect', required: false, order: 7, section_id: competitorsBaseId, width: 'full', show_in_table: false, options: [
            { id: uuid(), value: 'location', label_ar: 'الموقع', label_en: 'Location' },
            { id: uuid(), value: 'luxury', label_ar: 'الفخامة', label_en: 'Luxury' },
            { id: uuid(), value: 'privacy', label_ar: 'الخصوصية', label_en: 'Privacy' },
            { id: uuid(), value: 'family', label_ar: 'الحياة العائلية', label_en: 'Family living' },
            { id: uuid(), value: 'investment_return', label_ar: 'العائد الاستثماري', label_en: 'Investment return' },
            { id: uuid(), value: 'exclusivity', label_ar: 'الحصرية', label_en: 'Exclusivity' },
            { id: uuid(), value: 'space', label_ar: 'المساحة والرحابة', label_en: 'Space' },
            { id: uuid(), value: 'design', label_ar: 'التصميم', label_en: 'Design' },
            { id: uuid(), value: 'value', label_ar: 'القيمة مقابل السعر', label_en: 'Value' },
            { id: uuid(), value: 'amenities', label_ar: 'الخدمات والمرافق', label_en: 'Amenities' },
          ] },
          { id: uuid(), name: 'psych_trigger', label_ar: 'المحفّز النفسي', label_en: 'Psychological Trigger', type: 'multiselect', required: false, order: 8, section_id: competitorsBaseId, width: 'full', show_in_table: false, options: [
            { id: uuid(), value: 'status', label_ar: 'المكانة الاجتماعية', label_en: 'Status' },
            { id: uuid(), value: 'fomo', label_ar: 'الخوف من فوات الفرصة', label_en: 'Fear of missing out' },
            { id: uuid(), value: 'security', label_ar: 'الأمان', label_en: 'Security' },
            { id: uuid(), value: 'comfort', label_ar: 'الراحة', label_en: 'Comfort' },
            { id: uuid(), value: 'achievement', label_ar: 'الإنجاز', label_en: 'Achievement' },
            { id: uuid(), value: 'pride', label_ar: 'الفخر', label_en: 'Pride' },
            { id: uuid(), value: 'convenience', label_ar: 'السهولة والتيسير', label_en: 'Convenience' },
            { id: uuid(), value: 'wealth', label_ar: 'الثراء', label_en: 'Wealth' },
            { id: uuid(), value: 'belonging', label_ar: 'الانتماء', label_en: 'Belonging' },
            { id: uuid(), value: 'aspiration', label_ar: 'الطموح', label_en: 'Aspiration' },
          ] },
          { id: uuid(), name: 'structure', label_ar: 'بنية النص', label_en: 'Script Structure', type: 'textarea', required: false, order: 9, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'tone', label_ar: 'النبرة', label_en: 'Tone', type: 'multiselect', required: false, order: 10, section_id: competitorsBaseId, width: 'half', show_in_table: false, options: [
            { id: uuid(), value: 'luxury', label_ar: 'فاخرة', label_en: 'Luxury' },
            { id: uuid(), value: 'premium', label_ar: 'راقية', label_en: 'Premium' },
            { id: uuid(), value: 'urgent', label_ar: 'عاجلة', label_en: 'Urgent' },
            { id: uuid(), value: 'friendly', label_ar: 'ودّية', label_en: 'Friendly' },
            { id: uuid(), value: 'expert', label_ar: 'احترافية', label_en: 'Expert' },
            { id: uuid(), value: 'educational', label_ar: 'تثقيفية', label_en: 'Educational' },
            { id: uuid(), value: 'aspirational', label_ar: 'ملهمة', label_en: 'Aspirational' },
            { id: uuid(), value: 'warm', label_ar: 'دافئة', label_en: 'Warm' },
          ] },
          { id: uuid(), name: 'cta', label_ar: 'الدعوة لاتخاذ إجراء', label_en: 'CTA', type: 'text', required: false, order: 11, section_id: competitorsBaseId, width: 'half', show_in_table: false },
          { id: uuid(), name: 'cta_type', label_ar: 'نوع الدعوة', label_en: 'CTA Type', type: 'dropdown', required: false, order: 12, section_id: competitorsBaseId, width: 'half', show_in_table: false, options: [
            { id: uuid(), value: 'book_visit', label_ar: 'احجز زيارة', label_en: 'Book a visit' },
            { id: uuid(), value: 'contact', label_ar: 'تواصل معنا', label_en: 'Contact us' },
            { id: uuid(), value: 'reserve', label_ar: 'احجز الآن', label_en: 'Reserve now' },
            { id: uuid(), value: 'message', label_ar: 'أرسل رسالة', label_en: 'Send a message' },
            { id: uuid(), value: 'whatsapp', label_ar: 'واتساب', label_en: 'WhatsApp' },
            { id: uuid(), value: 'visit_location', label_ar: 'زورونا بالموقع', label_en: 'Visit location' },
            { id: uuid(), value: 'learn_more', label_ar: 'اعرف المزيد', label_en: 'Learn more' },
            { id: uuid(), value: 'none', label_ar: 'بدون دعوة', label_en: 'None' },
          ] },
          { id: uuid(), name: 'analysis_notes', label_ar: 'ملاحظات التحليل', label_en: 'Analysis Notes', type: 'textarea', required: false, order: 13, section_id: competitorsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'processing_status', label_ar: 'حالة المعالجة', label_en: 'Processing Status', type: 'dropdown', required: false, order: 14, section_id: competitorsBaseId, width: 'half', show_in_table: true, options: [
            { id: uuid(), value: 'raw', label_ar: 'خام', label_en: 'Raw', color: '#9CA3AF' },
            { id: uuid(), value: 'cleaned', label_ar: 'منقّح', label_en: 'Cleaned', color: '#60A5FA' },
            { id: uuid(), value: 'analyzed', label_ar: 'محلَّل', label_en: 'Analyzed', color: '#34D399' },
            { id: uuid(), value: 'reviewed', label_ar: 'مُراجَع', label_en: 'Reviewed', color: '#B8734F' },
            { id: uuid(), value: 'skipped', label_ar: 'متجاوَز', label_en: 'Skipped', color: '#D1D5DB' },
            { id: uuid(), value: 'error', label_ar: 'خطأ', label_en: 'Error', color: '#EF4444' },
          ] },
        ],
      },
    ],
    section_selector_field_id: null,
    // "Clean & Analyze" — runs api/_lib/reelAnalyst.mjs on this reel's raw
    // `content` and writes back the cleaned transcript + analysis fields.
    custom_buttons: [
      {
        id: uuid(),
        label_ar: 'تنظيف وتحليل',
        label_en: 'Clean & Analyze',
        icon: 'sparkles',
        color: '#B8734F',
        locations: ['record_form'],
        action: { type: 'analyze_reel' },
        enabled: true,
      },
    ],
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
const designTemplatesId = '457b679b-0c39-44ac-a345-8c911ebacfe1';
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
const marketingOperationsId = '58e92e8d-b7c6-48ef-b9c4-41987e522075';
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

export const chatTemplatesId = '4a70d8f1-2a6a-4ea7-b7ef-45c6e6af732b';
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
          // Set by the AI Project Message generator — links a generated
          // template back to the master all_projects record it was built from.
          {
            id: uuid(),
            name: 'project_id',
            label_ar: 'المشروع',
            label_en: 'Project',
            type: 'lookup',
            required: false,
            order: 10,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: allProjectsId,
            lookup_display_field: 'project_name',
          },
          // Set by the Listing Message generator — links a generated template
          // back to the market_listings record it was built from. Market
          // listings are created out-of-band (Aqar import) with the stable id
          // below; the same literal is used by clients.preferred_market_listings.
          {
            id: uuid(),
            name: 'listing_id',
            label_ar: 'إعلان السوق',
            label_en: 'Market Listing',
            type: 'lookup',
            required: false,
            order: 11,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: '8f06bc39-4bee-42e9-9fab-77023fb89ede',
            lookup_display_field: 'title',
          },
          // Classification driving the picker's tabs. Legacy records without a
          // value derive it from project_id/listing_id — see
          // src/lib/chatTemplates.ts resolveTemplateCategory.
          {
            id: uuid(),
            name: 'category',
            label_ar: 'التصنيف',
            label_en: 'Category',
            type: 'dropdown',
            required: false,
            order: 12,
            section_id: chatTemplatesBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'رسائل المشاريع', label_en: 'Project messages', value: 'project', color: '#B8734F' },
              { id: uuid(), label_ar: 'رسائل التواصل', label_en: 'Contact messages', value: 'contact', color: '#C09B5F' },
            ],
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
const siteSettingsId = '0fcb55a5-f7e7-452f-90db-d05c728798c2';
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

export const decksId = 'b5593ffd-c79c-4847-87fb-4621e47d29d9';
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
// IMAGE PRESETS (brand-preset library for the Image Chats UI)
// ============================================================
// Library of named brand presets the Image Chats composer offers in
// its `[Brand: …]` dropdown. Picking one prepends `prompt_text` to the
// user's prompt before fal.ai sees it, AND auto-attaches the preset's
// `images` (logos, layout refs) as additional inputs to nano-banana-pro/edit.
// Edited via the standard record form. Records here are shared across
// the org — same RLS posture as design_templates.
const imagePresetsId = '4629991b-6d10-4048-ba96-06db708f67d5';
const imagePresetsBaseId = uuid();
const imagePresetsModel: AppModel = {
  id: imagePresetsId,
  name: 'image_presets',
  label_ar: 'إعدادات العلامة التجارية',
  label_en: 'Brand Presets',
  icon: 'sparkles',
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
        id: imagePresetsBaseId,
        label_ar: 'الإعداد',
        label_en: 'Preset',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: uuid(), name: 'name',        label_ar: 'الاسم',          label_en: 'Name',        type: 'text',     required: true,  order: 0, section_id: imagePresetsBaseId, width: 'half', show_in_table: true },
          { id: uuid(), name: 'description', label_ar: 'الوصف المختصر', label_en: 'Description', type: 'text',     required: false, order: 1, section_id: imagePresetsBaseId, width: 'half', show_in_table: true },
          { id: uuid(), name: 'prompt_text', label_ar: 'نص الإعداد',     label_en: 'Brand prompt', type: 'textarea', required: true,  order: 2, section_id: imagePresetsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'images',      label_ar: 'الأصول',         label_en: 'Assets',      type: 'multi_image', required: false, order: 3, section_id: imagePresetsBaseId, width: 'full', show_in_table: false, image_folder: 'presets', image_max_size_mb: 10 },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// PROMPT SNIPPETS (prompt-template library for the Image Chats UI)
// ============================================================
// Library of reusable user-prompt templates surfaced via the 📚
// picker in the Image Chats composer. Picking a snippet fills the
// textarea (user can edit before sending) AND auto-attaches any
// `images` on the snippet to the current turn's input list.
const promptSnippetsId = 'fd5bab91-50a8-41e9-a733-bce2592559f3';
const promptSnippetsBaseId = uuid();
const promptSnippetsModel: AppModel = {
  id: promptSnippetsId,
  name: 'prompt_snippets',
  label_ar: 'مكتبة التعليمات',
  label_en: 'Prompt Library',
  icon: 'file-text',
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
        id: promptSnippetsBaseId,
        label_ar: 'التعليمة',
        label_en: 'Snippet',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          { id: uuid(), name: 'title',    label_ar: 'العنوان', label_en: 'Title',    type: 'text',     required: true,  order: 0, section_id: promptSnippetsBaseId, width: 'half', show_in_table: true },
          { id: uuid(), name: 'category', label_ar: 'التصنيف', label_en: 'Category', type: 'dropdown', required: false, order: 1, section_id: promptSnippetsBaseId, width: 'half', show_in_table: true,
            options: [
              opt('عرض عقار',        'Property listing'),
              opt('إعلان إطلاق',     'Launch announcement'),
              opt('نمط حياة',        'Lifestyle'),
              opt('تحرير / تنظيف',   'Edit / cleanup'),
              opt('متفرقات',         'Other'),
            ] },
          { id: uuid(), name: 'text',     label_ar: 'النص',     label_en: 'Prompt text', type: 'textarea',    required: true,  order: 2, section_id: promptSnippetsBaseId, width: 'full', show_in_table: false },
          { id: uuid(), name: 'images',   label_ar: 'صور مرفقة', label_en: 'Attached images', type: 'multi_image', required: false, order: 3, section_id: promptSnippetsBaseId, width: 'full', show_in_table: false, image_folder: 'snippets', image_max_size_mb: 10 },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// IMAGE CHATS (Nano Banana 2 chat UI — "mini Higgsfield" inside Wassell)
// ============================================================
// Each record is one design conversation. Messages live inline in
// `record.data.messages` as a JSONB array of `{ id, role, text?,
// images[], aspect_ratio, created_at, num_variations?, preset_id? }`.
// The list / detail routes are overridden to render ImageChatsPage
// instead of the generic record table/form — see App.tsx dispatcher.
// fal.ai-orchestrated turns flow through POST /api/image-chat/send;
// the user message is appended client-side, the assistant message is
// appended server-side once nano-banana-pro/edit returns and the
// result is re-hosted in marketing-assets/image-chats/outputs/.
const imageChatsId = '9dfb157f-b464-4899-b729-ad81360bfd0d';
const imageChatsBaseId = uuid();
const imageChatsTitleFieldId = uuid();
const imageChatsStatusFieldId = uuid();
const imageChatsLastMessageFieldId = uuid();
const imageChatsModel: AppModel = {
  id: imageChatsId,
  name: 'image_chats',
  label_ar: 'محادثات التصميم',
  label_en: 'Image Chats',
  icon: 'sparkles',
  color: '#B8734F',
  group_id: DESIGNS_GROUP_ID,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: imageChatsTitleFieldId,
    subtitle_field_id: null,
    badge_field_id: imageChatsStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: imageChatsBaseId,
        label_ar: 'المحادثة',
        label_en: 'Conversation',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: imageChatsTitleFieldId,
            name: 'title',
            label_ar: 'العنوان',
            label_en: 'Title',
            type: 'text',
            required: false,
            order: 0,
            section_id: imageChatsBaseId,
            width: 'full',
            show_in_table: true,
          },
          {
            id: imageChatsStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: imageChatsBaseId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'خامل',       label_en: 'Idle',       value: 'idle',       color: '#9ca3af' },
              { id: uuid(), label_ar: 'قيد التوليد', label_en: 'Generating', value: 'generating', color: '#3b82f6' },
              { id: uuid(), label_ar: 'فشل',         label_en: 'Failed',     value: 'failed',     color: '#ef4444' },
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
            section_id: imageChatsBaseId,
            width: 'third',
            show_in_table: true,
          },
          {
            id: imageChatsLastMessageFieldId,
            name: 'last_message_at',
            label_ar: 'آخر رسالة',
            label_en: 'Last message',
            type: 'datetime',
            required: false,
            order: 3,
            section_id: imageChatsBaseId,
            width: 'third',
            show_in_table: true,
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
};

// ============================================================
// DATA MIGRATION (2026-06-01) — AI-assisted import wizard.
// Custom-UI system model (like decks / ai_chats): each record is one
// migration session. The wizard reads/writes freeform JSON off
// `record.data` (raw_table, mappings, standardization, result, phase) —
// only title/status/step need to be real schema fields. The generic
// record form never renders for this model (App.tsx dispatches to
// DataMigrationPage). Never frozen, never a migration target itself.
// ============================================================
export const dataMigrationId = 'd1aa4823-e020-494d-9ec1-ae9dc6caf426';
const dmBaseSectionId = uuid();
const dmTitleFieldId = uuid();
const dmStatusFieldId = uuid();
const dmTargetModelFieldId = uuid();
const dmStepFieldId = uuid();
const dmErrorFieldId = uuid();

const dataMigrationModel: AppModel = {
  id: dataMigrationId,
  name: 'data_migration',
  label_ar: 'ترحيل البيانات',
  label_en: 'Data Migration',
  icon: 'import',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: dmTitleFieldId,
    badge_field_id: dmStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: dmBaseSectionId,
        label_ar: 'الترحيل',
        label_en: 'Migration',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: dmTitleFieldId,
            name: 'title',
            label_ar: 'العنوان',
            label_en: 'Title',
            type: 'text',
            required: false,
            order: 0,
            section_id: dmBaseSectionId,
            width: 'full',
            show_in_table: true,
          },
          {
            // Coarse list-pill state. The fine-grained wizard position lives
            // in the separate `step` field — see DataMigration/lib/types.ts.
            id: dmStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: false,
            order: 1,
            section_id: dmBaseSectionId,
            width: 'third',
            show_in_table: true,
            options: [
              { id: uuid(), label_ar: 'مسودة', label_en: 'Draft', value: 'draft', color: '#9ca3af' },
              { id: uuid(), label_ar: 'جارٍ الاستخراج', label_en: 'Extracting', value: 'extracting', color: '#3b82f6' },
              { id: uuid(), label_ar: 'جارٍ الترحيل', label_en: 'Migrating', value: 'migrating', color: '#3b82f6' },
              { id: uuid(), label_ar: 'تم', label_en: 'Done', value: 'done', color: '#22c55e' },
              { id: uuid(), label_ar: 'فشل', label_en: 'Failed', value: 'failed', color: '#ef4444' },
            ],
          },
          {
            id: dmTargetModelFieldId,
            name: 'target_model_id',
            label_ar: 'النموذج الهدف',
            label_en: 'Target model',
            type: 'text',
            required: false,
            order: 2,
            section_id: dmBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: dmStepFieldId,
            name: 'step',
            label_ar: 'الخطوة',
            label_en: 'Step',
            type: 'text',
            required: false,
            order: 3,
            section_id: dmBaseSectionId,
            width: 'third',
            show_in_table: false,
          },
          {
            id: dmErrorFieldId,
            name: 'error_message',
            label_ar: 'رسالة الخطأ',
            label_en: 'Error message',
            type: 'textarea',
            required: false,
            order: 4,
            section_id: dmBaseSectionId,
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
// CLIENT PROPERTY OPTIONS MODEL (added 2026-06-30)
// ============================================================
// Unified, client-level store of the property OPTIONS found for a client —
// projects, units, and market listings in ONE place. This is the OUTPUT of the
// matching work (Project Finder), not the client's preference INPUTS (budget,
// location, etc. stay on clients.Preferences). Each option carries its own
// client-specific status, main-focus flag, match score, and notes so the sales
// team can see every suitable option, its status, the main focus, and why some
// were eliminated — without re-running the finder every time.
//
// Uniqueness (client_id + source_type + source_id) is enforced at SAVE time in
// src/lib/matching/clientOptions.ts (read-check-merge), which is required anyway
// for the "update don't duplicate / don't silently reactivate eliminated" rules.
// Display facts (price/area/beds/etc.) are snapshotted onto data.facts at save
// time so the Client Options view renders without re-resolving 46k listings.
const clientOptionsId = 'e00d8df8-905c-4fb7-a117-3aefa6fd5603';
const cpoBaseSectionId = uuid();
const cpoClientFieldId = uuid();
const cpoSourceNameFieldId = uuid();
const cpoStatusFieldId = uuid();

const CPO_SOURCE_TYPE_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'مشروع', label_en: 'Project', value: 'project', color: '#B8734F' },
  { id: uuid(), label_ar: 'وحدة', label_en: 'Unit', value: 'unit', color: '#8E4E3A' },
  { id: uuid(), label_ar: 'إعلان سوق', label_en: 'Market Listing', value: 'market_listing', color: '#4A2C2A' },
];

const CPO_STATUS_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'مناسبة', label_en: 'Suitable', value: 'suitable', color: '#C09B5F' },
  { id: uuid(), label_ar: 'التركيز الرئيسي', label_en: 'Main Focus', value: 'main_focus', color: '#B8734F' },
  { id: uuid(), label_ar: 'تم العرض', label_en: 'Presented', value: 'presented', color: '#3B82F6' },
  { id: uuid(), label_ar: 'مهتم', label_en: 'Interested', value: 'interested', color: '#16A34A' },
  { id: uuid(), label_ar: 'غير مهتم', label_en: 'Not Interested', value: 'not_interested', color: '#6B7280' },
  { id: uuid(), label_ar: 'مستبعدة', label_en: 'Eliminated', value: 'eliminated', color: '#DC2626' },
  { id: uuid(), label_ar: 'محجوزة', label_en: 'Reserved', value: 'reserved', color: '#D97706' },
  { id: uuid(), label_ar: 'مغلقة', label_en: 'Closed', value: 'closed', color: '#4A2C2A' },
];

const CPO_ADDED_FROM_OPTIONS: FieldOption[] = [
  { id: uuid(), label_ar: 'الباحث عن المشاريع', label_en: 'Project Finder', value: 'project_finder', color: '#B8734F' },
  { id: uuid(), label_ar: 'يدوي', label_en: 'Manual', value: 'manual', color: '#6B7280' },
  { id: uuid(), label_ar: 'متابعة', label_en: 'Follow-up', value: 'follow_up', color: '#3B82F6' },
];

const clientPropertyOptionsModel: AppModel = {
  id: clientOptionsId,
  name: 'client_property_options',
  label_ar: 'خيارات العميل العقارية',
  label_en: 'Client Property Options',
  icon: 'list-checks',
  color: '#B8734F',
  group_id: null,
  is_system: true,
  created_at: now(),
  updated_at: now(),
  card_config: {
    title_field_id: cpoSourceNameFieldId,
    subtitle_field_id: null,
    badge_field_id: cpoStatusFieldId,
    shown_field_ids: [],
  },
  maps_config: { ...MAPS_CONFIG_DEFAULT },
  schema: {
    sections: [
      {
        id: cpoBaseSectionId,
        label_ar: 'الخيار',
        label_en: 'Option',
        order: 0,
        is_base: true,
        color: '#B8734F',
        fields: [
          {
            id: cpoClientFieldId,
            name: 'client_id',
            label_ar: 'العميل',
            label_en: 'Client',
            type: 'lookup',
            required: true,
            order: 0,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: true,
            lookup_model_id: clientsId,
            lookup_display_field: 'client_name',
          },
          {
            id: cpoSourceNameFieldId,
            name: 'source_name',
            label_ar: 'الاسم',
            label_en: 'Name',
            type: 'text',
            required: false,
            order: 1,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'source_type',
            label_ar: 'نوع المصدر',
            label_en: 'Source Type',
            type: 'dropdown',
            required: true,
            order: 2,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: CPO_SOURCE_TYPE_OPTIONS,
          },
          {
            id: uuid(),
            name: 'source_id',
            label_ar: 'معرّف المصدر',
            label_en: 'Source ID',
            type: 'text',
            required: true,
            order: 3,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: cpoStatusFieldId,
            name: 'status',
            label_ar: 'الحالة',
            label_en: 'Status',
            type: 'dropdown',
            required: true,
            order: 4,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: true,
            options: CPO_STATUS_OPTIONS,
          },
          {
            id: uuid(),
            name: 'is_main',
            label_ar: 'الخيار الرئيسي',
            label_en: 'Main Option',
            type: 'checkbox',
            required: false,
            order: 5,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'match_score',
            label_ar: 'نقاط التطابق',
            label_en: 'Match Score',
            type: 'number',
            required: false,
            order: 6,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: true,
          },
          {
            id: uuid(),
            name: 'priority_rank',
            label_ar: 'ترتيب الأولوية',
            label_en: 'Priority Rank',
            type: 'number',
            required: false,
            order: 7,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'match_run_id',
            label_ar: 'معرّف جولة المطابقة',
            label_en: 'Match Run ID',
            type: 'text',
            required: false,
            order: 8,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'added_from',
            label_ar: 'أُضيف من',
            label_en: 'Added From',
            type: 'dropdown',
            required: false,
            order: 9,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: false,
            options: CPO_ADDED_FROM_OPTIONS,
          },
          {
            id: uuid(),
            name: 'added_by',
            label_ar: 'أُضيف بواسطة',
            label_en: 'Added By',
            type: 'assignee',
            required: false,
            order: 10,
            section_id: cpoBaseSectionId,
            width: 'half',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'sales_notes',
            label_ar: 'ملاحظات المبيعات',
            label_en: 'Sales Notes',
            type: 'textarea',
            required: false,
            order: 11,
            section_id: cpoBaseSectionId,
            width: 'full',
            show_in_table: false,
          },
          {
            id: uuid(),
            name: 'elimination_notes',
            label_ar: 'ملاحظات الاستبعاد',
            label_en: 'Elimination Notes',
            type: 'textarea',
            required: false,
            order: 12,
            section_id: cpoBaseSectionId,
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
  clientPropertyOptionsModel,
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
  copywriterChatsModel,
  matchingChatsModel,
  reelScriptsModel,
  decksModel,
  dataMigrationModel,
  phoneCallsModel,
  // Designs group: Templates Library + Marketing Operations + Competitors
  // reference (template-driven design generator, 2026-05-09 rebuild).
  competitorsModel,
  designTemplatesModel,
  marketingOperationsModel,
  // Image Chats (2026-05-23): "mini Higgsfield" — fal.ai Nano Banana 2 chat UI.
  imagePresetsModel,
  promptSnippetsModel,
  imageChatsModel,
  // Website (2026-05-09): backs the public marketing site at /, /projects, /map.
  siteSettingsModel,
];
