// How a rep's ticked chat-preference suggestions land on the client record.
// PURE, and imported by BOTH the SPA card (PrefSuggestionsSection) and the
// server review endpoint (api/client-prefs/review.ts) — so no `@/` imports and
// no store here, only relative imports of other pure modules.
//
//   set fields   (unit type, purpose, amenities) → UNION with the fresh row
//                value; a suggested value that is not an option of the LIVE
//                clients schema is DROPPED (and reported so the caller logs it).
//   range fields (budget, area, bedrooms)          → REPLACE the saved range.
//   unticked fields                                 → never touched.

import { valueEqual, isEmptyValue } from '../salesProcess/valueEqual.js';

export type PrefFieldKind = 'set' | 'range';

export const PREF_FIELD_KINDS: Readonly<Record<string, PrefFieldKind>> = {
  preferred_unit_type: 'set',
  purchase_objective: 'set',
  preferred_amenities: 'set',
  budget: 'range',
  preferred_area: 'range',
  preferred_bedrooms: 'range',
};

/** The order the card lists the fields in. */
export const PREF_SLUG_ORDER: readonly string[] = [
  'preferred_unit_type', 'budget', 'preferred_area', 'preferred_bedrooms', 'purchase_objective', 'preferred_amenities',
];

export function isPrefSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(PREF_FIELD_KINDS, slug);
}

export interface PrefSuggestionLike {
  slug: string;
  value: unknown;
  quote: string | null;
  confidence: number;
}

export interface RangeValueLike { min?: number; max?: number }

export { valueEqual };

/** A stored multiselect value as a string array (a bare scalar is wrapped). */
export function asSetValue(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (typeof v === 'string' && v.trim() !== '') return [v];
  return [];
}

/** A stored / suggested range as `{min?, max?}` (non-finite / non-positive parts dropped); null when empty. */
export function asRangeValue(v: unknown): RangeValueLike | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { min?: unknown; max?: unknown };
  const num = (x: unknown): number | undefined => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const min = num(o.min), max = num(o.max);
  if (min === undefined && max === undefined) return null;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

/**
 * Union `incoming` onto `current` (order kept, duplicates removed). Incoming
 * values outside `allowed` are dropped and returned in `dropped`; current
 * values are always kept (never destroy what a rep saved). `allowed === null`
 * means "no constraint".
 */
export function mergeSetValues(
  current: unknown,
  incoming: unknown,
  allowed: ReadonlySet<string> | null,
): { values: string[]; added: string[]; dropped: string[] } {
  const values = [...new Set(asSetValue(current))];
  const seen = new Set(values);
  const added: string[] = [];
  const dropped: string[] = [];
  for (const v of asSetValue(incoming)) {
    if (allowed && !allowed.has(v)) { dropped.push(v); continue; }
    if (seen.has(v)) continue;
    seen.add(v);
    values.push(v);
    added.push(v);
  }
  return { values, added, dropped };
}

/**
 * Would saving this suggestion leave the field exactly as it is? For a set
 * field: every suggested value is already saved. For a range: the same range.
 * The card unticks such a line by default and labels it «مطابق للمحفوظ».
 */
export function isSameAsSaved(slug: string, current: unknown, suggested: unknown): boolean {
  const kind = PREF_FIELD_KINDS[slug];
  if (kind === 'set') {
    const cur = new Set(asSetValue(current));
    const sug = asSetValue(suggested);
    return sug.length > 0 && sug.every((v) => cur.has(v));
  }
  if (kind === 'range') {
    const a = asRangeValue(current), b = asRangeValue(suggested);
    if (!a && !b) return true;
    return valueEqual(a, b);
  }
  return valueEqual(current, suggested);
}

export interface PrefPatchResult {
  /** Only the slugs that actually change. Empty ⇒ nothing to write. */
  patch: Record<string, unknown>;
  /** Suggested set values the live schema does not offer — dropped, never saved. */
  dropped: Array<{ slug: string; value: string }>;
}

/**
 * The fields to write for the TICKED suggestions, merged against `current`
 * (the FRESH client row data at save time). Unknown slugs and unticked slugs
 * are ignored. `optionsBySlug[slug]` = the live option `value`s; missing ⇒ the
 * field has no options in the schema ⇒ every suggested value is dropped.
 */
export function buildPrefPatch(
  current: Record<string, unknown>,
  suggestions: Record<string, PrefSuggestionLike>,
  ticked: readonly string[],
  optionsBySlug: Readonly<Record<string, readonly string[] | undefined>>,
): PrefPatchResult {
  const patch: Record<string, unknown> = {};
  const dropped: Array<{ slug: string; value: string }> = [];
  for (const slug of new Set(ticked)) {
    const kind = PREF_FIELD_KINDS[slug];
    const sug = suggestions[slug];
    if (!kind || !sug) continue;
    if (kind === 'set') {
      const allowed = new Set(optionsBySlug[slug] ?? []);
      const merged = mergeSetValues(current[slug], sug.value, allowed);
      for (const v of merged.dropped) dropped.push({ slug, value: v });
      if (merged.added.length > 0) patch[slug] = merged.values;
    } else {
      const next = asRangeValue(sug.value);
      if (!next) continue;
      if (valueEqual(asRangeValue(current[slug]), next)) continue;
      patch[slug] = next;
    }
  }
  return { patch, dropped };
}

export interface FillEmptyPatchResult extends PrefPatchResult {
  /** Ticked fields that are NOT empty on the fresh row — never written. */
  skippedFilled: string[];
}

/**
 * The CALL AUDIT's save: FILL-EMPTY-ONLY, never overwrite. For each ticked
 * suggestion, a field whose FRESH value is non-empty (`isEmptyValue` — the same
 * test the audit used to propose it) is skipped and reported in
 * `skippedFilled`; an empty one gets the suggested value. Set values are still
 * validated against the live schema options (unknown ⇒ dropped + reported).
 * Unticked / unknown / unsuggested slugs are ignored.
 */
export function buildFillEmptyPatch(
  current: Record<string, unknown>,
  suggestions: Record<string, PrefSuggestionLike>,
  ticked: readonly string[],
  optionsBySlug: Readonly<Record<string, readonly string[] | undefined>>,
): FillEmptyPatchResult {
  const patch: Record<string, unknown> = {};
  const dropped: Array<{ slug: string; value: string }> = [];
  const skippedFilled: string[] = [];
  for (const slug of new Set(ticked)) {
    const kind = PREF_FIELD_KINDS[slug];
    const sug = suggestions[slug];
    if (!kind || !sug) continue;
    if (!isEmptyValue(current[slug])) { skippedFilled.push(slug); continue; }
    if (kind === 'set') {
      const merged = mergeSetValues(null, sug.value, new Set(optionsBySlug[slug] ?? []));
      for (const v of merged.dropped) dropped.push({ slug, value: v });
      if (merged.values.length > 0) patch[slug] = merged.values;
    } else {
      const next = asRangeValue(sug.value);
      if (next) patch[slug] = next;
    }
  }
  return { patch, dropped, skippedFilled };
}

/** True when the value carries nothing to show. */
export function isEmptyPrefValue(v: unknown): boolean {
  return isEmptyValue(v);
}

export interface AiPrefPatchResult extends PrefPatchResult {
  /** Set fields: exactly the values this write ADDS (Undo removes only these). */
  added: Record<string, string[]>;
  /** Range fields left alone because a REP set them (the AI heard something else). */
  keptRepValue: Array<{ slug: string; current: unknown; heard: unknown }>;
}

/**
 * The AI's OWN save (no rep tick — operator, 2026-10-04). Same shape rules as
 * {@link buildPrefPatch}, with one guard so the AI never silently overwrites a
 * rep:
 *   set fields   → UNION (only ever adds; live-schema check as usual).
 *   range fields → written when the field is EMPTY, or when the current value
 *                  is the one the AI itself wrote last (`aiOwned` — the customer
 *                  changed their mind). A value a REP typed is KEPT and the
 *                  heard value is reported in `keptRepValue`.
 */
export function buildAiPrefPatch(
  current: Record<string, unknown>,
  suggestions: Record<string, PrefSuggestionLike>,
  fields: readonly string[],
  optionsBySlug: Readonly<Record<string, readonly string[] | undefined>>,
  aiOwned: ReadonlySet<string>,
): AiPrefPatchResult {
  const patch: Record<string, unknown> = {};
  const dropped: Array<{ slug: string; value: string }> = [];
  const added: Record<string, string[]> = {};
  const keptRepValue: AiPrefPatchResult['keptRepValue'] = [];
  for (const slug of new Set(fields)) {
    const kind = PREF_FIELD_KINDS[slug];
    const sug = suggestions[slug];
    if (!kind || !sug) continue;
    if (kind === 'set') {
      const merged = mergeSetValues(current[slug], sug.value, new Set(optionsBySlug[slug] ?? []));
      for (const v of merged.dropped) dropped.push({ slug, value: v });
      if (merged.added.length > 0) { patch[slug] = merged.values; added[slug] = merged.added; }
      continue;
    }
    const next = asRangeValue(sug.value);
    if (!next) continue;
    const cur = asRangeValue(current[slug]);
    if (valueEqual(cur, next)) continue;
    if (cur && !aiOwned.has(slug)) { keptRepValue.push({ slug, current: cur, heard: next }); continue; }
    patch[slug] = next;
  }
  return { patch, dropped, added, keptRepValue };
}

/** Undo of ONE AI pref write on the FRESH value: a set field loses only the
 *  values the AI added; a range goes back to `before` only if it still holds
 *  what the AI wrote (else null = the field moved on, nothing to undo). */
export function undoPrefValue(
  slug: string, fresh: unknown, change: { before: unknown; after: unknown; added: unknown },
): { value: unknown } | null {
  const kind = PREF_FIELD_KINDS[slug];
  if (kind === 'set') {
    const remove = new Set(asSetValue(change.added));
    const cur = asSetValue(fresh);
    if (!cur.some((v) => remove.has(v))) return null;
    const kept = cur.filter((v) => !remove.has(v));
    return { value: kept.length ? kept : null };
  }
  if (kind === 'range') {
    if (!valueEqual(asRangeValue(fresh), asRangeValue(change.after))) return null;
    return { value: asRangeValue(change.before) };
  }
  return null;
}
