/**
 * The client's gender from the NAME on their record, for the WhatsApp agent and
 * the follow-up writer. PURE.
 *
 * Both writers used to judge gender only from the customer's own messages and
 * fell back to masculine, so a client named نوره got «أبشر… تقدر تزيد» from the
 * agent and «لازلتي» from the follow-up writer in the same chat, and about 59
 * follow-ups went out masculine to clearly female names (review 2026-10-07).
 *
 * Returns null when the name does not say — then the writers keep their old
 * rule (the customer's own messages, else masculine). Never guesses from a
 * name it does not know.
 */

const fold = (s: string): string => s
  .replace(/[ًٌٍَُِّْـ]/g, '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .trim();

/** Female first names written without a closing ة/ه. Folded. */
const FEMALE = new Set(([
  'هيا', 'منى', 'منا', 'نجاة', 'نجات', 'اسماء', 'تغريد', 'حنان', 'ريم', 'لمى', 'لمي', 'رهف', 'شهد', 'جود', 'غدير', 'عبير', 'نوف',
  'امل', 'مريم', 'زينب', 'هند', 'دعاء', 'رغد', 'وعد', 'ملاك', 'اريج', 'ليلي', 'سلمي', 'رنا', 'لينا', 'دينا', 'ندي', 'هدي', 'نهي',
  'مها', 'سهي', 'روان', 'جني', 'لجين', 'ثريا', 'بشري', 'سلوي', 'نجلاء', 'شيماء', 'هيفاء', 'عفاف', 'سعاد', 'منال', 'ايمان', 'ابتسام',
  'وجدان', 'اشواق', 'بدور', 'العنود', 'عنود', 'نوال', 'خلود', 'موضي', 'البندري', 'الهنوف', 'هنوف', 'مشاعل', 'نجود', 'ميرفت', 'سوزان',
  'جيهان', 'نسرين', 'شيرين', 'ياسمين', 'افنان', 'وفاء', 'رجاء', 'صفاء', 'هناء', 'ضحي', 'اروي', 'ريهام', 'ريناد', 'ديما', 'لما',
  'تالا', 'جوري', 'جمانه', 'حلا', 'غلا', 'لولو', 'نوران', 'سجي', 'الاء', 'اسيل', 'بيان', 'سديم', 'وئام', 'هالة', 'ساره', 'نوره',
  'ساره', 'سارا', 'نورا', 'هاله', 'موزه', 'عائشه', 'فاطمه', 'حصه', 'نوال', 'منيره', 'لطيفه', 'الجوهره', 'لولوه', 'طرفه',
  'ميرا', 'حنين', 'نادين', 'لالا', 'رزان', 'علا', 'ريما', 'دانه', 'دانا', 'رنيم', 'سلوى', 'نجوى', 'رحاب', 'ابرار', 'غيداء', 'لينه',
]).map(fold));

/** Male first names that END in ة/ه — the exceptions to "ends in ة ⇒ female". Folded. */
const MALE_TA = new Set(([
  'حمزه', 'حمزة', 'اسامه', 'اسامة', 'طلحه', 'طلحة', 'عبيده', 'عبيدة', 'معاويه', 'معاوية', 'عكرمه', 'عكرمة', 'عروه', 'عروة',
  'حذيفه', 'حذيفة', 'قتيبه', 'قتيبة', 'ربيعه', 'ربيعة', 'خليفه', 'خليفة', 'عطيه', 'عطية', 'عقبه', 'عقبة', 'جبله', 'سلامه', 'سلامة',
  'عبدالله', 'عبدلله', 'طه', 'وجيه', 'نبيه', 'فقيه', 'زكريا', 'يحيي', 'موسي', 'عيسي', 'مصطفي', 'مرتضي', 'رضا', 'علاء', 'بهاء',
  'ضياء', 'ثامره', 'معمره', 'شيبه', 'شيبة', 'عباده', 'عبادة', 'مسلمه', 'جنادة',
]).map(fold));

const FEMALE_EN = new Set([
  'sara', 'sarah', 'noura', 'nora', 'norah', 'mona', 'huda', 'fatima', 'fatimah', 'aisha', 'ayesha', 'maryam', 'mariam', 'reem', 'rana',
  'lina', 'dina', 'nada', 'hind', 'haya', 'hanan', 'asma', 'sabeena', 'sabina', 'amal', 'layla', 'leila', 'laila', 'salma', 'samar', 'nouf',
  'rawan', 'maha', 'manal', 'iman', 'eman', 'heba', 'hiba', 'yasmin', 'yasmine', 'jana', 'lama', 'ghada', 'shahad', 'abeer', 'lujain',
  'mrs', 'ms', 'miss', 'madam',
  'lala', 'lolo', 'loulou', 'haneen', 'nadeen', 'nadine', 'habiba', 'salwa', 'mira', 'meera', 'ola', 'ula', 'razan', 'razane', 'khadija',
  'khadejah', 'khadijah', 'ghalia', 'thurya', 'najat', 'mervat', 'taghreed', 'reema', 'rima', 'dana', 'shatha', 'wafa', 'nawal', 'arwa',
]);

/** 'f' | 'm' from the record's name, or null when the name does not tell. */
export function genderFromName(name: string | null | undefined): 'f' | 'm' | null {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  // «أم فيصل» / «ام عبدالعزيز» — a mother's kunya; «أبو يوسف» a father's.
  if (/^(ام|أم|إم)\s+\S/.test(raw)) return 'f';
  if (/^(ابو|أبو|ابن|بو)\s+\S/.test(raw)) return 'm';
  const tokens = raw.split(/\s+/).filter(Boolean);
  // Skip honorifics and our own labels before the first name.
  const skip = /^(د|د\.|دكتور|دكتوره|المهندس|المهندسه|مهندس|مهندسه|الاستاذ|الاستاذه|استاذ|استاذه|الشيخ|الشيخه|mr\.?|dr\.?|eng\.?)$/i;
  let first = tokens.find((t) => !skip.test(fold(t))) ?? tokens[0]!;
  const lower = first.toLowerCase().replace(/[^a-z]/g, '');
  if (/^(دكتوره|المهندسه|مهندسه|الاستاذه|استاذه|الشيخه)$/.test(fold(tokens[0]!))) return 'f';
  if (lower) {
    if (FEMALE_EN.has(lower) || FEMALE_EN.has(tokens[0]!.toLowerCase().replace(/[^a-z]/g, ''))) return 'f';
    return null; // a Latin name we don't know — don't guess
  }
  first = fold(first);
  if (FEMALE.has(first)) return 'f';
  if (MALE_TA.has(first)) return 'm';
  // A compound like «عبد الرحمن» starts with عبد → male.
  if (/^عبد/.test(first)) return 'm';
  if (/ة$/.test(first)) return 'f';
  return null;
}
