import { describe, it, expect } from 'vitest';
import { draftToMatchRequirements } from '../matching/requirements';

/**
 * The mapper turns a client's draft preferences into the matcher's requirements,
 * draft-FIRST. Geography is the `location` cascade compound { region:[], city:[],
 * district:[] } of record ids; the mapper resolves the first city/district id to a
 * name via resolveLookupName. clientsModel is unused (slugs read directly) → null.
 */
const GEO_NAMES: Record<string, string> = { 'd-narjis': 'النرجس', 'd-farouq': 'الفاروق', 'd-olaya': 'العليا', 'c-riyadh': 'الرياض', 'c-jeddah': 'جدة' };
const resolveLookupName = (id: string): string | null => GEO_NAMES[id] ?? null;

describe('draftToMatchRequirements', () => {
  it('maps the location cascade + ranges, draft-first', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: {
        location: { city: ['c-riyadh'], district: ['d-narjis'] },
        preferred_unit_type: ['شقة'],
        budget: { min: 500_000, max: 1_200_000 },
        preferred_area: { min: 120, max: 200 },
        preferred_amenities: ['مسبح', 'مصعد'],
      },
      savedClientData: null,
      resolveLookupName,
    });
    expect(req.district).toBe('النرجس');
    expect(req.city).toBe('الرياض');
    expect(req.property_type).toBe('شقة');
    expect(req.budget_min).toBe(500_000);
    expect(req.budget_max).toBe(1_200_000);
    expect(req.area_min).toBe(120);
    expect(req.area_max).toBe(200);
    expect(req.amenities).toEqual(['مسبح', 'مصعد']);
  });

  it('resolves the first location.district id to its name', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { location: { district: ['d-olaya'] } },
      savedClientData: null,
      resolveLookupName,
    });
    expect(req.district).toBe('العليا');
  });

  it('omits the district when the lookup id cannot be resolved', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { location: { district: ['unknown-id'] } },
      savedClientData: null,
      resolveLookupName: () => null,
    });
    expect(req.district).toBeUndefined();
  });

  it('an unsaved draft value beats the saved client value', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { location: { district: ['d-narjis'] } },
      savedClientData: { location: { district: ['d-farouq'] } },
      resolveLookupName,
    });
    expect(req.district).toBe('النرجس');
  });

  it('uses the saved client value when the draft slot is empty', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: {},
      savedClientData: { location: { city: ['c-jeddah'] }, budget: { max: 800_000 } },
      resolveLookupName,
    });
    expect(req.city).toBe('جدة');
    expect(req.budget_max).toBe(800_000);
    expect(req.district).toBeUndefined();
  });

  it('omits empty / zeroed ranges', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { budget: { min: 0, max: 0 }, preferred_area: {} },
      savedClientData: null,
    });
    expect(req.budget_min).toBeUndefined();
    expect(req.budget_max).toBeUndefined();
    expect(req.area_min).toBeUndefined();
  });
});
