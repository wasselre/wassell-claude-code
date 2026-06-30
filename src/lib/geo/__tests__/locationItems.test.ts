import { describe, it, expect } from 'vitest';
import {
  parseLocationItems,
  describeLocationItem,
  newDistrictItem,
  newRadiusItem,
  type LocationItem,
} from '../locationItems';

describe('parseLocationItems', () => {
  it('keeps valid district and element_rule items, drops junk', () => {
    const raw = [
      { id: 'a', kind: 'district', polarity: 'include', district_id: 'd1' },
      { id: 'b', kind: 'element_rule', polarity: 'exclude', conditions: [{ rule: 'within_radius', element_id: 'kafd', distance_m: 5000 }] },
      { kind: 'road_directional' }, // unsupported → dropped
      null,
      'nope',
    ];
    const out = parseLocationItems(raw);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.kind)).toEqual(['district', 'element_rule']);
  });
  it('returns [] for non-arrays', () => {
    expect(parseLocationItems(undefined)).toEqual([]);
    expect(parseLocationItems({})).toEqual([]);
    expect(parseLocationItems(null)).toEqual([]);
  });
});

describe('item constructors', () => {
  it('newDistrictItem shape', () => {
    const it = newDistrictItem('d1', 'النرجس', 'include');
    expect(it).toMatchObject({ kind: 'district', polarity: 'include', district_id: 'd1', district_label: 'النرجس' });
    expect(typeof it.id).toBe('string');
  });
  it('newRadiusItem builds a within_radius AND condition', () => {
    const it = newRadiusItem('RUH-BUSI-0658', 'KAFD', 5000, 'include');
    expect(it.kind).toBe('element_rule');
    expect(it.logic).toBe('AND');
    expect(it.conditions).toEqual([{ rule: 'within_radius', element_id: 'RUH-BUSI-0658', distance_m: 5000 }]);
    expect(it.element_label).toBe('KAFD');
  });
});

describe('describeLocationItem (bilingual)', () => {
  const dInc: LocationItem = { id: '1', kind: 'district', polarity: 'include', district_id: 'd', district_label: 'النرجس' };
  const dExc: LocationItem = { id: '2', kind: 'district', polarity: 'exclude', district_id: 'd', district_label: 'العليا' };
  const rInc: LocationItem = { id: '3', kind: 'element_rule', polarity: 'include', conditions: [{ rule: 'within_radius', element_id: 'k', distance_m: 5000 }], element_label: 'KAFD' };
  const rExc: LocationItem = { id: '4', kind: 'element_rule', polarity: 'exclude', conditions: [{ rule: 'within_radius', element_id: 'k', distance_m: 3000 }], element_label: 'KAFD' };

  it('district include/exclude (ar)', () => {
    expect(describeLocationItem(dInc, true)).toBe('حي النرجس');
    expect(describeLocationItem(dExc, true)).toBe('استثناء حي العليا');
  });
  it('within_radius include/exclude with km conversion (ar/en)', () => {
    expect(describeLocationItem(rInc, true)).toBe('ضمن 5 كم من KAFD');
    expect(describeLocationItem(rExc, false)).toBe('Outside 3 km of KAFD');
  });

  const mk = (rule: string, label: string, extra: Record<string, unknown> = {}): LocationItem => ({
    id: 'x', kind: 'element_rule', polarity: 'include',
    conditions: [{ rule, element_id: 'e', ...extra }] as never, element_label: label,
  });

  it('within_distance (line/polygon) reads like within km (ar/en)', () => {
    expect(describeLocationItem(mk('within_distance', 'طريق الملك سلمان', { distance_m: 3000 }), true)).toBe('ضمن 3 كم من طريق الملك سلمان');
    expect(describeLocationItem(mk('within_distance', 'King Salman Road', { distance_m: 3000 }), false)).toBe('Within 3 km of King Salman Road');
  });
  it('inside_area include vs exclude (ar/en)', () => {
    expect(describeLocationItem(mk('inside_area', 'واجهة الرياض'), true)).toBe('داخل واجهة الرياض');
    expect(describeLocationItem({ ...mk('inside_area', 'Riyadh Front'), polarity: 'exclude' }, false)).toBe('Outside Riyadh Front');
  });
  it('directional N/S/E/W (ar/en) and exclude negation', () => {
    expect(describeLocationItem(mk('north_of', 'طريق الملك سلمان'), true)).toBe('شمال طريق الملك سلمان');
    expect(describeLocationItem(mk('south_of', 'King Salman Road'), false)).toBe('South of King Salman Road');
    expect(describeLocationItem(mk('east_of', 'طريق الملك فهد'), true)).toBe('شرق طريق الملك فهد');
    expect(describeLocationItem(mk('west_of', 'King Fahd Road'), false)).toBe('West of King Fahd Road');
    expect(describeLocationItem({ ...mk('north_of', 'الطريق الدائري'), polarity: 'exclude' }, true)).toBe('ليس شمال الطريق الدائري');
  });
});
