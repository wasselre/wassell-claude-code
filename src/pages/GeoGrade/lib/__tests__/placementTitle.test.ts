import { describe, it, expect } from 'vitest';
import { placementTitle } from '../placementLine';
import type { DistrictInfo, Placement } from '../shared';

const names: Record<string, DistrictInfo> = {
  d1: { name_ar: 'الربوة', name_en: 'Al Rabwah', city: 'الرياض' },
  d2: { name_ar: 'الملقا', name_en: 'Al Malqa', city: 'الرياض' },
  d3: { name_ar: 'النرجس', name_en: '', city: 'الرياض' },
  d4: { name_ar: 'العارض', name_en: 'Al Arid', city: 'الرياض' },
  r1: { name_ar: 'طريق الملك فهد', name_en: 'King Fahd Road', city: 'الرياض' },
};
const pl = (over: Partial<Placement>): Placement => ({
  polarity: 'include', operation: 'district_polygon', element_ids: ['d1'], resolved: true, label: '', ...over,
});

describe('placementTitle', () => {
  it('one district is just its name — no city, no verb', () => {
    expect(placementTitle(pl({}), names, true)).toBe('الربوة');
    expect(placementTitle(pl({}), names, false)).toBe('Al Rabwah');
  });
  it('falls back to the Arabic name when there is no English one', () => {
    expect(placementTitle(pl({ element_ids: ['d3'] }), names, false)).toBe('النرجس');
  });
  it('a few districts are listed; more than three are summarised with a +count', () => {
    expect(placementTitle(pl({ element_ids: ['d1', 'd2'] }), names, true)).toBe('الربوة، الملقا');
    expect(placementTitle(pl({ element_ids: ['d1', 'd2', 'd3', 'd4'] }), names, true)).toBe('الربوة، الملقا +٢');
    expect(placementTitle(pl({ element_ids: ['d1', 'd2', 'd3', 'd4'] }), names, false)).toBe('Al Rabwah, Al Malqa +2');
  });
  it('a zone is its label and district count, in Arabic digits in Arabic', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `z${i}`);
    expect(placementTitle(pl({ operation: 'zone_union', element_ids: ids, label: 'جنوب الرياض' }), names, true)).toBe('جنوب الرياض · ٢٠ حيًا');
    expect(placementTitle(pl({ operation: 'zone_union', element_ids: ids, label: 'south Riyadh' }), names, false)).toBe('south Riyadh · 20 districts');
  });
  it('a big district union is summarised like a zone', () => {
    const ids = ['d1', 'd2', 'd3', 'd4', 'x5', 'x6', 'x7'];
    expect(placementTitle(pl({ operation: 'district_union', element_ids: ids, label: 'شمال الرياض' }), names, true)).toBe('شمال الرياض · ٧ حيًا');
  });
  it('a side clip is the districts and their part on that side of the road', () => {
    const p = pl({ operation: 'district_side_clip', element_ids: ['d1', 'd2', 'r1'], side: 'north' });
    expect(placementTitle(p, names, true)).toBe('الربوة، الملقا — الجزء الشمالي من طريق الملك فهد');
    expect(placementTitle(p, names, false)).toBe('Al Rabwah, Al Malqa — the part north of King Fahd Road');
  });
  it('a road side shows the side and the band depth, in Arabic digits in Arabic (finding 25)', () => {
    const p = pl({ operation: 'directional_band', element_ids: ['r1'], side: 'west', radius_m: 5000 });
    expect(placementTitle(p, names, true)).toBe('غرب طريق الملك فهد · ٥ كم');
    expect(placementTitle(p, names, false)).toBe('West of King Fahd Road · 5 km');
    expect(placementTitle({ ...p, radius_m: 2500 }, names, true)).toBe('غرب طريق الملك فهد · ٢٫٥ كم');
    // The side comes from the SERVER (placementText.bandSide, the reading the save
    // uses) — the card never re-guesses it from the label (round 3, #22). No side
    // → just the road; the line says it will not be saved.
    expect(placementTitle({ ...p, side: null, label: 'شرق الملك فهد' }, names, true)).toBe('طريق الملك فهد');
  });
  it('a distance rule reads «قرب X · N كم»', () => {
    const p = pl({ operation: 'within_distance', element_ids: ['park'], radius_m: 3000 });
    const n = { ...names, park: { name_ar: 'الرياض بارك', name_en: 'Riyadh Park', city: 'الرياض' } };
    expect(placementTitle(p, n, true)).toBe('قرب الرياض بارك · ٣ كم');
    expect(placementTitle(p, n, false)).toBe('Near Riyadh Park · 3 km');
    expect(placementTitle({ ...p, operation: 'within_radius', radius_m: 12_000 }, n, true)).toBe('قرب الرياض بارك · ١٢ كم');
  });
  it('an unresolved mention is its bare name (element_ids are names, not ids)', () => {
    expect(placementTitle(pl({ resolved: false, element_ids: ['حي الورود'] }), names, true)).toBe('حي الورود');
    expect(placementTitle(pl({ resolved: false, element_ids: [], label: 'قرب الجامعة' }), names, true)).toBe('قرب الجامعة');
  });
  it('an unknown id shows the id rather than nothing', () => {
    expect(placementTitle(pl({ element_ids: ['unknown-id'] }), names, true)).toBe('unknown-id');
  });
});
