/**
 * Project finder amenities (2026-10-07): a client's Arabic choice matches a
 * project value saved in either language, and what the project's UNITS contain
 * (`unit_features`) counts as evidence.
 */
import { describe, it, expect } from 'vitest';
import { amenityMatches, isUnitAmenity, passesRequiredAmenities, firstFailedHardConstraint } from '../matchAgent.js';

describe('amenityMatches — the same amenity, however it was saved', () => {
  it.each([
    ['swimming_pool', 'مسبح'],
    ['مصاعد', 'مصعد'],
    ['elevators', 'مصعد'],
    ['اسطح-خاصة', 'سطح'],
    ['فناء خارجي', 'حوش'],
    ['غرفة خادمة', 'غرفة خادمة'],
    ['غرفة سائق', 'غرفة سائق'],
    ['sports_club', 'نادي رياضي'],
  ])('%s satisfies %s', (have, want) => {
    expect(amenityMatches(have, want)).toBe(true);
  });

  it.each([
    ['swimming_pool', 'مصعد'],
    ['غرفة خادمة', 'غرفة سائق'],
    ['حمام-ضيوف', 'مسبح'],
    ['garden', 'حوش'],
    ['green_spaces', 'مسبح'],
  ])('%s does not satisfy %s', (have, want) => {
    expect(amenityMatches(have, want)).toBe(false);
  });

  it('unknown words still match by plain containment', () => {
    expect(amenityMatches('سينما خارجية', 'سينما')).toBe(true);
  });
});

describe('isUnitAmenity', () => {
  it('rooms and the yard belong to a unit; a pool belongs to the project', () => {
    expect(isUnitAmenity('غرفة خادمة')).toBe(true);
    expect(isUnitAmenity('مجلس')).toBe(true);
    expect(isUnitAmenity('حوش')).toBe(true);
    expect(isUnitAmenity('مسبح')).toBe(false);
  });
});

describe('must-have amenities', () => {
  const req = (list: string[]) => ({ required_amenities: list });
  it('a project with a pool saved as swimming_pool passes «مسبح»', () => {
    expect(passesRequiredAmenities({ preferred_amenities: ['swimming_pool', 'gym'] }, req(['مسبح']))).toBe(true);
  });
  it('what the units contain counts', () => {
    expect(passesRequiredAmenities({ preferred_amenities: [], unit_features: ['مجلس', 'غرفة خادمة'] }, req(['غرفة خادمة', 'مجلس']))).toBe(true);
  });
  it('units that record features but not this one → dropped', () => {
    expect(passesRequiredAmenities({ unit_features: ['مجلس'] }, req(['غرفة سائق']))).toBe(false);
  });
  it('units that record nothing → a unit amenity is unknown, kept', () => {
    expect(passesRequiredAmenities({ preferred_amenities: ['gym'] }, req(['غرفة سائق']))).toBe(true);
    expect(passesRequiredAmenities({}, req(['مجلس']))).toBe(true);
  });
  it('a project facility with no evidence still fails closed', () => {
    expect(passesRequiredAmenities({}, req(['مسبح']))).toBe(false);
    expect(passesRequiredAmenities({ unit_features: ['مجلس'] }, req(['مسبح']))).toBe(false);
  });
  it('the hard-constraint gate uses the same rule', () => {
    expect(firstFailedHardConstraint({ preferred_amenities: ['مصاعد'] }, { required_amenities: ['مصعد'] } as never)).toBeNull();
    expect(firstFailedHardConstraint({ preferred_amenities: ['gym'] }, { required_amenities: ['مسبح'] } as never)).toBe('amenities');
  });
});

describe('amenityMatchFacts — what the finder card shows', () => {
  it('found / unknown / missing per requested amenity, de-duplicated', async () => {
    const { amenityMatchFacts } = await import('../matchAgent.js');
    expect(amenityMatchFacts({ preferred_amenities: ['swimming_pool'] }, ['مسبح', 'غرفة سائق', 'نادي رياضي', 'مسبح'])).toEqual([
      { asked: 'مسبح', key: 'pool', status: 'found' },
      { asked: 'غرفة سائق', key: 'driver_room', status: 'unknown' },
      { asked: 'نادي رياضي', key: 'gym', status: 'missing' },
    ]);
    expect(amenityMatchFacts({ unit_features: ['مجلس'] }, ['مجلس', 'غرفة خادمة'])).toEqual([
      { asked: 'مجلس', key: 'majlis', status: 'found' },
      { asked: 'غرفة خادمة', key: 'maid_room', status: 'missing' },
    ]);
    expect(amenityMatchFacts({}, [])).toEqual([]);
  });
});
