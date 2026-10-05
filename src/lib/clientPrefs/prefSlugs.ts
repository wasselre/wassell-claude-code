/**
 * The client-preference fields the follow-up flow edits, in their sections
 * (operator, 2026-10-05):
 *   1. Geographic — the location field (city cascade + places).
 *   2. Basic — unit type, bedrooms, budget, purchase goal.
 *   3. Advanced (collapsed) — the rest the matcher can use.
 * Unit age (preferred_max_unit_age) is deliberately absent: hidden from the
 * editor and left out of every save patch, so a stored value is untouched.
 */
export const GEO_PREF_SLUGS = ['location'] as const;
export const BASIC_PREF_SLUGS = ['preferred_unit_type', 'preferred_bedrooms', 'budget', 'purchase_objective'] as const;
export const ADVANCED_PREF_SLUGS = ['preferred_readiness', 'preferred_area', 'preferred_amenities', 'preference_notes'] as const;
export const EDITABLE_PREF_SLUGS = [...GEO_PREF_SLUGS, ...BASIC_PREF_SLUGS, ...ADVANCED_PREF_SLUGS] as const;

/** Riyadh — the default city when a client has none. The same country / region /
 *  city record ids 124 clients already carry. */
export const RIYADH_LOCATION = {
  country: ['d15a0003-0000-4000-8000-000000000001'],
  region: ['9c0c7a82-738d-6456-2101-b7226cc84e20'],
  city: ['44254a38-ce40-938f-17b7-55814a44e45c'],
};
