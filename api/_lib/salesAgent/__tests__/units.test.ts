import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const unit = (id: string, d: Record<string, unknown>) => ({ id, data: { unit_status: 'available', ...d } });
const UNITS = [
  unit('u1', { unit_code: 'U-1', unit_type: 'شقة', bedrooms: 2, unit_area: 112.96, total_price: 1_101_400, floor: 'ارضي' }),
  unit('u2', { unit_code: 'U-2', unit_type: 'شقة', bedrooms: 3, unit_area: 136, total_price: 1_302_645, floor: 'اول' }),
  unit('u3', { unit_code: 'U-3', unit_type: 'شقة', bedrooms: 3, unit_area: 156, total_price: 1_441_890, floor: 'اول' }),
  unit('u4', { unit_code: 'U-4', unit_type: 'تاون هاوس', bedrooms: 4, unit_area: 209, total_price: 1_877_555, floor: null }),
  unit('u5', { unit_code: 'U-5', unit_type: 'شقة', bedrooms: 3, unit_area: 140, total_price: null, floor: 'الروف' }),
];

vi.mock('../../trackedLinks.js', async () => {
  const actual = await vi.importActual<typeof import('../../trackedLinks.js')>('../../trackedLinks.js');
  return { ...actual, loadAvailableUnits: vi.fn(async () => UNITS) };
});

const { searchUnits, normalizeFloor, unitSearchView } = await import('../units');
const svc = {} as SupabaseClient;

describe('normalizeFloor', () => {
  it('folds the ways a floor is written', () => {
    expect(normalizeFloor('الأرضي')).toBe('ارضي');
    expect(normalizeFloor('ground')).toBe('ارضي');
    expect(normalizeFloor('الدور الأول')).toBe('اول');
    expect(normalizeFloor('الروف')).toBe('روف');
    expect(normalizeFloor('4')).toBe('4');
    expect(normalizeFloor(null)).toBe('');
  });
});

describe('searchUnits', () => {
  it('filters by bedrooms and budget, cheapest first', async () => {
    const r = await searchUnits(svc, 'p', { bedrooms: 3, budget_max: 1_500_000 });
    expect(r.total_available).toBe(5);
    expect(r.matchedIds).toEqual(['u2', 'u3']);
  });

  it('a unit with no price never fits a budget, but shows without one', async () => {
    expect((await searchUnits(svc, 'p', { bedrooms: 3, budget_max: 5_000_000 })).matchedIds).not.toContain('u5');
    expect((await searchUnits(svc, 'p', { bedrooms: 3 })).matchedIds).toContain('u5');
  });

  it('matches type and floor as the customer says them', async () => {
    expect((await searchUnits(svc, 'p', { unit_type: 'تاون هاوس' })).matchedIds).toEqual(['u4']);
    expect((await searchUnits(svc, 'p', { floor: 'الأرضي' })).matchedIds).toEqual(['u1']);
    expect((await searchUnits(svc, 'p', { floor: 'roof' })).matchedIds).toEqual(['u5']);
  });

  it('no match still reports what the project has', async () => {
    const r = await searchUnits(svc, 'p', { bedrooms: 5 });
    expect(r.matched).toBe(0);
    expect(r.facets.bedrooms).toEqual({ '2': 1, '3': 3, '4': 1 });
    expect(r.facets.price_min).toBe(1_101_400);
    expect(r.facets.price_max).toBe(1_877_555);
  });

  it('the model view uses whole metres', async () => {
    const v = unitSearchView(await searchUnits(svc, 'p', { bedrooms: 2 })) as { units: Array<{ area_m2: number; unit_id: string }> };
    expect(v.units[0]).toMatchObject({ unit_id: 'u1', area_m2: 113 });
  });
});
