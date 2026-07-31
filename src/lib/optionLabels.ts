/**
 * Shared dropdown-option label resolution — the ONE helper for turning a
 * stored option `value` back into its display label in the current language.
 *
 * The codebase has 7 private near-identical copies of this and ~35 inline
 * `field.options?.find(...)` + ternary sites. New code must use this helper;
 * existing copies migrate opportunistically as files are touched.
 *
 * Options are bilingual at rest (label_ar + label_en are both maintained by
 * the Builder's auto-translation), so this is pure lookup — no AI involved.
 */

import type { ModelField, FieldOption } from '@/types';

/** Find the option whose stored `value` matches. Null when absent. */
export function optionForValue(
  field: Pick<ModelField, 'options'>,
  value: unknown,
): FieldOption | null {
  if (value == null || value === '') return null;
  const v = String(value);
  return field.options?.find((o) => o.value === v) ?? null;
}

/**
 * Display label for one stored option value in the requested language.
 * Falls back to the raw value string when the option no longer exists —
 * a visible signal of a stale reference, never an empty cell.
 */
export function optionLabel(
  field: Pick<ModelField, 'options'>,
  value: unknown,
  isAr: boolean,
): string {
  const opt = optionForValue(field, value);
  if (!opt) return value == null ? '' : String(value);
  return (isAr ? opt.label_ar : opt.label_en) || opt.label_ar || String(value);
}

/** Display labels for a multiselect value (array or scalar). */
export function optionLabelList(
  field: Pick<ModelField, 'options'>,
  value: unknown,
  isAr: boolean,
): string[] {
  const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return values.map((v) => optionLabel(field, v, isAr));
}
