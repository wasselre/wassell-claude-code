import { describe, it, expect } from 'vitest';
import { resolveUnitView, sortUnits, bestUnitBy, type UnitView } from '../unitView';
import type { ProjectStoreSlices } from '../projectView';
import type { AppModel, AppRecord } from '@/types';

function store(): ProjectStoreSlices {
  const units: AppModel = {
    id: 'units-model', name: 'units', label_ar: '', label_en: 'Units', icon: '', color: '#8E4E3A',
    schema: {
      sections: [{
        id: 's', label_ar: '', label_en: 'Basic', order: 0, is_base: true,
        fields: [
          { id: 'f_proj', name: 'project_id', label_ar: '', label_en: 'Project', type: 'lookup', required: false, order: 0, section_id: 's', lookup_model_id: 'ap', lookup_display_field: 'project_name' },
          { id: 'f_type', name: 'unit_type', label_ar: '', label_en: 'Type', type: 'dropdown', required: false, order: 1, section_id: 's', options: [{ id: 'o', value: 'apartment', label_ar: 'شقة', label_en: 'Apartment' }] },
          { id: 'f_status', name: 'unit_status', label_ar: '', label_en: 'Status', type: 'dropdown', required: false, order: 2, section_id: 's', options: [{ id: 'o2', value: 'available', label_ar: 'متاحة', label_en: 'Available', color: '#10B981' }] },
        ],
      }],
    },
    card_config: { title_field_id: null, shown_field_ids: [] }, maps_config: {} as AppModel['maps_config'],
    is_system: true, created_at: '', updated_at: '',
  } as AppModel;
  return { models: [units], records: {} };
}

function unit(id: string, data: Record<string, unknown>, createdAt = '2026-01-01'): AppRecord {
  return { id, model_id: 'units-model', data, created_at: createdAt, updated_at: createdAt } as AppRecord;
}

describe('resolveUnitView', () => {
  it('computes price/m² and resolves options', () => {
    const v = resolveUnitView(store(), unit('u1', { unit_code: 'U-0001', unit_type: 'apartment', unit_status: 'available', unit_area: 100, total_price: 900000, bedrooms: 3 }));
    expect(v.code).toBe('U-0001');
    expect(v.type?.label_en).toBe('Apartment');
    expect(v.status?.color).toBe('#10B981');
    expect(v.area).toBe(100);
    expect(v.totalPrice).toBe(900000);
    expect(v.pricePerM2).toBe(9000); // 900000 / 100
    expect(v.bedrooms).toBe(3);
  });

  it('leaves missing facts null and does not divide by zero', () => {
    const v = resolveUnitView(store(), unit('u2', { unit_area: 0, total_price: 500000 }));
    expect(v.code).toBeNull();
    expect(v.type).toBeNull();
    expect(v.bedrooms).toBeNull();
    expect(v.pricePerM2).toBeNull(); // area 0 → not computable, never Infinity
  });
});

describe('sortUnits (deterministic)', () => {
  const s = store();
  const units: UnitView[] = [
    resolveUnitView(s, unit('a', { unit_area: 100, total_price: 1000000 }, '2026-01-01')), // /m² 10000
    resolveUnitView(s, unit('b', { unit_area: 200, total_price: 1600000 }, '2026-03-01')), // /m² 8000
    resolveUnitView(s, unit('c', { unit_area: 50, total_price: 600000 }, '2026-02-01')),  // /m² 12000
  ];
  it('cheapest, largest, best_per_m2, newest are stable and correct', () => {
    expect(sortUnits(units, 'cheapest').map((u) => u.id)).toEqual(['c', 'a', 'b']);
    expect(sortUnits(units, 'largest').map((u) => u.id)).toEqual(['b', 'a', 'c']);
    expect(sortUnits(units, 'best_per_m2').map((u) => u.id)).toEqual(['b', 'a', 'c']);
    expect(sortUnits(units, 'newest').map((u) => u.id)).toEqual(['b', 'c', 'a']);
    // determinism: same input → identical output
    expect(sortUnits(units, 'cheapest').map((u) => u.id)).toEqual(sortUnits(units, 'cheapest').map((u) => u.id));
  });
});

describe('bestUnitBy', () => {
  const s = store();
  const units = [
    resolveUnitView(s, unit('a', { unit_area: 100, total_price: 1000000 })),
    resolveUnitView(s, unit('b', { unit_area: 200, total_price: 1600000 })),
    resolveUnitView(s, unit('miss', {})), // no price/area — must be skipped, never chosen
  ];
  it('picks the deterministic best and ignores units missing the value', () => {
    expect(bestUnitBy(units, (u) => u.totalPrice, 'min')).toBe('a');
    expect(bestUnitBy(units, (u) => u.area, 'max')).toBe('b');
    expect(bestUnitBy(units, (u) => u.pricePerM2, 'min')).toBe('b'); // 8000 < 10000
    expect(bestUnitBy([units[2]!], (u) => u.totalPrice, 'min')).toBeNull(); // all missing
  });
});
