/**
 * TWIN of `api/_lib/constraints.ts` — per-field match strictness.
 *
 * The API package cannot be imported from the SPA build, so the types, the
 * defaults, and the band math are MIRRORED here (same posture as the
 * projectFinder.ts type mirror). CHANGE BOTH FILES TOGETHER — a drift means the
 * control the rep sees promises a band the engine doesn't apply.
 *
 * This file adds the bilingual labels the finder UIs render; the API twin has
 * no UI concerns and carries none.
 */

export type ConstraintField =
  | 'budget'
  | 'area'
  | 'bedrooms'
  | 'bathrooms'
  | 'unit_age'
  | 'property_type'
  | 'amenities';

export const CONSTRAINT_FIELDS: ConstraintField[] = [
  'budget', 'area', 'bedrooms', 'bathrooms', 'unit_age', 'property_type', 'amenities',
];

export type ConstraintMode = 'soft' | 'hard';

export interface FieldConstraint {
  mode: ConstraintMode;
  /** Band widening as a FRACTION (0.1 = ±10%). */
  tolerance_pct?: number;
}

export type RequirementConstraints = Partial<Record<ConstraintField, FieldConstraint>>;

/** MIRROR of the API defaults — see the twin for the rationale per field. */
export const DEFAULT_CONSTRAINTS: Record<ConstraintField, FieldConstraint> = {
  budget: { mode: 'hard', tolerance_pct: 0.15 },
  area: { mode: 'hard', tolerance_pct: 0.15 },
  bedrooms: { mode: 'hard', tolerance_pct: 0 },
  bathrooms: { mode: 'hard', tolerance_pct: 0 },
  unit_age: { mode: 'hard', tolerance_pct: 0 },
  property_type: { mode: 'hard' },
  amenities: { mode: 'soft' },
};

export const BANDED_FIELDS: ConstraintField[] = ['budget', 'area', 'bedrooms', 'bathrooms', 'unit_age'];
export const MAX_TOLERANCE_PCT = 0.5;

/** The clients-model field slug each constraint attaches to, so the finder UIs
 *  can render the control directly under the matching picker. `bedrooms` has no
 *  clients-model field on the standalone page (it's a local select) — both
 *  surfaces handle it explicitly. */
export const CONSTRAINT_BY_SLUG: Record<string, ConstraintField> = {
  budget: 'budget',
  preferred_area: 'area',
  preferred_bedrooms: 'bedrooms',
  preferred_bathrooms: 'bathrooms',
  preferred_max_unit_age: 'unit_age',
  preferred_unit_type: 'property_type',
  preferred_amenities: 'amenities',
};

export const CONSTRAINT_LABELS: Record<ConstraintField, { ar: string; en: string }> = {
  budget: { ar: 'الميزانية', en: 'Budget' },
  area: { ar: 'المساحة', en: 'Area' },
  bedrooms: { ar: 'الغرف', en: 'Bedrooms' },
  bathrooms: { ar: 'دورات المياه', en: 'Bathrooms' },
  unit_age: { ar: 'عمر العقار', en: 'Unit age' },
  property_type: { ar: 'نوع العقار', en: 'Unit type' },
  amenities: { ar: 'المميزات', en: 'Amenities' },
};

export const MODE_LABELS: Record<ConstraintMode, { ar: string; en: string; hint_ar: string; hint_en: string }> = {
  hard: {
    ar: 'إلزامي',
    en: 'Required',
    hint_ar: 'يُستبعد أي خيار خارج النطاق (والخيارات بدون بيانات لهذا الحقل).',
    hint_en: 'Excludes anything outside the band — and anything with no data for this field.',
  },
  soft: {
    ar: 'مفضّل',
    en: 'Preferred',
    hint_ar: 'لا يستبعد شيئاً — يؤثر على الترتيب فقط.',
    hint_en: 'Never excludes — only affects ranking.',
  },
};

/** Tolerance presets offered in the UI (fraction → label). */
export const TOLERANCE_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0, label: '0%' },
  { value: 0.05, label: '±5%' },
  { value: 0.1, label: '±10%' },
  { value: 0.15, label: '±15%' },
  { value: 0.25, label: '±25%' },
  { value: 0.5, label: '±50%' },
];

export function resolveConstraint(
  field: ConstraintField,
  constraints?: RequirementConstraints | null,
): Required<FieldConstraint> {
  const def = DEFAULT_CONSTRAINTS[field];
  const given = constraints?.[field];
  const mode: ConstraintMode = given?.mode === 'soft' || given?.mode === 'hard' ? given.mode : def.mode;
  const rawTol = given?.tolerance_pct ?? def.tolerance_pct ?? 0;
  const tolerance_pct = Number.isFinite(rawTol) ? Math.min(Math.max(rawTol, 0), MAX_TOLERANCE_PCT) : 0;
  return { mode, tolerance_pct };
}

/** True when the rep has changed a field away from its default (drives the
 *  "modified" affordance + the reset action). */
export function isNonDefault(field: ConstraintField, c?: RequirementConstraints | null): boolean {
  const eff = resolveConstraint(field, c);
  const def = resolveConstraint(field, null);
  return eff.mode !== def.mode || eff.tolerance_pct !== def.tolerance_pct;
}
