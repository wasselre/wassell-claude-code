import { describe, it, expect } from 'vitest';
import { buildPrefPatch, mergeSetValues, isSameAsSaved, type PrefSuggestionLike } from '../mergePrefs';

const sug = (slug: string, value: unknown): PrefSuggestionLike => ({ slug, value, quote: null, confidence: 80 });
const OPTIONS = {
  preferred_unit_type: ['فيلا', 'شقة', 'دور', 'دبلكس', 'تاون هاوس', 'استوديو', 'ملحق'],
  preferred_amenities: ['مجلس', 'غرفة خادمة', 'غرفة سائق', 'مسبح', 'حوش', 'سطح', 'مصعد'],
  purchase_objective: ['residential', 'investment'],
};

describe('mergeSetValues', () => {
  it('unions, dedups, keeps the saved values, and drops values the schema does not offer', () => {
    const r = mergeSetValues(['شقة'], ['شقة', 'فيلا', 'قصر'], new Set(OPTIONS.preferred_unit_type));
    expect(r.values).toEqual(['شقة', 'فيلا']);
    expect(r.added).toEqual(['فيلا']);
    expect(r.dropped).toEqual(['قصر']);
  });
  it('wraps a bare scalar saved value', () => {
    expect(mergeSetValues('شقة', ['فيلا'], null).values).toEqual(['شقة', 'فيلا']);
  });
});

describe('buildPrefPatch', () => {
  const suggestions = {
    preferred_unit_type: sug('preferred_unit_type', ['فيلا', 'قبو']),
    preferred_amenities: sug('preferred_amenities', ['قبو', 'مسبح']),
    budget: sug('budget', { min: 2000000, max: 3000000 }),
    preferred_area: sug('preferred_area', { max: 400 }),
  };
  const current = {
    client_name: 'x',
    preferred_unit_type: ['دور'],
    budget: { min: 1000000, max: 1500000 },
    preferred_area: { min: 300, max: 500 },
  };

  it('set fields union, unknown values dropped; ranges replace', () => {
    const r = buildPrefPatch(current, suggestions, ['preferred_unit_type', 'preferred_amenities', 'budget'], OPTIONS);
    expect(r.patch).toEqual({
      preferred_unit_type: ['دور', 'فيلا'],
      preferred_amenities: ['مسبح'],
      budget: { min: 2000000, max: 3000000 },
    });
    expect(r.dropped).toEqual([
      { slug: 'preferred_unit_type', value: 'قبو' },
      { slug: 'preferred_amenities', value: 'قبو' },
    ]);
  });
  it('unticked fields are never touched', () => {
    const r = buildPrefPatch(current, suggestions, ['budget'], OPTIONS);
    expect(Object.keys(r.patch)).toEqual(['budget']);
  });
  it('a range replaces even a wider saved one (only the suggested bounds are kept)', () => {
    expect(buildPrefPatch(current, suggestions, ['preferred_area'], OPTIONS).patch).toEqual({ preferred_area: { max: 400 } });
  });
  it('nothing changes ⇒ empty patch; unknown / unsuggested slugs ignored', () => {
    const same = { preferred_unit_type: sug('preferred_unit_type', ['دور']) };
    expect(buildPrefPatch(current, same, ['preferred_unit_type', 'client_name', 'budget'], OPTIONS).patch).toEqual({});
  });
  it('a set field with no options in the schema drops every value', () => {
    const r = buildPrefPatch({}, { purchase_objective: sug('purchase_objective', ['investment']) }, ['purchase_objective'], {});
    expect(r.patch).toEqual({});
    expect(r.dropped).toEqual([{ slug: 'purchase_objective', value: 'investment' }]);
  });
});

describe('isSameAsSaved', () => {
  it('set: every suggested value already saved', () => {
    expect(isSameAsSaved('preferred_unit_type', ['فيلا', 'شقة'], ['فيلا'])).toBe(true);
    expect(isSameAsSaved('preferred_unit_type', ['شقة'], ['فيلا'])).toBe(false);
  });
  it('range: same bounds regardless of key order', () => {
    expect(isSameAsSaved('budget', { max: 3, min: 1 }, { min: 1, max: 3 })).toBe(true);
    expect(isSameAsSaved('budget', null, { min: 1 })).toBe(false);
  });
});
