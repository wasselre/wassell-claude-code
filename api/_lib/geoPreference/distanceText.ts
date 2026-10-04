/**
 * The distances a customer actually SAID, read from their own words — a CLOSED
 * grammar (design 2026-10-04 §2.2). PURE.
 *
 * Why: HARD RULE 4 says a distance rule needs a stated distance. The extractor
 * writes `distance_m` on an anchor, but that number is MODEL output; a radius
 * is used only when this grammar finds the same number in the customer's text
 * (anchorPrep.ts, P10). Anything the grammar does not recognise produces NO
 * value, and the card asks — so the grammar is deliberately small and exact
 * rather than clever.
 *
 * A TIME is never a distance: «10 دقايق», «ربع ساعة», «ساعتين» carry no distance
 * unit, so they produce nothing. Do not add a time-to-distance conversion.
 *
 * Every text is normalised first: Arabic-Indic / Persian digits → Latin, «٫» →
 * «.», a thousands separator («,» or «٬») dropped only between groups of exactly
 * three digits, then folded like anchorPrep's `foldWord` (lower-case, no
 * diacritics / tatweel, أإآٱ→ا, ة→ه, ى→ي).
 */

import { DISTANCE_M_MAX, DISTANCE_M_MIN } from './ontology.js';

/**
 * The same fold as anchorPrep.ts `foldWord` (a copy, so this module does not
 * import anchorPrep — anchorPrep imports THIS module). Pinned equal by
 * __tests__/distanceText.test.ts.
 */
export function foldDistanceText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

/** Digits → Latin, «٫» → «.», a thousands separator dropped only between groups of exactly three digits, then folded. */
export function normalizeDistanceText(text: string): string {
  const latin = String(text ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
  // «2,000» / «12,500,000» — a whole number grouped by 3s. «1,5» or «12,34» keep
  // their comma (no number is read across it, see NUM).
  const grouped = latin.replace(/(?<![\d.,٬])\d{1,3}(?:[,٬]\d{3})+(?![\d,٬])/g, (m) => m.replace(/[,٬]/g, ''));
  return foldDistanceText(grouped);
}

// ── The grammar. Word boundaries are explicit: JS `\b` does not see Arabic letters. ──
/** No letter or digit right before. */
const B = '(?<![\\p{L}\\p{N}])';
/** No letter or digit right after. */
const E = '(?![\\p{L}\\p{N}])';
/**
 * A number. A letter may be glued in front of it («و3 كيلو», «ب500 متر») but
 * not a digit, a dot or a separator: «1,5 كيلو» reads nothing rather than 5 km.
 */
const NUM = '(?<![\\p{N}.,٬])(\\d+(?:\\.\\d+)?)';
const HALF = '(?:نصف|نص)';
const KILO_SHORT = '(?:كيلو|كم)';
const KILO_UNITS = '(?:كيلومترات|كيلومتر|كيلوات|كيلو|كم|km|kilometers|kilometres|kilometer|kilometre)';
const METRE_UNITS = '(?:امتار|مترا|متر|meters|metres|meter|metre|م|m)';

/** Number words before a kilometre unit (D8), folded. */
const NUMBER_WORDS: Record<string, number> = {
  'واحد': 1, 'واحده': 1, 'اثنين': 2, 'اثنان': 2, 'ثلاث': 3, 'ثلاثه': 3, 'اربع': 4, 'اربعه': 4,
  'خمس': 5, 'خمسه': 5, 'ست': 6, 'سته': 6, 'سبع': 7, 'سبعه': 7, 'ثمان': 8, 'ثمانيه': 8,
  'تسع': 9, 'تسعه': 9, 'عشر': 10, 'عشره': 10, 'عشرين': 20,
};
const NUMBER_WORD = `(${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')})`;

interface Rule { re: RegExp; value: (m: RegExpExecArray) => number }

/** D1–D8, checked IN ORDER; an earlier rule consumes its text. */
const RULES: readonly Rule[] = [
  // D1 «2 كيلو ونص» / «2كم و نصف»
  { re: new RegExp(`${NUM}\\s*${KILO_SHORT}\\s*و\\s*${HALF}${E}`, 'gu'), value: (m) => Number(m[1]) * 1000 + 500 },
  // D2 «3 كيلو», «3كيلو», «2.5 كم», «4 km»
  { re: new RegExp(`${NUM}\\s*${KILO_UNITS}${E}`, 'gu'), value: (m) => Number(m[1]) * 1000 },
  // D3 «500 متر», «500م», «800 m»
  { re: new RegExp(`${NUM}\\s*${METRE_UNITS}${E}`, 'gu'), value: (m) => Number(m[1]) },
  // D4 «كيلوين»
  { re: new RegExp(`${B}كيلوين${E}`, 'gu'), value: () => 2000 },
  // D5 «نص كيلو»
  { re: new RegExp(`${B}${HALF}\\s+كيلو${E}`, 'gu'), value: () => 500 },
  // D6 «ربع كيلو»
  { re: new RegExp(`${B}ربع\\s+كيلو${E}`, 'gu'), value: () => 250 },
  // D7 «كيلو ونص» (no number before it — D1 took those)
  { re: new RegExp(`${B}كيلو\\s*و\\s*${HALF}${E}`, 'gu'), value: () => 1500 },
  // D8 «ثلاث كيلو», «خمسه كم»
  { re: new RegExp(`${B}${NUMBER_WORD}\\s+(?:كيلومتر|كيلو|كم)${E}`, 'gu'), value: (m) => (NUMBER_WORDS[m[1]!] ?? NaN) * 1000 },
];

/** D9: words that make a BARE «كيلو» mean «one kilometre» («خلال كيلو من …», «في حدود كيلو»), folded. */
const BARE_KILO_TRIGGERS: readonly (readonly string[])[] = [
  ['خلال'], ['بحدود'], ['حدود'], ['حوالي'], ['مسافه'], ['بمسافه'], ['تقريبا'], ['في', 'حدود'], ['اقل', 'من'],
];
/** A trigger must END at most this many words before the bare «كيلو». */
const BARE_KILO_WINDOW = 2;

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Every distance, in metres within [{@link DISTANCE_M_MIN}, {@link DISTANCE_M_MAX}],
 * that the closed grammar finds in any of `texts` — in order of appearance,
 * without duplicates. A number outside the bounds is dropped («30 متر», «80 كيلو»).
 */
export function distancesIn(texts: readonly string[]): number[] {
  const out: number[] = [];
  const add = (v: number): void => {
    if (!Number.isFinite(v)) return;
    const m = Math.round(v);
    if (m < DISTANCE_M_MIN || m > DISTANCE_M_MAX) return;
    if (!out.includes(m)) out.push(m);
  };
  for (const raw of texts) {
    const text = normalizeDistanceText(raw);
    const found: Array<{ at: number; value: number }> = [];
    const consumed: Array<[number, number]> = [];
    const free = (s: number, e: number): boolean => consumed.every(([a, b]) => e <= a || s >= b);
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        if (m[0].length === 0) { rule.re.lastIndex += 1; continue; }
        if (!free(s, e)) continue;
        consumed.push([s, e]);
        found.push({ at: s, value: rule.value(m) });
      }
    }
    // D9 — a bare «كيلو» no earlier rule consumed, with a trigger just before it.
    const words: Array<{ w: string; s: number; e: number }> = [];
    WORD.lastIndex = 0;
    let w: RegExpExecArray | null;
    while ((w = WORD.exec(text)) !== null) words.push({ w: w[0], s: w.index, e: w.index + w[0].length });
    words.forEach((word, k) => {
      if (word.w !== 'كيلو' || !free(word.s, word.e)) return;
      const triggered = BARE_KILO_TRIGGERS.some((t) => {
        for (let end = k - 1; end >= Math.max(0, k - BARE_KILO_WINDOW); end--) {
          const start = end - t.length + 1;
          if (start < 0) continue;
          if (t.every((tw, i) => words[start + i]!.w === tw)) return true;
        }
        return false;
      });
      if (triggered) {
        consumed.push([word.s, word.e]);
        found.push({ at: word.s, value: 1000 });
      }
    });
    found.sort((a, b) => a.at - b.at).forEach((f) => add(f.value));
  }
  return out;
}
