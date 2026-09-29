import { describe, it, expect } from 'vitest';
import { lookupFilterPredicate, lookupFilterDefaults } from '../lookupFilter';

const marketerField = { lookup_filter: { field: 'company_type', value: 'marketer' } };
const rec = (data: Record<string, unknown>) => ({ data });

describe('lookup_filter', () => {
  it('keeps only matching companies', () => {
    const pass = lookupFilterPredicate(marketerField)!;
    expect(pass(rec({ name: 'Riva', company_type: 'marketer' }))).toBe(true);
    expect(pass(rec({ name: 'Al Ramz', company_type: 'developer' }))).toBe(false);
    expect(pass(rec({ name: 'Untyped' }))).toBe(false);
  });
  it('matches a multi-value target field by membership', () => {
    const pass = lookupFilterPredicate({ lookup_filter: { field: 'tags', value: 'vip' } })!;
    expect(pass(rec({ tags: ['vip', 'new'] }))).toBe(true);
    expect(pass(rec({ tags: ['new'] }))).toBe(false);
  });
  it('is absent when the field has no filter', () => {
    expect(lookupFilterPredicate({})).toBeUndefined();
    expect(lookupFilterPredicate({ lookup_filter: null })).toBeUndefined();
    expect(lookupFilterDefaults({})).toBeUndefined();
  });
  it('gives an inline-created record the filtered value', () => {
    expect(lookupFilterDefaults(marketerField)).toEqual({ company_type: 'marketer' });
  });
});
