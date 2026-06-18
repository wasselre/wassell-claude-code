/**
 * Deterministic dropdown / multi-select option slugging — the ONE place the
 * app turns a user-typed option label into a stable machine `value`.
 *
 * Shared by the record-form inline-create (`DynamicField`) and the Data
 * Migration standardizer so a new option created during migration gets the
 * EXACT same `value` it would get if typed into a record form. Reusing one
 * utility is a hard requirement — a migration-only slug scheme would drift
 * from the rest of the app and silently break filters/workflows that compare
 * the literal value.
 */

import type { FieldOption } from '@/types';
import { normalizeMatch } from './textMatch';

/**
 * Stable slug from a user-typed option label. Re-typing the same label (e.g.
 * "الرياض") produces the same `value` instead of a fresh UUID — old code used
 * `value: uuid()` which drifted the filter/record/option lists apart whenever
 * an option was re-created after a schema regression.
 *
 * Unicode-aware: keeps Arabic/Latin letters and digits, strips Latin
 * diacritics and punctuation, lowercases, replaces whitespace runs with
 * hyphens.
 */
export function slugifyOptionLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip Latin diacritics
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // keep letters/digits/space/hyphen
    .trim()
    .replace(/\s+/g, '-');
  return base || 'option';
}

/**
 * Find an existing option on this field that matches the typed label.
 * Compares against label_ar AND label_en AND the slugified value, using the
 * shared Arabic-aware normalizer — so re-typing the same label (different
 * casing/spacing/diacritics, e.g. "فيلا"/"Villa"/"villa") surfaces the
 * existing option instead of creating a duplicate. Also rescues UUID-valued
 * options that pre-date the slug-value change.
 */
export function findExistingOption(
  options: readonly FieldOption[],
  label: string,
): FieldOption | undefined {
  const norm = normalizeMatch(label);
  const slug = slugifyOptionLabel(label);
  return options.find(
    (o) =>
      normalizeMatch(o.label_ar ?? '') === norm ||
      normalizeMatch(o.label_en ?? '') === norm ||
      o.value === slug ||
      normalizeMatch(o.value ?? '') === norm,
  );
}

/**
 * Resolve a base slug to one that doesn't collide with `usedValues`, appending
 * the app's standard numeric suffix (`-2`, `-3`, …) on collision. Keeps two
 * distinct labels that slugify to the same string ("الرياض!" / "الرياض?")
 * from sharing one value.
 */
export function uniqueOptionValue(baseSlug: string, usedValues: Set<string>): string {
  if (!usedValues.has(baseSlug)) return baseSlug;
  let suffix = 2;
  let value = `${baseSlug}-${suffix}`;
  while (usedValues.has(value)) {
    suffix++;
    value = `${baseSlug}-${suffix}`;
  }
  return value;
}
