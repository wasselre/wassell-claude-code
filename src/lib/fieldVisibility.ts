import type { AppModel, ModelField } from '@/types';

/**
 * Whether a stored field value counts as "present". Numbers (including 0) and
 * booleans (including false) are present; empty strings, empty arrays, and
 * empty objects are not. Used by `isFieldVisible` to never hide a field that
 * already holds data.
 */
function hasMeaningfulValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return true; // number (incl. 0) | boolean (incl. false)
}

/**
 * Field-level conditional visibility for the record form.
 *
 * A field with a `visible_when` rule shows only when the controlling field's
 * current value matches one of the rule's `values` (membership test; the
 * controller value may be a scalar or an array, as with dropdown / multiselect
 * / section_selector). Fields without a rule are always visible.
 *
 * Two fail-open guards keep the rule from ever hiding data:
 *  - a field that already holds a value is always shown (so flipping the
 *    controller never makes the user's existing entry disappear);
 *  - a misconfigured rule (no controller found, empty value list) shows the
 *    field rather than silently swallowing it.
 */
export function isFieldVisible(
  field: ModelField,
  formData: Record<string, unknown>,
  model: AppModel,
): boolean {
  const rule = field.visible_when;
  if (!rule || !rule.field_id || !rule.values || rule.values.length === 0) return true;
  // Never hide a field that already has a value — protects existing records
  // whose controller value predates (or doesn't match) the rule.
  if (hasMeaningfulValue(formData[field.name])) return true;

  const controller = model.schema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.id === rule.field_id);
  if (!controller) return true; // controller deleted/renamed away → fail open

  const allowed = new Set(rule.values);
  const cv = formData[controller.name];
  if (Array.isArray(cv)) {
    return cv.some((v) => (typeof v === 'string' || typeof v === 'number') && allowed.has(String(v)));
  }
  if (typeof cv === 'string' || typeof cv === 'number' || typeof cv === 'boolean') {
    return allowed.has(String(cv));
  }
  return false;
}
