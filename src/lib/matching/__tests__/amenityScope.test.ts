/**
 * Where an amenity must be — in the unit, in the project, or either
 * (operator, 2026-10-08). Browser side: the request builder and the card's units.
 */
import { describe, it, expect } from 'vitest';
import { matchingUnits, scoreUnit } from '../unitScore';
import { draftToMatchRequirements } from '../requirements';
import { amenityMatches, unitHasAmenity } from '../amenityMatch';
import type { UnitView } from '@/lib/projects/unitView';
import type { AppRecord } from '@/types';
import type { OptionView } from '@/lib/projects/projectView';

const opt = (value: string, ar = value, en = value): OptionView => ({ value, label_ar: ar, label_en: en, color: null });

function unit(p: Partial<UnitView>): UnitView {
  return {
    id: Math.random().toString(36).slice(2), raw: {} as unknown as AppRecord, projectId: 'proj',
    code: 'U-1', developerCode: null, unitNumber: null, model: null, developer: null,
    type: null, status: opt('available', 'متاح', 'Available'), bedrooms: null, bathrooms: null, floor: null,
    area: null, privateArea: null, totalArea: null, yardArea: null, deedArea: null,
    totalPrice: null, pricePerM2: null, components: [], facade: [], parking: [], elevator: null,
    building: null, block: null, streetWidth: null, planImage: null, unitBrochure: null,
    projectBrochure: null, locationLink: null, notes: null, createdAt: '2026-01-01T00:00:00Z',
    ...p,
  };
}

describe('draftToMatchRequirements — amenity_scopes', () => {
  it('sends unit / project choices for the selected amenities only; «both» is the default', () => {
    const out = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: {
        preferred_amenities: ['غرفة خادمة', 'مسبح', 'مصعد'],
        preference_constraints: { amenities: { mode: 'soft', scopes: { 'غرفة خادمة': 'unit', 'مسبح': 'project', 'مصعد': 'both', 'مجلس': 'unit' } } },
      },
      savedClientData: null,
    });
    expect(out.amenity_scopes).toEqual({ 'غرفة خادمة': 'unit', 'مسبح': 'project' });
  });
  it('no scopes → no amenity_scopes key', () => {
    const out = draftToMatchRequirements({ clientsModel: null, prefDraft: { preferred_amenities: ['مسبح'] }, savedClientData: null });
    expect(out.amenity_scopes).toBeUndefined();
  });
});

describe('the card’s units follow the «in the unit» amenities', () => {
  const withMaid = unit({ components: [opt('غرفة خادمة', 'غرفة خادمة', 'Maid Room'), opt('مجلس')], totalPrice: 1_000_000 });
  const withoutMaid = unit({ components: [opt('مجلس')], totalPrice: 900_000 });
  const noData = unit({ totalPrice: 800_000 });

  it('only units that have every unit amenity fully match', () => {
    const req = { amenities: ['غرفة خادمة'], amenity_scopes: { 'غرفة خادمة': 'unit' as const } };
    expect(matchingUnits([withMaid, withoutMaid, noData], req)).toEqual([withMaid]);
  });
  it('an amenity looked for in the PROJECT (or either) does not filter units', () => {
    expect(matchingUnits([withMaid, withoutMaid], { amenities: ['غرفة خادمة'], amenity_scopes: { 'غرفة خادمة': 'project' } })).toHaveLength(2);
    expect(matchingUnits([withMaid, withoutMaid], { amenities: ['غرفة خادمة'] })).toHaveLength(2);
  });
  it('partial credit when a unit has some of them', () => {
    const req = { amenities: ['غرفة خادمة', 'مجلس'], amenity_scopes: { 'غرفة خادمة': 'unit' as const, 'مجلس': 'unit' as const } };
    expect(scoreUnit(withoutMaid, req).breakdown.amenities).toBe(0.5);
    expect(scoreUnit(withMaid, req).breakdown.amenities).toBe(1);
  });
  it('a ready elevator and a yard area count', () => {
    expect(unitHasAmenity(unit({ elevator: opt('جاهز') }), 'مصعد')).toBe(true);
    expect(unitHasAmenity(unit({ elevator: opt('مؤسس') }), 'مصعد')).toBe(false);
    expect(unitHasAmenity(unit({ yardArea: 40 }), 'حوش')).toBe(true);
  });
  it('synonyms match like the engine', () => {
    expect(amenityMatches('swimming_pool', 'مسبح')).toBe(true);
    expect(amenityMatches('غرفة خادمة', 'غرفة سائق')).toBe(false);
  });
});
