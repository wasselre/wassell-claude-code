/**
 * The reply GUARD — every message the brain writes passes here before a customer
 * sees it. Pure (no I/O), so it is unit-tested line by line.
 *
 * What it enforces is what the operator's voice rules (wassel-whatsapp-voice) and
 * the "never lie" posture need mechanically:
 *   · short: ≤ 420 characters, ≤ 4 lines — a WhatsApp line, not a brochure;
 *   · no lists, headings, bold, or links (the project card carries the link);
 *   · at most two questions;
 *   · no formal-Arabic tells the reps never use («يسعدنا», «نود», «يُرجى»…);
 *   · the customer's language;
 *   · EVERY NUMBER must be grounded — it appears in what the tools returned this
 *     turn or in the customer's own messages (price «مليون و219» is checked as its
 *     parts). A price the model "remembers" is exactly the lie this stops.
 * A failing reply gets one rewrite with the problems listed; a second failure
 * falls back to the fixed-sentence agent. Never loosen a rule to make a reply pass.
 */

export interface GuardVerdict { ok: boolean; problems: string[] }

const MAX_CHARS = 420;
const MAX_LINES = 4;
const MAX_QUESTIONS = 2;

const FUSHA_TELLS = ['يسعدنا', 'نود ', 'يُرجى', 'يرجى', 'بالإضافة إلى', 'حيث أن', 'نحيطكم', 'عزيزي العميل', 'عميلنا العزيز'];

const AR_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

function foldDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] ?? d);
}

/**
 * Numbers as a reader would read them: «1,050,000» / «1.050.000» / «1٬050٬000» are
 * one million fifty thousand; «2.8» / «2٫8» is two point eight.
 */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  const re = /[0-9٠-٩۰-۹]+(?:[.,٬٫][0-9٠-٩۰-۹]+)*/g;
  for (const raw of foldDigits(text).match(re) ?? []) {
    const t = foldDigits(raw);
    const parts = t.split(/[.,٬٫]/);
    const seps = t.replace(/[0-9]/g, '');
    let n: number;
    if (parts.length === 1) n = Number(t);
    else if (parts.slice(1).every((p) => p.length === 3) && (parts.length > 2 || /[,٬]/.test(seps))) n = Number(parts.join(''));
    else if (parts.length === 2) n = Number(`${parts[0]}.${parts[1]}`);
    else n = Number(parts.join(''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Everything a reply may quote, from the tool results + the customer's words.
 * A grounded value also grounds the ways reps SAY it: 1,219,000 → 1219000,
 * 1219 (ألف), 1.2 / 1.22 (مليون), 1 and 219 («مليون و219»); 725,330 → 725.
 */
export function groundedNumbers(sources: unknown[]): Set<number> {
  const out = new Set<number>();
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
    out.add(n);
    out.add(r(n, 0));
    // «120 متر» for 120.6 m² — reps drop decimals either way.
    out.add(Math.floor(n)); out.add(Math.ceil(n));
    if (Math.abs(n) >= 1000) {
      out.add(Math.round(n / 1000));
      out.add(Math.floor(n / 1000));
    }
    if (Math.abs(n) >= 1_000_000) {
      out.add(r(n / 1e6, 1)); out.add(r(n / 1e6, 2)); out.add(Math.floor(n / 1e6));
      out.add(Math.round((n % 1e6) / 1000)); out.add(Math.floor((n % 1e6) / 1000));
    }
  };
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') { add(v); return; }
    // A spoken amount in a source («ميزانيتي مليون و900») grounds the whole value too.
    if (typeof v === 'string') { for (const n of numbersInText(v)) add(n); for (const a of spokenAmounts(v)) add(a.value); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') { for (const x of Object.values(v as Record<string, unknown>)) walk(x); }
  };
  for (const s of sources) walk(s);
  return out;
}

function isGrounded(n: number, allowed: Set<number>): boolean {
  if (allowed.has(n)) return true;
  for (const a of allowed) if (Math.abs(a - n) < 1e-9) return true;
  return false;
}

/**
 * A distance / nearness claim about a PLACE («قريبة من محطة مترو، أقل من كيلو»,
 * «جنب الجامعة», «يبعد 2 كيلو عن المول»). Only a search with `near` measures
 * distances (distances_km); without one the claim is a guess. Live test
 * 2026-10-05: «الأربعة… كلها قريبة من محطة مترو، أقل من كيلو» — the nearest
 * station was 5.8–8.1 km away, and no number in it for the number check to catch.
 */
const PLACE_WORD = /(مترو|محطة|مول|جامعة|مستشفى|حديقة|طريق|metro|station|mall|university|hospital|park)/i;
const NEAR_WORD = /(قريب|قريبة|جنب|جمب|بجانب|يبعد|تبعد|كيلو|متر من|دقايق|دقائق|مشي|near|walking|\bkm\b|minutes)/i;
export function claimsPlaceDistance(text: string): boolean {
  return text.split(/[\n.،,؟?!]/).some((part) => PLACE_WORD.test(part) && NEAR_WORD.test(part));
}

/**
 * A note the model wrote to ITSELF, in any language. Review 2026-10-07: «Sadeem
 * Town units are apartments. Sent card says Type: Apartment. Answer directly.»
 * went to an English-speaking customer — the Arabic-chat English check could
 * not see it, because the chat WAS English.
 */
const SELF_NOTE = /\b(answer directly|sent card|card says|tool ?(result|call|output)|search (result|returned)|the (customer|client|user) (is|asked|wants|said|writes|has)|customer (asked|wants|said)|rule \d|per the rules?|state says|I (should|need to|will now|must)|let me |note:|reply:|draft:)/i;
const AR_SELF_NOTE = /(العميل|العميلة) (يسأل|تسأل|يبي|تبي|يريد|تريد|طلب|طلبت|قال|قالت)|(حسب|بحسب) (الأداة|الأدوات|البيانات|النتائج|القاعدة)|ملاحظة\s*:/;
const MORNING_GREETING = /^\s*(صباح الخير|صباح النور|good morning)/i;
const EVENING_GREETING = /^\s*(مساك الله بالخير|مساكم الله بالخير|مسيتي بالخير|مسيت بالخير|مساء الخير|good evening)/i;
const CUSTOMER_GREETS = /(صباح|مساء|مسا|السلام|هلا|good (morning|evening|afternoon)|hello|\bhi\b)/i;

export function checkReply(text: string, opts: {
  lang: 'ar' | 'en'; grounded: Set<number>; distancesMeasured?: boolean;
  /** Riyadh hour when the reply goes out (0–23) — a «صباح الخير» at 5 pm is wrong. */
  riyadhHour?: number;
  /** Hours since our last message in the chat — a second greeting the same day reads as a bot. */
  hoursSinceOurs?: number | null;
  /** The customer's new messages, to tell a returned greeting from a fresh one. */
  customerText?: string;
}): GuardVerdict {
  const problems: string[] = [];
  const t = text.trim();
  if (!t) return { ok: false, problems: ['empty message'] };

  if (t.length > MAX_CHARS) problems.push(`too long: ${t.length} characters (max ${MAX_CHARS}) — say one thing`);
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_LINES) problems.push(`too many lines: ${lines.length} (max ${MAX_LINES})`);
  if (lines.some((l) => /^([-•*▪️●]|\d+[.)-])\s/.test(foldDigits(l)))) problems.push('no bullet or numbered lists — say options in one sentence');
  if (/\*\*|^#{1,6}\s|__/m.test(t)) problems.push('no bold/markdown/headings');
  if (/https?:\/\/|www\./i.test(t)) problems.push('no links — the project card carries the link');
  const questions = (t.match(/[؟?]/g) ?? []).length;
  if (questions > MAX_QUESTIONS) problems.push(`too many questions: ${questions} (ask one)`);
  for (const w of FUSHA_TELLS) if (t.includes(w.trim())) problems.push(`formal Arabic «${w.trim()}» — reps never write it`);

  const arabic = /[؀-ۿ]/.test(t);
  const latinWords = (t.match(/[A-Za-z]{3,}/g) ?? []).length;
  if (opts.lang === 'ar' && !arabic) problems.push('the customer writes Arabic — reply in Arabic');
  // A planning note leaking above the message («Area known (east) → ask.») —
  // live dry run 2026-09-29. An Arabic reply has no English sentence in it.
  if (opts.lang === 'ar' && lines.some((l) => (l.match(/[A-Za-z]{2,}/g) ?? []).length >= 3 || /→|=>/.test(l))) {
    problems.push('the message contains notes or English sentences — write only the Arabic message itself');
  }
  if (opts.lang === 'en' && arabic && latinWords < 2) problems.push('the customer writes English — reply in English');
  if (lines.some((l) => SELF_NOTE.test(l) || AR_SELF_NOTE.test(l))) {
    problems.push('the message contains a note to yourself (about the customer, a tool, a card or a rule) — write ONLY what the customer should read');
  }
  // «Lسه»: a Latin letter glued to an Arabic one is a typo, never a word.
  if (/[A-Za-z][؀-ۿ]|[؀-ۿ][A-Za-z]/.test(t)) problems.push('a word mixes Latin and Arabic letters (a typo) — fix the spelling');
  if (typeof opts.riyadhHour === 'number') {
    const h = opts.riyadhHour;
    if (MORNING_GREETING.test(t) && (h >= 12 || h < 4)) problems.push('«صباح الخير» / good morning is wrong now — it is after noon in Riyadh; use «مساك الله بالخير» or no greeting');
    if (EVENING_GREETING.test(t) && h >= 4 && h < 12) problems.push('it is morning in Riyadh — use «صباح الخير», not an evening greeting');
  }
  if (typeof opts.hoursSinceOurs === 'number' && opts.hoursSinceOurs < 6
    && (MORNING_GREETING.test(t) || EVENING_GREETING.test(t)) && !CUSTOMER_GREETS.test(opts.customerText ?? '')) {
    problems.push("we already talked in the last few hours — don't greet again, just answer");
  }

  if (opts.distancesMeasured === false && claimsPlaceDistance(t)) {
    problems.push('you said how near a place is (a metro station, mall, road…) but no search measured it — search with near first, or say you will check; never guess a distance');
  }
  const ungrounded = numbersInText(t).filter((n) => !isGrounded(n, opts.grounded));
  if (ungrounded.length) {
    problems.push(`numbers not found in the tool results or the customer's words: ${[...new Set(ungrounded)].join(', ')} — only quote numbers the tools returned`);
  }
  // A spoken amount is checked WHOLE: «مليون و830 ألف» = 1,830,000. Read digit
  // by digit only «830» is seen — and 830 is part of 2,830,000 — so a reply
  // that said مليون instead of مليونين passed (2026-10-04, أكنان 25 villas).
  const big = [...opts.grounded].filter((g) => g >= 100_000);
  for (const a of spokenAmounts(t)) {
    if (!big.some((g) => Math.abs(g - a.value) < 1000)) {
      problems.push(`the amount «${a.text}» = ${a.value.toLocaleString('en-US')} is not a price in the tool results — say the full price exactly as the facts give it`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Spoken Arabic amounts WITH a remainder — «مليون و830 ألف», «مليونين و849»,
 * «2 مليون و100 ألف» — as whole numbers. Amounts without a remainder («مليون»,
 * «2.8 مليون») are rounded talk and are left to the digit check.
 */
export function spokenAmounts(text: string): Array<{ text: string; value: number }> {
  const out: Array<{ text: string; value: number }> = [];
  const t = foldDigits(text);
  const re = /(?:(\d+(?:[.,]\d+)?)\s*)?(مليونين|مليون)\s*و\s*(\d{1,3}(?:[,٬]\d{3})*)(?:\s*(?:ألف|الف))?/g;
  for (const m of t.matchAll(re)) {
    const lead = m[1] ? Number(m[1].replace(',', '.')) : null;
    const millions = m[2] === 'مليونين' ? 2 : (lead ?? 1);
    const restRaw = Number((m[3] ?? '').replace(/[,٬]/g, ''));
    if (!Number.isFinite(millions) || !Number.isFinite(restRaw)) continue;
    const rest = restRaw < 1000 ? restRaw * 1000 : restRaw;
    out.push({ text: m[0].trim(), value: Math.round(millions * 1_000_000 + rest) });
  }
  return out;
}
