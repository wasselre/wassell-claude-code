import { describe, it, expect } from 'vitest';
import { requestedPlaces } from '../requestData';
import { describeAsk } from '@/lib/officeOutreach/message';

const ring = [[46.7, 24.7], [46.8, 24.7], [46.8, 24.8], [46.7, 24.7]];

describe('requestedPlaces', () => {
  it('takes the district names out of a drawn area’s coverage label, and «+N» means more', () => {
    const r = requestedPlaces({ location_items: [
      { id: 'a', kind: 'drawn_area', polarity: 'include', coordinates: ring, label: 'منطقة مرسومة: اشبيلية، الازدهار، الاندلس +20' },
    ] });
    expect(r).toEqual({ places: ['اشبيلية', 'الازدهار', 'الاندلس'], more: true });
    expect(describeAsk({ unitTypes: ['شقة'], places: r.places, morePlaces: r.more })).toBe('شقة في اشبيلية، الازدهار، الاندلس وغيرها');
  });

  it('skips excluded items and drawings without names', () => {
    const r = requestedPlaces({ location_items: [
      { id: 'x', kind: 'drawn_area', polarity: 'exclude', coordinates: ring, label: 'منطقة مستثناة: النرجس' },
      { id: 'b', kind: 'drawn_area', polarity: 'include', coordinates: ring, label: 'منطقة مرسومة 1' },
      { id: 'c', kind: 'district', polarity: 'include', district_id: 'd1', district_label: 'الملز' },
    ] });
    expect(r).toEqual({ places: ['الملز'], more: false });
  });
});
