/**
 * Per-field MATCH CONSTRAINTS — how strictly each requirement is enforced.
 *
 * Before this existed, every numeric/categorical requirement was a SOFT scoring
 * dimension: a candidate could miss a field completely and still rank high
 * because the other dimensions carried it (a 125 m² villa scored 89% against a
 * 500–750 m² request, because area is only 10 of the ~90 applicable weight).
 * Meanwhile the market DB pre-filter cut HARD on budget/bedrooms/type/age
 * regardless of intent — the worst of both worlds: fields the rep cared about
 * couldn't exclude anything, and fields they hadn't thought about silently did.
 *
 * Now every constrainable field carries an explicit contract:
 *   - mode 'hard' → a candidate outside the band is EXCLUDED (never scored).
 *   - mode 'soft' → the field only influences the SCORE (the old behavior).
 *   - tolerance_pct → widens the accepted band on BOTH sides before the
 *     hard test, so "500–750 m², ±10%" accepts 450–825.
 *
 * The band widens INCLUSION only. Scoring is unchanged: a candidate inside the
 * tolerance band but outside the exact request still earns the reduced subscore
 * it always did, so ranking still prefers exact fits. Gate = who's allowed in,
 * score = what order they sit in.
 *
 * TWIN FILE: `src/lib/matching/constraints.ts` mirrors these types + defaults for
 * the SPA (the finder UIs render one control per field from CONSTRAINT_FIELDS).
 * The API cannot import from src, so CHANGE BOTH TOGETHER — same posture as
 * `worker/src/imageGen.ts`.
 */

/** Requirement fields whose strictness the rep can control. Location is absent
 *  on purpose: it is ALREADY a hard gate (the PostGIS `location_items` geo gate),
 *  and its "softness" is expressed by the four location-centric result groups. */
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

/** 'hard' = exclude candidates outside the (tolerance-widened) band.
 *  'soft' = score only; never excludes. */
export type ConstraintMode = 'soft' | 'hard';

export interface FieldConstraint {
  mode: ConstraintMode;
  /** Band widening as a FRACTION (0.1 = ±10%). Applied to both sides of a range,
   *  to the minimum of an at-least field, and to the maximum of an at-most field.
   *  Ignored for categorical fields (property_type / amenities). */
  tolerance_pct?: number;
}

export type RequirementConstraints = Partial<Record<ConstraintField, FieldConstraint>>;

/**
 * Defaults when the caller says nothing. Chosen to match what a salesperson
 * means by a stated requirement, and to preserve the pre-filter's narrowing
 * (which the 4,000-listing scan cap depends on):
 *   - budget ±15%  — the long-standing "stretch" band, now symmetric.
 *   - area   ±15%  — a near-miss on size is negotiable; 125 vs 500 is not.
 *   - bedrooms / bathrooms — AT-LEAST, exact (more is fine, fewer is not).
 *   - unit_age — AT-MOST, exact.
 *   - property_type — hard: a villa request must not return apartments.
 *   - amenities — SOFT by default (a wish list, not a filter). The finder UIs'
 *     "must have" toggle promotes it to hard, same as `required_amenities`.
 */
export const DEFAULT_CONSTRAINTS: Record<ConstraintField, FieldConstraint> = {
  budget: { mode: 'hard', tolerance_pct: 0.15 },
  area: { mode: 'hard', tolerance_pct: 0.15 },
  bedrooms: { mode: 'hard', tolerance_pct: 0 },
  bathrooms: { mode: 'hard', tolerance_pct: 0 },
  unit_age: { mode: 'hard', tolerance_pct: 0 },
  property_type: { mode: 'hard' },
  amenities: { mode: 'soft' },
};

/** Fields where a tolerance band is meaningful (numeric). Categorical fields
 *  render mode-only in the UI. */
export const BANDED_FIELDS: ConstraintField[] = ['budget', 'area', 'bedrooms', 'bathrooms', 'unit_age'];

/** Largest tolerance the UI offers / the server accepts. A band beyond this
 *  stops meaning "about this size" and silently reintroduces the soft-filter
 *  problem under a hard-looking label. */
export const MAX_TOLERANCE_PCT = 0.5;

/** The effective constraint for one field: caller value over default, clamped. */
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

/** Widen a [lo, hi] request band by the tolerance. Either side may be null
 *  (open-ended). Returns the bounds the HARD test uses. */
export function widenBand(
  lo: number | null | undefined,
  hi: number | null | undefined,
  tolerancePct: number,
): { lo: number | null; hi: number | null } {
  return {
    lo: lo != null ? lo * (1 - tolerancePct) : null,
    hi: hi != null ? hi * (1 + tolerancePct) : null,
  };
}

/** True when a candidate's [min,max] span overlaps the widened request band.
 *  Overlap (not containment): a project offering 300–800 m² satisfies a
 *  500–750 m² request because it HAS units in range. */
export function spanPassesBand(
  candMin: number | null,
  candMax: number | null,
  reqLo: number | null,
  reqHi: number | null,
  tolerancePct: number,
): boolean {
  if (candMin == null && candMax == null) return false; // no data ⇒ fails closed
  const lo = candMin ?? candMax!;
  const hi = candMax ?? candMin!;
  const band = widenBand(reqLo, reqHi, tolerancePct);
  if (band.lo != null && hi < band.lo) return false;
  if (band.hi != null && lo > band.hi) return false;
  return true;
}
