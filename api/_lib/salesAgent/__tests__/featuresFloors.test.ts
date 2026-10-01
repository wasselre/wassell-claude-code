import { describe, it, expect } from 'vitest';
import { resolveFeatures, componentsOf } from '../features';
import { floorNumber } from '../units';
import { asNearConditions } from '../places';

describe('unit features', () => {
  it('maps the customer\'s words to stored components', () => {
    const r = resolveFeatures(['غرفة خادمة', 'شغالة', 'سائق', 'روف', 'مطبخ راكب', 'مكيفات مخفية', 'مدخل مستقل']);
    expect(r.unknown).toEqual([]);
    expect(r.known).toEqual(expect.arrayContaining(['غرفه خادمه', 'غرفه سايق', 'سطح', 'مطبخ مجهز مسبقا', 'تكييف مخفي مجهز مسبقا', 'مدخل خاص']));
  });

  it('a feature we do not record is UNKNOWN, never guessed', () => {
    expect(resolveFeatures(['مطبخ مفتوح', 'غرفة مكتب']).unknown).toEqual(['مطبخ مفتوح', 'غرفة مكتب']);
  });

  it('folds stored slugs the same way', () => {
    expect(componentsOf(['غرفة سائق', 'مطبخ-مجهز-مسبقا', 'مؤثثة', 7])).toEqual(['غرفه سايق', 'مطبخ مجهز مسبقا', 'موثثه']);
  });
});

describe('floor numbers', () => {
  it('ground 0 … roof on top', () => {
    expect(floorNumber('الأرضي')).toBe(0);
    expect(floorNumber('اول')).toBe(1);
    expect(floorNumber('الدور الثاني')).toBe(2);
    expect(floorNumber('16')).toBe(16);
    expect(floorNumber('الروف')).toBeGreaterThan(100);
    expect(floorNumber('')).toBeNull();
  });
});

describe('near conditions', () => {
  it('keeps valid conditions, caps distance, drops junk', () => {
    expect(asNearConditions([
      { place: 'الرياض بارك', max_km: 3 },
      { category: 'metro', max_km: 1 },
      { place: 'x', max_km: 500 },
      { max_km: 2 },
      { place: 'y', max_km: -1 },
      { category: 'airport', max_km: 2 },
    ])).toEqual([
      { place: 'الرياض بارك', category: undefined, max_km: 3 },
      { place: undefined, category: 'metro', max_km: 1 },
      { place: 'x', category: undefined, max_km: 50 },
    ]);
  });
});
