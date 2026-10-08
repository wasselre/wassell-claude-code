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
      { asked: 'مسبح', key: 'pool', status: 'found', scope: 'project' },
      { asked: 'غرفة سائق', key: 'driver_room', status: 'unknown', scope: 'unit' },
      { asked: 'نادي رياضي', key: 'gym', status: 'missing', scope: 'project' },
    ]);
    expect(amenityMatchFacts({ unit_features: ['مجلس'] }, ['مجلس', 'غرفة خادمة'])).toEqual([
      { asked: 'مجلس', key: 'majlis', status: 'found', scope: 'unit' },
      { asked: 'غرفة خادمة', key: 'maid_room', status: 'missing', scope: 'unit' },
    ]);
    expect(amenityMatchFacts({}, [])).toEqual([]);
  });
});

describe('amenityStatus — where to look (2026-10-08)', () => {
  it('project / unit / both look only where asked', async () => {
    const { amenityStatus } = await import('../matchAgent.js');
    const data = { preferred_amenities: ['swimming_pool'], unit_features: ['غرفة خادمة'] };
    expect(amenityStatus(data, 'مسبح', 'project')).toBe('found');
    expect(amenityStatus(data, 'مسبح', 'unit')).toBe('missing');
    expect(amenityStatus(data, 'غرفة خادمة', 'unit')).toBe('found');
    expect(amenityStatus(data, 'غرفة خادمة', 'project')).toBe('missing');
    expect(amenityStatus(data, 'غرفة خادمة', 'both')).toBe('found');
    expect(amenityStatus(data, 'مسبح', 'both')).toBe('found');
  });
  it('units that record nothing: unit scope is unknown, project scope is missing', async () => {
    const { amenityStatus } = await import('../matchAgent.js');
    expect(amenityStatus({ preferred_amenities: ['gym'] }, 'مسبح', 'unit')).toBe('unknown');
    expect(amenityStatus({ preferred_amenities: ['gym'] }, 'غرفة خادمة', 'project')).toBe('missing');
  });
  it('the must-have gate and the card facts follow the scope', async () => {
    const { passesRequiredAmenities, amenityMatchFacts } = await import('../matchAgent.js');
    const data = { preferred_amenities: ['غرفة خادمة'], unit_features: ['مجلس'] };
    expect(passesRequiredAmenities(data, { required_amenities: ['غرفة خادمة'], amenity_scopes: { 'غرفة خادمة': 'unit' } })).toBe(false);
    expect(passesRequiredAmenities(data, { required_amenities: ['غرفة خادمة'], amenity_scopes: { 'غرفة خادمة': 'project' } })).toBe(true);
    expect(amenityMatchFacts(data, ['غرفة خادمة'], { 'غرفة خادمة': 'unit' })).toEqual([
      { asked: 'غرفة خادمة', key: 'maid_room', status: 'missing', scope: 'unit' },
    ]);
  });
});

describe('the new amenities (2026-10-08) and their default place', () => {
  it('match the values units and projects actually store', async () => {
    const { amenityMatches } = await import('../matchAgent.js');
    const pairs: Array<[string, string]> = [
      ['بلكونات', 'بلكونة'], ['غرفة غسيل', 'غرفة غسيل'], ['ملابس', 'غرفة ملابس'], ['مستودع', 'مستودع'],
      ['تراس', 'تراس'], ['حديقة', 'حديقة خاصة'], ['green_spaces', 'حدائق ومساحات خضراء'], ['garden', 'حدائق ومساحات خضراء'],
      ['sports_club', 'نادي رياضي'], ['gym', 'نادي رياضي'], ['جلسات-خارجية', 'جلسات خارجية'],
      ['children_play_area', 'ألعاب أطفال'], ['نظام-مراقبة-امنية', 'حراسة وكاميرات'], ['ممرات-رياضية', 'ممشى'],
      ['running_track', 'ممشى'], ['شواحن-سيارات-كهربايية', 'شواحن سيارات كهربائية'], ['jacuzzi', 'جاكوزي وساونا وسبا'],
      ['sauna', 'جاكوزي وساونا وسبا'], ['سبا', 'جاكوزي وساونا وسبا'], ['padel_court', 'ملعب بادل'], ['mosque', 'مصلى'],
    ];
    for (const [have, want] of pairs) expect([have, want, amenityMatches(have, want)]).toEqual([have, want, true]);
  });
  it('keeps look-alikes apart', async () => {
    const { amenityMatches } = await import('../matchAgent.js');
    expect(amenityMatches('garden', 'حديقة خاصة')).toBe(false);
    expect(amenityMatches('حديقة', 'حدائق ومساحات خضراء')).toBe(false);
    expect(amenityMatches('green_spaces', 'جاكوزي وساونا وسبا')).toBe(false);
    expect(amenityMatches('سبا', 'مسبح')).toBe(false);
  });
  it('defaults: room features in the unit, facilities in the project, elevator / rooftop / balcony either', async () => {
    const { defaultAmenityScope } = await import('../matchAgent.js');
    expect(defaultAmenityScope('غرفة خادمة')).toBe('unit');
    expect(defaultAmenityScope('تراس')).toBe('unit');
    expect(defaultAmenityScope('مسبح')).toBe('project');
    expect(defaultAmenityScope('ملعب بادل')).toBe('project');
    expect(defaultAmenityScope('مصعد')).toBe('both');
    expect(defaultAmenityScope('بلكونة')).toBe('both');
    expect(defaultAmenityScope('شيء غير معروف')).toBe('both');
  });
});
