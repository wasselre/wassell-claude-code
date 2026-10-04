/**
 * The FREE keyword gate in front of the chat auto-read. PURE.
 *
 * Live traffic (measured 2026-09-27): ~46 customer WhatsApp messages a day, a
 * median message of 20 characters — most of them «تمام», «👍», «السلام
 * عليكم». Reading a whole conversation with two LLM agents because the
 * customer said "ok" is waste, so a batch of unread customer messages is read
 * only when at least one message MIGHT carry a preference. The gate is
 * deliberately PERMISSIVE — a false pass costs one reading; a false skip loses
 * what the customer said until the next message — so a message passes on ANY
 * of:
 *   • a digit (Latin, Arabic-Indic or Persian) — prices, areas, room counts;
 *   • a stem from GATE_STEMS (unit types, money, area/rooms, purpose,
 *     amenities, geography, intent, and their English equivalents);
 *   • normalised length ≥ LONG_MESSAGE_CHARS — free text long enough to say
 *     something we did not think of.
 * A message made only of pleasantries (PURE_NOISE, repeated or combined) or
 * only of emoji/punctuation never passes — even a long greeting.
 */

export type GateReason = 'keyword' | 'digits' | 'long' | 'none';

export interface GateResult {
  pass: boolean;
  reason: GateReason;
}

export const LONG_MESSAGE_CHARS = 25;

/** Normalise Arabic/English text for matching: letters/digits only, folded, single-spaced. */
export function normalizeGateText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')   // harakat / superscript alef
    .replace(/ـ/g, '')                  // tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')       // punctuation, emoji, symbols
    .replace(/(.)\1{2,}/gu, '$1')            // «تماااام» → «تمام», «okkk» → «ok»
    .replace(/\s+/g, ' ')
    .trim();
}

const RAW_STEMS: readonly string[] = [
  // unit types
  'فيلا', 'فله', 'فلل', 'شقه', 'شقق', 'دور', 'دبلكس', 'تاون', 'استوديو', 'ملحق', 'ارض', 'عماره', 'بيت', 'روف', 'شاليه',
  // money
  'مليون', 'الف', 'ريال', 'ميزانيه', 'سعر', 'اسعار', 'قسط', 'اقساط', 'تمويل', 'بنك', 'كاش', 'دفعه', 'نقد', 'حدود',
  // area / rooms
  'متر', 'مساحه', 'غرف', 'غرفه', 'نوم', 'صاله', 'مجلس', 'ادوار',
  // objective
  'سكن', 'استثمار', 'اجار', 'ايجار', 'تاجير', 'عائله', 'زواج',
  // amenities
  'مسبح', 'حوش', 'سطح', 'خادمه', 'سائق', 'مصعد', 'قبو', 'حديقه', 'مواقف',
  // geography
  'حي', 'شمال', 'جنوب', 'شرق', 'غرب', 'طريق', 'قريب', 'بعيد', 'منطقه', 'الرياض', 'جده', 'الدمام', 'الخبر', 'مكه',
  'المدينه', 'مخطط', 'موقع', 'مكان', 'جنب', 'قرب',
  // intent
  'ابي', 'ابغى', 'ودي', 'احتاج', 'ابحث', 'ادور', 'افضل', 'يناسب', 'مناسب', 'شرط', 'لازم', 'ضروري', 'جاهز', 'عظم',
  'تشطيب', 'الخارطه', 'كبير', 'صغير', 'واسع', 'جديد',
  // English
  'villa', 'apartment', 'flat', 'duplex', 'townhouse', 'studio', 'budget', 'price', 'million', 'sar', 'sqm', 'm2',
  'meter', 'bedroom', 'room', 'invest', 'rent', 'family', 'pool', 'north', 'south', 'east', 'west', 'district',
  'area', 'near', 'want', 'need', 'looking', 'prefer', 'ready',
];

/** Normalised stems. «كم» is deliberately absent: it matches «عليكم». */
export const GATE_STEMS: readonly string[] = Array.from(new Set(RAW_STEMS.map(normalizeGateText).filter(Boolean)));

/** A stem this short must match a whole word (after a proclitic), never a prefix: «حي» ≠ «حياك» / «صحيح». */
const EXACT_ONLY_MAX_LEN = 2;

const RAW_NOISE: readonly string[] = [
  'ok', 'okay', 'k', 'تمام', 'طيب', 'اوك', 'اوكي', 'حسنا', 'ماشي', 'ان شاء الله', 'انشالله', 'شكرا', 'مشكور',
  'يعطيك العافيه', 'الله يعافيك', 'السلام عليكم', 'وعليكم السلام', 'هلا', 'اهلا', 'مرحبا', 'صباح الخير', 'مساء الخير',
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'yes', 'no', 'نعم', 'لا', 'ايه', 'اي',
  // Same family, added so a long greeting is not read as "long free text".
  'ورحمه الله وبركاته', 'ورحمه الله', 'وبركاته', 'مشكورين', 'جزاك الله خير', 'الله يسعدك', 'تسلم', 'ابشر',
  'good morning', 'good evening',
];

/** Normalised noise phrases, longest first (greedy whole-message cover). */
export const PURE_NOISE: readonly string[] = Array.from(new Set(RAW_NOISE.map(normalizeGateText).filter(Boolean)))
  .sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length);

const NOISE_TOKENS: readonly string[][] = PURE_NOISE.map((p) => p.split(' '));

/** Arabic proclitics a stem may carry: «بحي», «والفلل», «للسكن». */
const PROCLITICS = ['وال', 'فال', 'بال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك'];

function tokenForms(token: string): string[] {
  const forms = [token];
  for (const p of PROCLITICS) {
    if (token.startsWith(p) && token.length - p.length >= 2) forms.push(token.slice(p.length));
  }
  return forms;
}

function hasStem(normalized: string): boolean {
  for (const token of normalized.split(' ')) {
    if (!token) continue;
    for (const form of tokenForms(token)) {
      for (const stem of GATE_STEMS) {
        if (stem.includes(' ')) continue;
        if (stem.length <= EXACT_ONLY_MAX_LEN ? form === stem : form.startsWith(stem)) return true;
      }
    }
  }
  return false;
}

/** True when the normalised message is empty or covered entirely by noise phrases. */
export function isPureNoise(normalized: string): boolean {
  if (!normalized) return true;
  const tokens = normalized.split(' ');
  let i = 0;
  outer: while (i < tokens.length) {
    for (const phrase of NOISE_TOKENS) {
      if (phrase.every((w, k) => tokens[i + k] === w)) {
        i += phrase.length;
        continue outer;
      }
    }
    return false;
  }
  return true;
}

const DIGIT_RE = /[0-9٠-٩۰-۹]/;

/**
 * The prefilled click-to-WhatsApp ad reply «مهتم بمشروع يمام 17» — the ad
 * already tells us the project, and the line says nothing about budget, type
 * or place. Measured 2026-09-27: 9 of the 16 chats due for a first read held
 * ONLY this line, and the project number made it pass as "digits".
 *
 * The ad's SECOND button «مهتم بمشاريع سكنية اخرى في شمال الرياض» (68 inbound
 * as of 2026-10-04; north / east / centre) is the same thing: the customer
 * tapped it, the region is the AD's targeting, not a stated preference. Read as
 * one it put "north Riyadh" on the places card and into the preference
 * suggestions of customers who never said it (card audit 2026-10-04). The
 * sales agent still sees it (isOtherProjectsAsk) — only the preference and
 * places readers drop it (gatherChatConversation).
 */
const AD_REPLY_RE = /^مهتم بمشروع(?: [^ ]+){1,4}$/;
const AD_OTHER_PROJECTS_RE = /^مهتم بمشاريع سكنيه اخري في (?:شمال|شرق|غرب|جنوب|وسط) الرياض$/;

/** Is this message one of the ad's prefilled opener buttons (not the customer's own words)? */
export function isAdOpenerTemplate(body: string): boolean {
  const normalized = normalizeGateText(body);
  return AD_REPLY_RE.test(normalized) || AD_OTHER_PROJECTS_RE.test(normalized);
}

/** One message's verdict. */
export function gateMessage(body: string): GateResult {
  const normalized = normalizeGateText(body);
  if (isPureNoise(normalized)) return { pass: false, reason: 'none' };
  if (AD_REPLY_RE.test(normalized) || AD_OTHER_PROJECTS_RE.test(normalized)) return { pass: false, reason: 'none' };
  if (DIGIT_RE.test(body)) return { pass: true, reason: 'digits' };
  if (hasStem(normalized)) return { pass: true, reason: 'keyword' };
  if (normalized.length >= LONG_MESSAGE_CHARS) return { pass: true, reason: 'long' };
  return { pass: false, reason: 'none' };
}

/** A batch passes when ANY message passes; the reason is the first passing message's. */
export function passesKeywordGate(bodies: readonly (string | null | undefined)[]): GateResult {
  for (const b of bodies) {
    if (typeof b !== 'string' || b.trim() === '') continue;
    const r = gateMessage(b);
    if (r.pass) return r;
  }
  return { pass: false, reason: 'none' };
}
