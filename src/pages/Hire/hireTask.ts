/**
 * Preset scenario for the practical task (stage 3, التجربة).
 *
 * "More projects preserved the deal": the customer enquires about a real project
 * that's OVER his budget; the candidate records his needs and وصل recommends two
 * genuinely suitable, in-budget alternatives. All numbers are the real verified
 * project data (see the all_projects rollups); images are re-hosted to the public
 * hire-assets bucket. Everything here is a preset simulation — no live matching,
 * no message, no records.
 */
const B = 'https://zhqqsxwealdwqzrbpwyv.supabase.co/storage/v1/object/public/hire-assets/projects/';

export const TASK_CLIENT = {
  name: 'أبو فيصل',
  phone: '0553 907 214',
  // What the candidate "listens" to (inbound WhatsApp).
  message:
    'السلام عليكم، شفت مشروع فلل رِفان وعجبني 👌 بس أبغى تفاصيل أكثر. أنا أدوّر فيلا عائلية شمال الرياض، ٤ أو ٥ غرف، وميزانيتي حدود ٢٫٢ مليون.',
};

// The project he enquired about — real, and above his budget.
export const TASK_ENQUIRED = {
  name: 'فلل رِفان',
  url: `${B}rifan.jpg`,
  type: 'فيلا',
  bedrooms: '٤ غرف',
  price: 'تبدأ من 2,770,000 ر.س',
  overBudgetNote: 'أعلى من ميزانية العميل',
};

// Preferences the candidate taps to record (from his message). No distractors.
export interface PrefChip { key: string; label: string; value: string }
export const TASK_PREF_CHIPS: PrefChip[] = [
  { key: 'city', label: 'المدينة', value: 'شمال الرياض' },
  { key: 'type', label: 'نوع الوحدة', value: 'فيلا' },
  { key: 'bedrooms', label: 'غرف النوم', value: '٤–٥ غرف' },
  { key: 'budget', label: 'الميزانية', value: 'حتى 2.2 مليون ر.س' },
];

// Two genuinely suitable, in-budget alternatives — real projects + real prices.
export interface TaskRec {
  id: string;
  name: string;
  url: string;
  type: string;
  bedrooms: string;
  price: string;
  reason: string;
  message: string; // the prepared, "fact-checked" WhatsApp text for this project
}
export const TASK_RECS: TaskRec[] = [
  {
    id: 'sadeem',
    name: 'سديم فلل',
    url: `${B}sadeem.jpg`,
    type: 'فيلا',
    bedrooms: '٥ غرف',
    price: '2,140,000 ر.س',
    reason: 'فيلا ٥ غرف بمساحة ٣٢٥ م² — ضمن ميزانية العميل تمامًا.',
    message:
      '🏡 مشروع سديم فلل — شمال الرياض\nفيلا عائلية ٥ غرف، مساحة ٣٢٥ م²، السعر 2,140,000 ر.س.\nيسعدنا ترتيب زيارة لك في أي وقت يناسبك 🌿',
  },
  {
    id: 'adeem',
    name: 'أديم الفرسان',
    url: `${B}adeem.jpg`,
    type: 'فيلا / تاون هاوس',
    bedrooms: '٤ غرف',
    price: '1,000,000 – 1,490,000 ر.س',
    reason: 'خيار أوفر: فلل وتاون هاوس ٤ غرف شمال الرياض، ضمن الميزانية.',
    message:
      '🏡 مشروع أديم الفرسان — شمال الرياض\nفلل وتاون هاوس ٤ غرف، الأسعار من 1,000,000 إلى 1,490,000 ر.س.\nيسعدنا ترتيب زيارة لك في أي وقت يناسبك 🌿',
  },
];

// Passive payoff shown on completion (auto-created follow-up + summary).
export const TASK_FOLLOWUP = {
  type: 'اتصال لتأكيد الاهتمام',
  scheduled: 'غدًا · 11:00 صباحًا',
};
export const TASK_SUMMARY = [
  'يريد فيلا عائلية شمال الرياض، ٤–٥ غرف، ميزانية حتى 2.2 مليون ر.س.',
  'فلل رِفان تجاوز ميزانيته؛ عُرض عليه بديل مناسب ضمن الميزانية.',
  'الخطوة التالية: تأكيد الاهتمام وترتيب موعد زيارة.',
];
