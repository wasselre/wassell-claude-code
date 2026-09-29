import { describe, it, expect } from 'vitest';
import { projectFits, type FitCheck } from '../search.js';

// The two live projects from the 2026-09-29 test: an apartment ask got أكنان 25
// (no apartments) while ريّا النخيل (apartments, 1–3 bedrooms) was available.
const AKNAN_25 = {
  unit_types: ['floor', 'penthouse', 'townhouse', 'villa'],
  bedroom_range: { min: 1, max: 4 }, available_price_range: { min: 1050000, max: 3200000 }, available_units: 44,
};
const RIYA_ALNAKHEEL = {
  unit_types: ['apartment'],
  bedroom_range: { min: 1, max: 3 }, available_price_range: { min: 1279112, max: 1599000 }, available_units: 32,
};

const F = (o: Partial<FitCheck> = {}): FitCheck =>
  ({ types: ['شقة'], strictType: true, checkType: true, bedroomsMin: 3, budgetMax: null, ...o });

describe('projectFits — the project\'s own data must match the ask', () => {
  it('rejects a project without the asked unit type', () => {
    expect(projectFits(AKNAN_25, F())).toBe(false);
    expect(projectFits(RIYA_ALNAKHEEL, F())).toBe(true);
  });
  it('reads Arabic and plural type labels', () => {
    expect(projectFits({ unit_types: ['شقق'] }, F({ bedroomsMin: null }))).toBe(true);
    expect(projectFits({ unit_types: ['villas', 'فلل'] }, F({ types: ['فيلا'], bedroomsMin: null }))).toBe(true);
  });
  it('unrecorded type: rejected only in the strict pass', () => {
    expect(projectFits({ unit_types: [] }, F({ bedroomsMin: null }))).toBe(false);
    expect(projectFits({ unit_types: [] }, F({ bedroomsMin: null, strictType: false }))).toBe(true);
    expect(projectFits({ unit_types: ['سكني'] }, F({ bedroomsMin: null, strictType: false }))).toBe(true);
  });
  it('checks bedrooms and the AVAILABLE price, and passes on missing data', () => {
    expect(projectFits(RIYA_ALNAKHEEL, F({ bedroomsMin: 4 }))).toBe(false);
    expect(projectFits(RIYA_ALNAKHEEL, F({ budgetMax: 1_000_000 }))).toBe(false);
    expect(projectFits(RIYA_ALNAKHEEL, F({ budgetMax: 1_300_000 }))).toBe(true);
    expect(projectFits({ unit_types: ['apartment'] }, F({ budgetMax: 900_000 }))).toBe(true);
  });
  it('checks the minimum size against AVAILABLE units', () => {
    const d = { ...RIYA_ALNAKHEEL, available_area_range: { min: 98, max: 136 } };
    expect(projectFits(d, F({ areaMin: 150 }))).toBe(false);
    expect(projectFits(d, F({ areaMin: 120 }))).toBe(true);
    expect(projectFits(RIYA_ALNAKHEEL, F({ areaMin: 150 }))).toBe(true); // unknown size passes
  });
  it('with a budget, an unknown price only passes when not required', () => {
    expect(projectFits({ unit_types: ['apartment'] }, F({ budgetMax: 900_000, requireKnownPrice: true }))).toBe(false);
  });
  it('never offers a sold-out project', () => {
    expect(projectFits({ ...RIYA_ALNAKHEEL, available_units: 0 }, F())).toBe(false);
  });
  it('the any-type rung ignores type but keeps bedrooms', () => {
    expect(projectFits(AKNAN_25, F({ checkType: false }))).toBe(true);
    expect(projectFits(AKNAN_25, F({ checkType: false, bedroomsMin: 5 }))).toBe(false);
  });
});
