// Similarity helpers used by the Import wizard to detect near-duplicate rows
// against existing records. All functions are pure and framework-free.
//
// The duplicate-check column on the target model tells us which field to
// compare. We pick a strategy by field type:
//   - phone   → digit-only normalization, match last 9 digits (country-code
//               agnostic)
//   - email   → local-part match OR high Levenshtein ratio
//   - text/url/textarea → normalized Levenshtein ratio ≥ TEXT_THRESHOLD
//   - everything else → exact only (no fuzziness; numbers / ids / dates)
//
// `findBestSimilarMatch` never returns an exact match — callers handle those
// through the existing exact-duplicate path. A "near" match is only reported
// when the values differ after normalization but are close enough that a human
// would likely want to review the pairing.

import type { FieldType } from '@/types';

const TEXT_THRESHOLD = 0.85;
const EMAIL_THRESHOLD = 0.9;

export function normalizeBasic(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizePhone(v: unknown): string {
  if (v === null || v === undefined) return '';
  const digits = String(v).replace(/\D+/g, '');
  // Match on the last 9 digits so +9665… and 05… collapse to the same key.
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function emailLocalPart(v: string): string {
  const at = v.indexOf('@');
  return at === -1 ? v : v.slice(0, at);
}

/** Levenshtein distance — iterative, O(n*m) time, O(m) memory. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 1 - (distance / max-length). 1 means identical, 0 means maximally different. */
export function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export interface ExistingEntry {
  recordId: string;
  rawValue: string; // original trimmed string — shown to the user
  normalizedValue: string; // basic or phone-normalized key
}

export interface SimilarMatch {
  recordId: string;
  rawValue: string;
  score: number; // 0..1
}

/**
 * Return the best similar (but NOT exact) match for `incoming` against the
 * given existing entries. Exact matches — any entry with the same normalized
 * key — short-circuit to null; those are handled by the exact-duplicate path
 * upstream. Returns null when no entry clears the type-specific threshold.
 */
export function findBestSimilarMatch(
  incoming: string,
  fieldType: FieldType,
  existing: ExistingEntry[],
): SimilarMatch | null {
  if (!incoming) return null;
  const normalizedIncoming =
    fieldType === 'phone' ? normalizePhone(incoming) : normalizeBasic(incoming);
  if (!normalizedIncoming) return null;

  // Fuzzy matching doesn't make sense for these — a near-miss number or date
  // isn't a "probably the same record", it's a different record.
  if (
    fieldType === 'number' ||
    fieldType === 'currency' ||
    fieldType === 'date' ||
    fieldType === 'datetime' ||
    fieldType === 'auto_id' ||
    fieldType === 'lookup' ||
    fieldType === 'checkbox' ||
    fieldType === 'dropdown'
  ) {
    return null;
  }

  let best: SimilarMatch | null = null;
  for (const entry of existing) {
    if (!entry.normalizedValue) continue;
    if (entry.normalizedValue === normalizedIncoming) return null; // exact — caller handles.

    let score = 0;
    if (fieldType === 'phone') {
      // Phones: Levenshtein ratio on digit-only normalized values catches
      // off-by-one-digit typos (e.g. ...67 vs ...68 → 0.89) and digit
      // transpositions. Threshold is slightly looser than text because
      // short digit strings give proportionally bigger ratios per edit.
      score = similarityRatio(entry.normalizedValue, normalizedIncoming);
      if (score < 0.78) continue;
    } else if (fieldType === 'email') {
      const a = entry.normalizedValue;
      const b = normalizedIncoming;
      const sameLocal = emailLocalPart(a) === emailLocalPart(b) && emailLocalPart(a).length > 0;
      score = sameLocal ? 0.95 : similarityRatio(a, b);
      if (score < EMAIL_THRESHOLD) continue;
    } else {
      // text, textarea, url — plain Levenshtein ratio on normalized strings.
      score = similarityRatio(entry.normalizedValue, normalizedIncoming);
      if (score < TEXT_THRESHOLD) continue;
    }

    if (!best || score > best.score) {
      best = { recordId: entry.recordId, rawValue: entry.rawValue, score };
    }
  }
  return best;
}
