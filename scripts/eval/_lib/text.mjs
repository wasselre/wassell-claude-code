/**
 * scripts/eval/_lib/text.mjs — Arabic-aware text helpers for the eval harness.
 *
 * `normAr` mirrors the SQL `mkt_norm_ar` / worker `entities.ts normAr` contract
 * (contracts §12): folds أإآ→ا, ة→ه, ى→ي, strips tatweel + diacritics, unifies
 * Arabic-Indic and Persian digits to ASCII, lowercases Latin. Keep in sync by
 * convention — the harness only uses it for leakage / entity matching, so a
 * drift shows up as a slightly different Jaccard, never as a wrong gate.
 */

const DIACRITICS = /[ً-ْٰـ]/g; // tashkeel + dagger alif + tatweel
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function unifyDigits(s) {
  return String(s).replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = AR_DIGITS.indexOf(ch);
    return String(i >= 0 ? i : FA_DIGITS.indexOf(ch));
  });
}

export function normAr(s) {
  return unifyDigits(String(s ?? ''))
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase();
}

/** Word tokens after normalisation; punctuation dropped; 1-char tokens dropped. */
export function tokens(s) {
  return normAr(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

export function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens), B = new Set(bTokens);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Number of distinct n-grams of `a` that also occur in `b` (verbatim-copy detector). */
export function sharedNgrams(aTokens, bTokens, n = 5) {
  const grams = (toks) => { const s = new Set(); for (let i = 0; i + n <= toks.length; i++) s.add(toks.slice(i, i + n).join(' ')); return s; };
  const A = grams(aTokens), B = grams(bTokens);
  let c = 0;
  for (const g of A) if (B.has(g)) c++;
  return { shared: c, of: A.size };
}

/**
 * Extract numeric mentions from Arabic/English marketing copy as plain
 * numbers. Handles thousands separators (1,050,000 / 1.050.000), Arabic-Indic
 * digits, and the spoken forms «١.٠٥ مليون» / "1.05M" / «٥٠٠ ألف» → 1050000 /
 * 500000. Percentages are returned too (as their number) — the caller decides.
 */
export function extractNumbers(text) {
  const s = unifyDigits(String(text ?? ''));
  const out = [];
  const re = /(\d+(?:[.,]\d+)*)\s*(مليون|م\.?|million|m\b|الف|ألف|k\b|thousand)?/giu;
  for (const m of s.matchAll(re)) {
    let raw = m[1];
    let val;
    if (/^\d{1,3}(,\d{3})+$/.test(raw) || /^\d{1,3}(\.\d{3})+$/.test(raw)) val = Number(raw.replace(/[.,]/g, ''));
    else val = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(val)) continue;
    const unit = (m[2] || '').toLowerCase();
    if (/مليون|million|^m$|^م\.?$/.test(unit)) val *= 1e6;
    else if (/الف|ألف|^k$|thousand/.test(unit)) val *= 1e3;
    out.push({ raw: m[0].trim(), value: val });
  }
  return out;
}

/** True when `value` equals one of `allowed` within a relative tolerance (default 1 %). */
export function numberAllowed(value, allowed, relTol = 0.01) {
  for (const a of allowed) {
    if (!Number.isFinite(a)) continue;
    if (a === 0 ? value === 0 : Math.abs(value - a) / Math.abs(a) <= relTol) return true;
  }
  return false;
}

/** Digit-only canonical form for phone matching (both sides). */
export function digitsOnly(s) {
  return unifyDigits(String(s ?? '')).replace(/\D+/g, '');
}

/** All phone-looking sequences (KSA/UAE mobile + 9200 lines) in a text, as digit strings. */
export function findPhones(text) {
  const s = unifyDigits(String(text ?? ''));
  const hits = new Set();
  for (const m of s.matchAll(/(?:\+?966|\+?971|0)?\s?5\d(?:[\s-]?\d){7}|\b9200\s?\d{2}\s?\d{3}\b|\b920\s?\d{3}\s?\d{3}\b/g)) hits.add(digitsOnly(m[0]));
  return [...hits];
}
