import { describe, it, expect } from 'vitest';
import { unitFits, fitOf } from '../catalog';
import type { FitCheck } from '../search';

const check = (o: Partial<FitCheck>): FitCheck => ({ types: [], strictType: false, checkType: true, bedroomsMin: null, budgetMax: null, requireKnownPrice: true, areaMin: null, ...o });

describe('unit-level catalog fit', () => {
  // A project with 3-bedroom units AND units under 1M, but no 3-bedroom unit
  // under 1M, must not count as a fit — the project-level summary says it does.
  const units = [
    { type: 'شقة', bedrooms: 1, price: 559_000, area: 90 },
    { type: 'شقة', bedrooms: 3, price: 1_250_000, area: 140 },
    { type: 'دور', bedrooms: 3, price: 1_299_000, area: 191 },
    { type: 'فيلا', bedrooms: 5, price: null, area: 380 },
  ];

  it('needs every criterion on the SAME unit', () => {
    const f = check({ types: ['شقة'], bedroomsMin: 3, budgetMax: 1_000_000 });
    expect(units.some((u) => unitFits(u, f))).toBe(false);
  });

  it('quotes the price of what fits, not the project minimum', () => {
    const fit = fitOf(units, check({ types: ['شقة'], bedroomsMin: 3 }));
    expect(fit).toMatchObject({ units: 1, price_from: 1_250_000, area_from: 140, bedrooms: [3] });
  });

  it('a unit with no price never fits a budget, and no type never fits a type', () => {
    expect(unitFits(units[3]!, check({ budgetMax: 5_000_000 }))).toBe(false);
    expect(unitFits({ type: null, bedrooms: 3, price: 900_000, area: 120 }, check({ types: ['شقة'] }))).toBe(false);
  });

  it('gives the cheapest price per room count, so a 2-room price is never quoted for 3 rooms', () => {
    const fit = fitOf(units, check({ checkType: false, budgetMax: 1_300_000 }));
    expect(fit.price_from).toBe(559_000);
    expect(fit.from_by_bedrooms).toEqual({ '1': 559_000, '3': 1_250_000 });
  });

  it('a relaxed rung (type not checked) matches any type', () => {
    expect(fitOf(units, check({ types: ['فيلا'], checkType: false, budgetMax: 1_300_000 })).units).toBe(3);
  });
});
