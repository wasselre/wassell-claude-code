import { describe, it, expect } from 'vitest';
import { draftToMatchRequirements } from '../matching/requirements';

/**
 * The mapper turns a client's draft preferences into the matcher's requirements,
 * draft-FIRST and lookup-FIRST. clientsModel is unused by the current mapper
 * (slugs are read directly), so we pass null.
 */
describe('draftToMatchRequirements', () => {
  it('maps legacy multiselect + ranges, draft-first', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: {
        preferred_neighborhoods: ['النرجس'],
        preferred_city: ['الرياض'],
        preferred_unit_type: ['شقة'],
        budget: { min: 500_000, max: 1_200_000 },
        preferred_area: { min: 120, max: 200 },
        preferred_amenities: ['مسبح', 'مصعد'],
      },
      savedClientData: null,
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

  it('prefers the relational lookup district over legacy text (lookup-first)', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: {
        preferred_districts: ['district-id-1'],
        preferred_neighborhoods: ['النرجس'], // legacy present too — lookup must win
      },
      savedClientData: null,
      resolveLookupName: (id, target) => (id === 'district-id-1' && target === 'districts' ? 'العليا' : null),
    });
    expect(req.district).toBe('العليا');
  });

  it('falls back to legacy text when the lookup cannot be resolved', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { preferred_districts: ['unknown-id'], preferred_neighborhoods: ['النرجس'] },
      savedClientData: null,
      resolveLookupName: () => null,
    });
    expect(req.district).toBe('النرجس');
  });

  it('an unsaved draft value beats the saved client value', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { preferred_neighborhoods: ['النرجس'] },
      savedClientData: { preferred_neighborhoods: ['الفاروق'] },
    });
    expect(req.district).toBe('النرجس');
  });

  it('uses the saved client value when the draft slot is empty', () => {
    const req = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: {},
      savedClientData: { preferred_city: ['جدة'], budget: { max: 800_000 } },
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
