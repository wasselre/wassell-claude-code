/**
 * PROJECT amenities the customer asks for («فيه مسبح؟», «ابي جيم», «ملعب
 * أطفال») → the values stored in the project's `preferred_amenities`
 * multiselect (all_projects, label «المرافق»).
 *
 * Unit features (features.ts) are things INSIDE a unit — a maid room, a roof.
 * Amenities belong to the whole project — a pool, a gym, a mosque. A word is a
 * unit feature first (features.ts decides), and only the words it does not know
 * come here. Live 2026-10-07: «شقة 3 غرف فيها مسبح وجيم» was searched as a unit
 * feature, matched nothing, and the agent asked the rep which projects have a
 * pool and a gym — while 82 of our 95 projects list their amenities.
 *
 * Stored values mix English slugs («swimming_pool», «sports_club», «gym») and
 * Arabic slugs («ممرات-رياضية»); several mean the same thing to a customer
 * (sports_club / gym / نادي رياضي), so each ask is a GROUP: the project has it
 * when it lists ANY value of the group.
 *
 * A project with NO amenities recorded is UNKNOWN for every ask — never shown
 * as having or lacking one.
 */
import { normFeature } from './features.js';

interface Group {
  /** The customer-facing Arabic name. */
  label: string;
  /** Stored values (folded) that satisfy the ask. */
  values: string[];
  /** Words customers use for it (folded at load). */
  words: string[];
}

const GROUPS: Group[] = [
  { label: 'مسبح', values: ['swimming_pool', 'مسبح', 'pool'], words: ['مسبح', 'مسابح', 'بركه', 'بركه سباحه', 'حمام سباحه', 'مسبح مشترك', 'pool', 'swimming pool'] },
  { label: 'نادي رياضي', values: ['sports_club', 'gym', 'نادي رياضي', 'جيم'], words: ['جيم', 'نادي', 'نادي رياضي', 'ناديه', 'صاله رياضيه', 'صاله العاب رياضيه', 'رياضه', 'gym', 'fitness', 'sports club'] },
  { label: 'منطقة ألعاب أطفال', values: ['children_play_area', 'ملعب اطفال', 'منطقه العاب اطفال'], words: ['العاب اطفال', 'ملعب اطفال', 'منطقه اطفال', 'منطقه العاب', 'ملاهي اطفال', 'playground', 'kids area'] },
  { label: 'مساحات خضراء', values: ['green_spaces', 'garden', 'مساحات خضراء', 'حديقه'], words: ['مساحات خضراء', 'خضره', 'حدائق', 'حديقه مشتركه', 'green spaces', 'park'] },
  { label: 'مسجد', values: ['mosque', 'prayer_room', 'مسجد', 'مصلي'], words: ['مسجد', 'جامع', 'مصلي', 'مصلى', 'mosque', 'prayer room'] },
  { label: 'ممرات مشي', values: ['ممرات رياضيه', 'running_track'], words: ['ممشي', 'ممشى', 'ممرات مشي', 'ممرات رياضيه', 'مسار جري', 'مضمار', 'jogging', 'running track', 'walking track'] },
  { label: 'جاكوزي', values: ['jacuzzi', 'جاكوزي'], words: ['جاكوزي', 'jacuzzi'] },
  { label: 'ساونا', values: ['sauna', 'ساونا'], words: ['ساونا', 'sauna'] },
  { label: 'غرفة بخار', values: ['steam_room', 'غرفه بخار'], words: ['غرفه بخار', 'بخار', 'steam room'] },
  { label: 'سبا', values: ['spa', 'سبا'], words: ['سبا', 'spa'] },
  { label: 'ملعب بادل', values: ['padel_court', 'ملعب بادل'], words: ['بادل', 'ملعب بادل', 'padel'] },
  { label: 'ملعب تنس', values: ['tennis_court', 'ملعب تنس'], words: ['تنس', 'ملعب تنس', 'tennis'] },
  { label: 'ملعب كرة سلة', values: ['basketball_court', 'ملعب كره سله'], words: ['سله', 'كره سله', 'ملعب سله', 'basketball'] },
  { label: 'ملعب كرة قدم', values: ['football_pitch', 'ملعب كره قدم'], words: ['ملعب كوره', 'ملعب كره', 'كره قدم', 'ملعب كره قدم', 'football'] },
  { label: 'ملعب كرة طائرة', values: ['volleyball_court', 'ملعب كره طايره'], words: ['كره طايره', 'طايره', 'volleyball'] },
  { label: 'ملعب اسكواش', values: ['ملعب اسكواش', 'squash_court'], words: ['اسكواش', 'squash'] },
  { label: 'ملاعب غولف', values: ['golf', 'ملاعب غولف'], words: ['غولف', 'قولف', 'golf'] },
  { label: 'مواقف قبو', values: ['basement_parking', 'مواقف قبو'], words: ['مواقف قبو', 'قبو', 'باركنج قبو', 'basement parking'] },
  { label: 'مواقف', values: ['basement_parking', 'مواقف قبو', 'مواقف خارجيه', 'مواقف خارجيه مظلله', 'مواقف سيارات ذكيه وامنه'], words: ['مواقف', 'موقف', 'باركنج', 'مواقف سيارات', 'parking'] },
  { label: 'مواقف مظللة', values: ['مواقف خارجيه مظلله'], words: ['مواقف مظلله', 'مظلات', 'covered parking'] },
  { label: 'شواحن سيارات كهربائية', values: ['شواحن سيارات كهربايية', 'شواحن سيارات كهربائيه'], words: ['شاحن سياره', 'شواحن', 'شاحن كهربائي', 'ev charger'] },
  { label: 'نظام مراقبة أمنية', values: ['نظام مراقبه امنيه'], words: ['حراسه', 'حارس', 'امن', 'كاميرات', 'مراقبه', 'security'] },
  { label: 'نظام دخول ذكي', values: ['نظام دخول ذكي'], words: ['دخول ذكي', 'smart entry'] },
  { label: 'سينما', values: ['cinema', 'سينما'], words: ['سينما', 'cinema'] },
  { label: 'لاونج', values: ['lounge', 'لاونج'], words: ['لاونج', 'lounge'] },
  { label: 'كونسرج', values: ['كونسرج', 'concierge'], words: ['كونسرج', 'استقبال', 'concierge', 'reception'] },
  { label: 'بزنس سنتر', values: ['بزنس سنتر', 'business_center'], words: ['بزنس سنتر', 'مكاتب عمل', 'business center'] },
  { label: 'محلات تجارية', values: ['retail', 'mini_market', 'commercial_showrooms', 'مرافق تجاريه', 'ميني ماركت', 'معارض تجاريه', 'كافيه'], words: ['محلات', 'محلات تجاريه', 'سوبرماركت', 'بقاله', 'ميني ماركت', 'مرافق تجاريه', 'retail', 'shops'] },
  { label: 'كافيه', values: ['كافيه', 'cafe'], words: ['كافيه', 'كوفي', 'مقهي', 'cafe'] },
  { label: 'منطقة شواء', values: ['bbq_area', 'منطقه شواء'], words: ['شواء', 'شوي', 'باربكيو', 'bbq'] },
  { label: 'نادي اجتماعي', values: ['clubhouse'], words: ['كلوب هاوس', 'clubhouse'] },
  { label: 'جلسات خارجية', values: ['جلسات خارجيه'], words: ['جلسات خارجيه', 'جلسات', 'outdoor seating'] },
  { label: 'منطقة دراجات', values: ['منطقه دراجات'], words: ['دراجات', 'سيكل', 'bicycle'] },
  { label: 'غرفة بريد', values: ['غرفه بريد'], words: ['بريد', 'mail room'] },
  { label: 'مرافق تعليمية', values: ['مرافق تعليميه'], words: ['مدارس', 'مدرسه', 'حضانه', 'مرافق تعليميه', 'school'] },
  { label: 'مراكز ترفيهية', values: ['مراكز ترفيهيه'], words: ['ترفيه', 'مراكز ترفيهيه'] },
];

/** Folded word → group index. */
const WORD = new Map<string, number>();
GROUPS.forEach((g, i) => {
  for (const w of [...g.words, g.label]) {
    const k = normFeature(w);
    if (!WORD.has(k)) WORD.set(k, i);
  }
});

/** Stored value (folded) → a display label, for values listed by a group. */
const VALUE_LABEL = new Map<string, string>();
for (const g of GROUPS) for (const v of g.values) { const k = normFeature(v); if (!VALUE_LABEL.has(k)) VALUE_LABEL.set(k, g.label); }
// Values whose own name reads well but differs from the group label.
const OWN_LABEL: Record<string, string> = {
  garden: 'حديقة', mosque: 'مسجد', prayer_room: 'مصلى', mini_market: 'ميني ماركت', commercial_showrooms: 'معارض تجارية',
  retail: 'محلات تجارية', gym: 'نادي رياضي', sports_club: 'نادي رياضي', 'مصاعد': 'مصاعد', 'بلكونات': 'بلكونات', 'اسطح خاصه': 'أسطح خاصة',
  'مواقف خارجيه': 'مواقف خارجية', 'خزان مياه ارضي': 'خزان مياه أرضي', 'مضخات مياه': 'مضخات مياه', 'فراغات مرنه': 'فراغات مرنة',
  'مكنسه مركزيه': 'مكنسة مركزية', 'منطقه خدمه ذاتيه': 'منطقة خدمة ذاتية',
};

export interface AmenityAsk {
  /** What the customer said. */
  word: string;
  /** The Arabic name to say back. */
  label: string;
  /** Folded stored values that satisfy it. */
  values: string[];
}

/** One word → the amenity it asks for, or null when it is not a project amenity. */
export function resolveAmenity(word: string): AmenityAsk | null {
  const raw = normFeature(word).replace(/^(فيها|فيه|مع|معها|معه|ب|بـ)\s+/, '');
  for (const k of [raw, raw.replace(/^ال/, ''), raw.replace(/(^|\s)ال/g, '$1')]) {
    const i = WORD.get(k);
    if (i !== undefined) return { word: word.trim(), label: GROUPS[i]!.label, values: GROUPS[i]!.values.map(normFeature) };
  }
  return null;
}

/** Words features.ts did not know → project amenities + what is still unknown. */
export function splitAmenities(words: string[]): { asks: AmenityAsk[]; unknown: string[] } {
  const asks: AmenityAsk[] = [];
  const unknown: string[] = [];
  for (const w of words) {
    const a = resolveAmenity(w);
    if (!a) { unknown.push(w); continue; }
    if (!asks.some((x) => x.label === a.label)) asks.push(a);
  }
  return { asks, unknown };
}

/** A project's recorded amenities, folded. Empty = none recorded (unknown). */
export function amenitiesOf(d: Record<string, unknown>): string[] {
  const v = d.preferred_amenities;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(normFeature) : [];
}

/** Customer-facing names of a project's amenities (deduplicated). null = none recorded. */
export function amenityLabels(d: Record<string, unknown>): string[] | null {
  const have = amenitiesOf(d);
  if (!have.length) return null;
  const out = new Set<string>();
  for (const v of have) out.add(OWN_LABEL[v] ?? VALUE_LABEL.get(v) ?? v);
  return [...out];
}

/** Per ask: true = listed, false = the project lists amenities but not this, null = none recorded. */
export function amenityAnswers(d: Record<string, unknown>, asks: AmenityAsk[]): Record<string, boolean | null> {
  const have = amenitiesOf(d);
  const out: Record<string, boolean | null> = {};
  for (const a of asks) out[a.label] = have.length ? a.values.some((v) => have.includes(v)) : null;
  return out;
}

/** Has EVERY ask (a project with none recorded never passes). */
export function hasAmenities(d: Record<string, unknown>, asks: AmenityAsk[]): boolean {
  if (!asks.length) return true;
  const have = amenitiesOf(d);
  return asks.every((a) => a.values.some((v) => have.includes(v)));
}
