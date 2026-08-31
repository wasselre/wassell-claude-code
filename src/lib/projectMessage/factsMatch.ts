// Does a SAVED project WhatsApp message already reflect the project's CURRENT
// numbers? If so, the send flow can skip the (slow, ~1–2 min) AI fact-check
// round-trip entirely and send the saved text as-is.
//
// Pure + import-free (types only) so it is unit-testable and could be reused
// server-side. Keep it that way — no browser/store imports.
//
// SAFETY POSTURE — the two error directions are NOT symmetric:
//   • false-SKIP  (say "matches" when a number actually drifted) → we send a
//     STALE number to a customer. HARMFUL. Must be avoided.
//   • false-NO-SKIP (say "no match" when it actually matches) → we make the AI
//     call we could have skipped. Merely SLOW. Acceptable.
// Every rule below therefore errs toward NOT skipping when it cannot prove a
// match. In particular a project that no longer has an available price but whose
// saved message still quotes one is never skipped (QA-003: a sold-out project
// must not keep quoting a price the fact-check would have removed).

import type { NumericRange, ProjectMessageFacts } from './compose.js';

// ── digit / separator normalization ────────────────────────────────────────
// Fold Arabic-Indic + Extended Arabic-Indic digits to Western, normalize the
// Arabic decimal separator to '.', and strip thousands separators (Western ','
// + Arabic '٬') so "559,000" and "٥٥٩٬٠٠٠" both become "559000". Decimal points
// are KEPT so "90.07" survives.
function normalizeBody(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.') // Arabic decimal separator → .
    .replace(/[,٬]/g, ''); // Western + Arabic thousands separators → removed
}

// A number is "present" only as a standalone token — not as a fragment of a
// larger number. Boundaries are checked WITHOUT lookbehind/lookahead so the
// pattern is portable across build targets. "digit or dot" on either side fails
// the match (so "3" does not match inside "13" or "3.5" or "180").
function hasBoundedNumber(norm: string, token: string): boolean {
  const isDigitOrDot = (c: string) => c !== '' && /[0-9.]/.test(c);
  let from = 0;
  for (;;) {
    const idx = norm.indexOf(token, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : norm[idx - 1] ?? '';
    const after = idx + token.length >= norm.length ? '' : norm[idx + token.length] ?? '';
    if (!isDigitOrDot(before) && !isDigitOrDot(after)) return true;
    from = idx + 1;
  }
}

// Candidate string forms a number may take in the rendered message. Area comes
// off the rollup as a decimal (90.07) but the deterministic composer rounds it
// to whole m² (90), and the AI may do either — so ranges flagged `allowRounded`
// accept both. `String(n)` gives "90.07" / "559000" / "2" as written.
function numberForms(n: number, allowRounded: boolean): string[] {
  const forms = new Set<string>([String(n)]);
  if (allowRounded) forms.add(String(Math.round(n)));
  return [...forms];
}

// A range is verified against the CONTIGUOUS "a <sep> b" patterns actually
// written in the copy, not against loose digit presence — that is what stops a
// drifted range from being declared current just because its endpoints happen to
// coincide with other digits (a price, the bedroom count). If the AI phrased the
// range in a way this doesn't recognize, we simply don't skip (safe direction).
const RANGE_SEP = '\\s*(?:-|\\u2013|\\u2014|~|to|\\u0625\\u0644\\u0649|\\u062D\\u062A\\u0649)\\s*';
const RANGE_RE = new RegExp(`(?:^|[^\\d.])(\\d[\\d.]*)${RANGE_SEP}(\\d[\\d.]*)(?:[^\\d.]|$)`, 'g');

/** Every contiguous numeric range written in the (normalized) body. */
function extractRanges(norm: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  RANGE_RE.lastIndex = 0;
  for (let m = RANGE_RE.exec(norm); m; m = RANGE_RE.exec(norm)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
    RANGE_RE.lastIndex -= 1; // the trailing boundary char may start the next range
  }
  return out;
}

// Two numbers are "the same" as rendered — exact, or (for area, which the copy
// may round to whole m²) equal once rounded.
const eqNum = (x: number, y: number, allowRounded: boolean): boolean =>
  x === y || (allowRounded && Math.round(x) === Math.round(y));

function rangePresent(norms: string[], range: NumericRange, allowRounded = false): boolean {
  const forms = numberForms(range.min, allowRounded);
  return norms.every((norm) => {
    const ranges = extractRanges(norm);
    if (range.min !== range.max) {
      // A multi-value range must be written verbatim as one "min <sep> max" pair.
      return ranges.some(([a, b]) => eqNum(a, range.min, allowRounded) && eqNum(b, range.max, allowRounded));
    }
    // Single value: it must appear as a standalone token AND must NOT be shown as
    // an endpoint of a WIDER range (which would mean the saved copy still quotes
    // the pre-shrink range — stale). A range collapsing to one value is exactly
    // the case bare-token matching got wrong.
    const present = forms.some((f) => hasBoundedNumber(norm, f));
    if (!present) return false;
    const shownAsWiderRange = ranges.some(
      ([a, b]) =>
        (eqNum(a, range.min, allowRounded) && !eqNum(b, range.min, allowRounded)) ||
        (eqNum(b, range.min, allowRounded) && !eqNum(a, range.min, allowRounded)),
    );
    return !shownAsWiderRange;
  });
}

// Extract the numeric value from a pre-formatted price ("SAR 559,000" /
// "559,000 ر.س"). Prefer the English form; fall back to Arabic. Returns null if
// no digits are found — in which case the caller must NOT skip.
function parsePriceNumber(price: { ar: string; en: string }): number | null {
  for (const raw of [price.en, price.ar]) {
    const digits = normalizeBody(raw).replace(/[^\d]/g, '');
    if (digits) {
      const n = Number(digits);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

const hasPriceMention = (body: string): boolean => /ر\.?\s?س|SAR/i.test(body);

/**
 * True when the saved bodies already reflect the project's current NUMBERS
 * (available starting price, area range, bedroom range, bathroom range) — so the
 * AI fact-check call can be skipped and the saved text sent unchanged.
 *
 * Returns false (→ run the fact-check) whenever a number cannot be proven
 * current, including the sold-out case (facts carry no price but a body still
 * quotes one). Unit-type additions are intentionally NOT part of the gate: they
 * aren't "numbers", they're low-harm, and the rep reviews the preview.
 */
export function savedMessageMatchesCurrentFacts(
  facts: ProjectMessageFacts,
  savedAr: string,
  savedEn: string,
): boolean {
  const bodies = [savedAr, savedEn].filter((b) => b && b.trim());
  if (bodies.length === 0) return false; // nothing saved → let the AI path handle it
  const norms = bodies.map(normalizeBody);

  // PRICE — the high-harm field.
  if (facts.minPrice) {
    const priceNum = parsePriceNumber(facts.minPrice);
    if (priceNum == null) return false; // unparseable → don't risk it
    if (!norms.every((n) => hasBoundedNumber(n, String(priceNum)))) return false;
  } else if (bodies.some(hasPriceMention)) {
    // Project has no available price now, but a saved body still quotes one.
    // Skipping would send a price the fact-check would have stripped. Don't.
    return false;
  }

  // AREA (decimal-or-rounded m²), BEDROOMS, BATHROOMS — each present ranges must
  // match; a null fact (project genuinely has none) has nothing to verify.
  if (facts.areaRange && !rangePresent(norms, facts.areaRange, true)) return false;
  if (facts.bedrooms && !rangePresent(norms, facts.bedrooms)) return false;
  if (facts.bathrooms && !rangePresent(norms, facts.bathrooms)) return false;

  return true;
}
