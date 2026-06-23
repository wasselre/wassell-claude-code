/**
 * The ONE shared text-matching primitives for value standardization.
 *
 * Every comparison in the standardization flow — deterministic pre-matching,
 * AI-proposal matching, option lookup, lookup-record matching, and duplicate
 * detection before creating a new option/record — MUST go through
 * `normalizeMatch` so that one code path can't succeed while another silently
 * fails (a class of bug CLAUDE.md calls out explicitly). Keep this the single
 * definition; do not fork a second normalizer.
 *
 * Arabic-aware: strips diacritics + tatweel, unifies alef/ya/taa-marbuta
 * variants, collapses whitespace, and lowercases. So "شقه" matches "شقة",
 * "ريا" matches "ريّا", "Villa" matches "villa".
 */

// Arabic diacritics (harakat) U+064B–U+0652, superscript alef U+0670, and
// tatweel U+0640 — stripped for matching only; the canonical label keeps them.
const AR_DIACRITICS = /[ً-ْٰـ]/g;

export function normalizeMatch(s: string): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا') // alef variants → bare alef
    .replace(/ى/g, 'ي') // alif maqsura → ya
    .replace(/ة/g, 'ه') // taa marbuta → haa
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Separators that split a single spreadsheet cell into multiple values for a
 * multi-select / multi-value-lookup field: Latin comma, Arabic comma (U+060C),
 * Latin + Arabic semicolons (U+061B), and newlines. Deliberately NOT slash —
 * `/` appears inside legitimate values (e.g. "A/C", "2/3 غرف") and would split
 * them wrongly.
 */
const MULTI_VALUE_SEPARATORS = /[,،;؛\r\n]+/;

/** Split a multi-value cell into trimmed, non-empty tokens. The single source
 * of truth for tokenization — used by distinct-value counting, the record
 * builder, and the importer so a token is split identically everywhere. */
export function splitMultiValue(cell: string): string[] {
  return (cell ?? '')
    .split(MULTI_VALUE_SEPARATORS)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Split a TABLE sub-column cell into its parallel entries. A table encodes N
 * rows across sibling sub-columns as `|`-separated lists that must stay
 * INDEX-ALIGNED (slot N of every sub-column = row N), so this DIFFERS from
 * splitMultiValue on purpose:
 *  - splits on the VERTICAL BAR `|` (and newlines), NOT commas — commas appear
 *    inside legitimate values AND inside numbers ("70,000"), which corrupted the
 *    split and shredded numbers into fragments (the table-field import bug).
 *  - KEEPS empty slots (single-char split, no `+`), so "A||C" → ["A","","C"]
 *    and siblings stay aligned when an entry lacks a sub-column value.
 * Returns [] for a wholly-empty cell. The extraction prompt (TABLE_FIELDS_RULE)
 * mandates `|` so the model emits exactly this shape.
 */
export function splitTableValue(cell: string): string[] {
  const s = (cell ?? '').replace(/\r\n?/g, '\n');
  if (s.trim() === '') return [];
  return s.split(/[|\n]/).map((t) => t.trim());
}
