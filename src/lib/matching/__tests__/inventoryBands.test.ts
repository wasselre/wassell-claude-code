import { describe, it, expect } from 'vitest';
import {
  inventoryBand, missingCorePrefs, hasAnyCriteria, NARROW_MAX, BROAD_MIN,
} from '../inventoryBands';
import type { MatchRequirementsInput } from '../requirements';

describe('inventoryBand', () => {
  it('maps counts to the documented bands', () => {
    expect(inventoryBand(0)).toBe('zero');
    expect(inventoryBand(1)).toBe('narrow');
    expect(inventoryBand(NARROW_MAX)).toBe('narrow');
    expect(inventoryBand(NARROW_MAX + 1)).toBe('healthy');
    expect(inventoryBand(BROAD_MIN - 1)).toBe('healthy');
    expect(inventoryBand(BROAD_MIN)).toBe('broad');
    expect(inventoryBand(100)).toBe('broad');
  });

  it('treats negatives as zero (defensive)', () => {
    expect(inventoryBand(-5)).toBe('zero');
  });
});

describe('missingCorePrefs', () => {
  it('lists all three when nothing is set, in stable order', () => {
    expect(missingCorePrefs({})).toEqual(['location', 'budget', 'unit_type']);
  });

  it('drops location when any location signal is present', () => {
    expect(missingCorePrefs({ cities: ['الرياض'] })).toEqual(['budget', 'unit_type']);
    expect(missingCorePrefs({ district_ids: ['d1'] })).toEqual(['budget', 'unit_type']);
    expect(missingCorePrefs({ district: 'النرجس' })).toEqual(['budget', 'unit_type']);
  });

  it('drops budget when either bound is present', () => {
    expect(missingCorePrefs({ budget_max: 1_500_000 })).toEqual(['location', 'unit_type']);
    expect(missingCorePrefs({ budget_min: 500_000 })).toEqual(['location', 'unit_type']);
  });

  it('drops unit_type when a type is present', () => {
    expect(missingCorePrefs({ property_types: ['شقة'] })).toEqual(['location', 'budget']);
    expect(missingCorePrefs({ property_type: 'فيلا' })).toEqual(['location', 'budget']);
  });

  it('returns empty when all three cores are set', () => {
    const req: MatchRequirementsInput = { cities: ['الرياض'], budget_max: 2_000_000, property_types: ['دور'] };
    expect(missingCorePrefs(req)).toEqual([]);
  });

  it('area/bedrooms alone do NOT satisfy any core (they are secondary)', () => {
    expect(missingCorePrefs({ area_min: 200, bedrooms: 3 })).toEqual(['location', 'budget', 'unit_type']);
  });
});

describe('hasAnyCriteria', () => {
  it('is false for an empty draft', () => {
    expect(hasAnyCriteria({})).toBe(false);
  });

  it('is true for any single matchable signal', () => {
    expect(hasAnyCriteria({ city: 'الرياض' })).toBe(true);
    expect(hasAnyCriteria({ budget_min: 500_000 })).toBe(true);
    expect(hasAnyCriteria({ area_max: 300 })).toBe(true);
    expect(hasAnyCriteria({ bedrooms: 2 })).toBe(true);
    expect(hasAnyCriteria({ property_types: ['شقة'] })).toBe(true);
    expect(hasAnyCriteria({ amenities: ['مسبح'] })).toBe(true);
  });
});
