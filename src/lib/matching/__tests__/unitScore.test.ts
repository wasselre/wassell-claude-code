import { describe, it, expect } from 'vitest';
import { scoreUnit, rankUnits } from '../unitScore';
import type { UnitView } from '@/lib/projects/unitView';
import type { AppRecord } from '@/types';
import type { OptionView } from '@/lib/projects/projectView';

const opt = (value: string, ar = value, en = value): OptionView => ({ value, label_ar: ar, label_en: en, color: null });

/** Minimal UnitView factory — only the fields the scorer reads matter. */
function u(p: Partial<UnitView>): UnitView {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    raw: {} as unknown as AppRecord,
    projectId: 'proj',
    code: p.code ?? 'U-1',
    developerCode: null,
    unitNumber: p.unitNumber ?? null,
    model: null,
    developer: null,
    type: p.type ?? null,
    status: p.status ?? opt('available', 'متاح', 'Available'),
    bedrooms: p.bedrooms ?? null,
    bathrooms: p.bathrooms ?? null,
    floor: null,
    area: p.area ?? null,
    privateArea: null,
    totalArea: null,
    yardArea: null,
    deedArea: null,
    totalPrice: p.totalPrice ?? null,
    pricePerM2: p.pricePerM2 ?? (p.totalPrice != null && p.area ? Math.round(p.totalPrice / p.area) : null),
    components: [],
    facade: [],
    parking: [],
    elevator: null,
    building: null,
    block: null,
    streetWidth: null,
    planImage: null,
    unitBrochure: null,
    projectBrochure: null,
    locationLink: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('scoreUnit', () => {
  it('scores an in-budget, right-type, enough-beds available unit as strong', () => {
    const s = scoreUnit(
      u({ totalPrice: 900_000, area: 200, bedrooms: 4, type: opt('villa', 'فيلا', 'Villa') }),
      { budget_min: 800_000, budget_max: 1_000_000, area_min: 150, area_max: 250, bedrooms: 3, property_types: ['فيلا'] },
    );
    expect(s.score).toBeGreaterThanOrEqual(80);
    expect(s.band).toBe('strong');
    expect(s.breakdown.budget).toBe(1);
    expect(s.breakdown.type).toBe(1);
  });

  it('caps the band at partial when a requested type does not match', () => {
    const s = scoreUnit(
      u({ totalPrice: 900_000, area: 200, bedrooms: 5, type: opt('apartment', 'شقة', 'Apartment') }),
      { budget_min: 800_000, budget_max: 1_000_000, bedrooms: 3, property_types: ['فيلا'] },
    );
    expect(s.breakdown.type).toBe(0);
    expect(s.band).toBe('partial');
  });

  it('over-budget within 10% is a stretch (0.5), far over is 0', () => {
    const stretch = scoreUnit(u({ totalPrice: 1_050_000 }), { budget_max: 1_000_000 });
    expect(stretch.breakdown.budget).toBe(0.5);
    const over = scoreUnit(u({ totalPrice: 2_000_000 }), { budget_max: 1_000_000 });
    expect(over.breakdown.budget).toBe(0);
  });

  it('treats bedrooms as AT-LEAST (more is fine, one-under is a near-miss)', () => {
    expect(scoreUnit(u({ bedrooms: 5 }), { bedrooms: 4 }).breakdown.bedrooms).toBe(1);
    expect(scoreUnit(u({ bedrooms: 3 }), { bedrooms: 4 }).breakdown.bedrooms).toBe(0.6);
    expect(scoreUnit(u({ bedrooms: 2 }), { bedrooms: 4 }).breakdown.bedrooms).toBe(0);
  });

  it('a requested field with no data earns 0 (kept in the average), not dropped', () => {
    const s = scoreUnit(u({ totalPrice: null }), { budget_max: 1_000_000 });
    expect(s.breakdown.budget).toBe(0);
  });
});

describe('rankUnits', () => {
  it('excludes sold units and returns the best `limit`, cheapest breaking ties', () => {
    const units = [
      u({ id: 'sold', totalPrice: 500_000, status: opt('sold', 'مباع', 'Sold') }),
      u({ id: 'cheap', totalPrice: 800_000, status: opt('available') }),
      u({ id: 'mid', totalPrice: 900_000, status: opt('available') }),
      u({ id: 'dear', totalPrice: 1_000_000, status: opt('available') }),
    ];
    const ranked = rankUnits(units, {}, 3);
    expect(ranked.map((r) => r.unit.id)).not.toContain('sold');
    expect(ranked).toHaveLength(3);
    // No budget criteria → all available tie on score; cheapest first.
    expect(ranked[0]!.unit.id).toBe('cheap');
  });

  it('ranks a better-fitting unit above a cheaper worse-fitting one', () => {
    const units = [
      u({ id: 'cheap_wrong', totalPrice: 400_000, type: opt('apartment', 'شقة', 'Apartment') }),
      u({ id: 'fit_villa', totalPrice: 950_000, type: opt('villa', 'فيلا', 'Villa') }),
    ];
    const ranked = rankUnits(units, { property_types: ['فيلا'], budget_max: 1_000_000 }, 3);
    expect(ranked[0]!.unit.id).toBe('fit_villa');
  });
});
