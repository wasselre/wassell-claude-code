/**
 * Unit FEATURES the customer asks for («فيها غرفة خادمة», «ابي روف», «مطبخ
 * راكب») → the values stored in a unit's `unit_components` multiselect.
 *
 * Stored values mix plain words («غرفة خادمة») and hyphenated slugs
 * («مطبخ-مجهز-مسبقا», «غرفة-نوم-رييسية»), so everything is compared on a
 * folded form. A word that maps to no stored component is returned as
 * UNKNOWN: the data does not record it, and only the floor plan can answer
 * (check_unit_plans) — never treated as present or absent.
 */

/** Fold a component value or a customer word: hyphens, hamza/ya/ta-marbuta. */
export function normFeature(s: string): string {
  return String(s ?? '')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/-/g, ' ')
    .replace(/[أإآ]/g, 'ا').replace(/[ئى]/g, 'ي').replace(/ؤ/g, 'و').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Canonical component (folded) → the words customers use for it. */
const SYNONYMS: Array<[string, string[]]> = [
  ['غرفه خادمه', ['خادمه', 'شغاله', 'عامله', 'غرفه عامله', 'غرفه شغاله', 'maid']],
  ['غرفه سايق', ['سايق', 'سائق', 'غرفه سواق', 'driver']],
  ['سطح', ['روف', 'سطح خاص', 'روف خاص', 'رووف', 'roof', 'rooftop']],
  ['مصعد', ['اصنصير', 'اسانسير', 'مصعد داخلي', 'elevator', 'lift']],
  ['مدخل خاص', ['مدخل مستقل', 'باب مستقل', 'مدخل منفصل', 'private entrance']],
  ['مدخل جانبي', ['باب جانبي', 'side entrance']],
  ['مطبخ مجهز مسبقا', ['مطبخ راكب', 'مطبخ مجهز', 'مطبخ جاهز', 'fitted kitchen']],
  ['تكييف مخفي مجهز مسبقا', ['تكييف مخفي', 'مكيفات مخفيه', 'مكيف مخفي', 'سبليت مخفي', 'دكت', 'concealed ac']],
  ['حديقه', ['حديقه خاصه', 'جنينه', 'garden']],
  ['فناء خارجي', ['حوش', 'فناء', 'ساحه خارجيه', 'yard']],
  ['غرفه غسيل', ['غسيل', 'مغسله ملابس', 'laundry']],
  ['مستودع', ['مخزن', 'غرفه تخزين', 'storage']],
  ['بلكونه', ['شرفه', 'بلكون', 'balcony']],
  ['تراس', ['terrace']],
  ['مجلس', ['مجلس رجال', 'majlis']],
  ['ملابس', ['غرفه ملابس', 'دريسنج', 'walk in closet']],
  ['حمام ضيوف', ['دوره مياه ضيوف', 'guest bathroom']],
  ['حمام غرفه النوم الرييسيه', ['حمام ماستر', 'ماستر بحمام', 'en suite']],
  ['غرفه نوم رييسيه', ['ماستر', 'غرفه ماستر', 'master bedroom']],
  ['بيت ذكي', ['سمارت هوم', 'smart home']],
  ['موثثه', ['مفروشه', 'مؤثثه', 'furnished']],
  ['مكنسه مركزيه', ['central vacuum']],
  ['سيب خاص', ['سيب']],
  ['فتحه سماويه', ['سكاي لايت', 'skylight']],
  ['صاله طعام', ['غرفه طعام', 'مقلط', 'dining']],
  ['صاله جلوس', ['صاله', 'معيشه', 'living']],
  ['غرفه خدمات', ['خدمات']],
  ['مطبخ', ['kitchen']],
];

const CANON = new Map<string, string>();
for (const [canon, words] of SYNONYMS) {
  CANON.set(canon, canon);
  for (const w of words) CANON.set(normFeature(w), canon);
}

/** One customer word → its stored component, or null when we don't record it. */
export function resolveFeature(word: string): string | null {
  const w = normFeature(word).replace(/^(فيها|فيه|مع|معها|معه|ب|بـ)\s+/, '').replace(/^ال/, '');
  if (!w) return null;
  return CANON.get(w) ?? CANON.get(`ال${w}`) ?? CANON.get(normFeature(word)) ?? null;
}

export function resolveFeatures(words: string[] | undefined): { known: string[]; unknown: string[] } {
  const known = new Set<string>();
  const unknown: string[] = [];
  for (const w of words ?? []) {
    if (typeof w !== 'string' || !w.trim()) continue;
    const c = resolveFeature(w);
    if (c) known.add(c); else unknown.push(w.trim());
  }
  return { known: [...known], unknown };
}

/** A unit's stored components, folded. */
export function componentsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(normFeature) : [];
}
