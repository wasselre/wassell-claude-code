import { describe, it, expect } from 'vitest';
import { draftToMatchRequirements } from './requirements';

// A district id → name resolver, as the modal wires from the loaded districts records.
const NAMES: Record<string, string> = {
  'd-narjis': 'النرجس',
  'd-aqiq': 'العقيق',
  'd-yasmin': 'الياسمين',
  'c-riyadh': 'الرياض',
  'c-jeddah': 'جدة',
};
const resolveLookupName = (id: string) => NAMES[id] ?? null;

const base = { clientsModel: null, savedClientData: null, resolveLookupName };

describe('draftToMatchRequirements — multi-district', () => {
  it('sends ALL districts from the location cascade (not just the first)', () => {
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: { location: { city: ['c-riyadh'], district: ['d-narjis', 'd-aqiq'] } },
    });
    expect(out.districts).toEqual(['النرجس', 'العقيق']);
    expect(out.district).toBe('النرجس'); // primary stays = districts[0]
    expect(out.city).toBe('الرياض');
    // The AUTHORITATIVE record ids ride along — the engine matches on these
    // directly (no fuzzy name resolution that could hit a wrong-city namesake).
    expect(out.district_ids).toEqual(['d-narjis', 'd-aqiq']);
  });

  it('unions location districts with the preferred_districts field and dedupes', () => {
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: {
        location: { district: ['d-narjis'] },
        preferred_districts: ['d-aqiq', 'd-narjis'], // d-narjis is a dup
      },
    });
    expect(out.districts).toEqual(['النرجس', 'العقيق']); // deduped, location first
  });

  it('a single district still works and omits districts when none resolve', () => {
    const one = draftToMatchRequirements({ ...base, prefDraft: { location: { district: ['d-yasmin'] } } });
    expect(one.districts).toEqual(['الياسمين']);
    expect(one.district).toBe('الياسمين');

    const none = draftToMatchRequirements({ ...base, prefDraft: { location: { district: ['unknown-id'] } } });
    expect(none.districts).toBeUndefined();
    expect(none.district).toBeUndefined();
  });

  it('mirrors an include-district from location_items into requirements.districts', () => {
    // A district picked in the location box is a location_items district rule, NOT
    // the cascade — so without this it would tier as "same city, different district".
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: {
        location: { city: ['c-riyadh'] }, // cascade capped at city
        location_items: [{ id: 'i1', kind: 'district', polarity: 'include', district_id: 'd-aqiq' }],
      },
    });
    expect(out.districts).toEqual(['العقيق']);
    expect(out.district).toBe('العقيق');
    expect(out.city).toBe('الرياض');
    expect(out.district_ids).toEqual(['d-aqiq']);
  });

  it('resolves a location_items district via its stashed label when the record is not loaded', () => {
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: {
        location_items: [{ id: 'i1', kind: 'district', polarity: 'include', district_id: 'd-unloaded', district_label: 'حي المصيف' }],
      },
    });
    expect(out.districts).toEqual(['حي المصيف']);
  });

  it('sends ALL selected unit types as OR alternatives (property_types), first as primary', () => {
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: { preferred_unit_type: ['شقة', 'دور'] },
    });
    expect(out.property_types).toEqual(['شقة', 'دور']);
    expect(out.property_type).toBe('شقة'); // primary stays = property_types[0]
  });

  it('sends ALL selected cities as OR alternatives (cities), first as primary', () => {
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: { location: { city: ['c-riyadh', 'c-jeddah'] } },
    });
    expect(out.cities).toEqual(['الرياض', 'جدة']);
    expect(out.city).toBe('الرياض');
  });

  it('ignores exclude-district and element_rule location_items', () => {
    const out = draftToMatchRequirements({
      ...base,
      prefDraft: {
        location_items: [
          { id: 'i1', kind: 'district', polarity: 'exclude', district_id: 'd-aqiq' },
          { id: 'i2', kind: 'element_rule', polarity: 'include', conditions: [{ rule: 'north_of', element_id: 'e1' }] },
        ],
      },
    });
    expect(out.districts).toBeUndefined();
    expect(out.district_ids).toBeUndefined();
  });
});

describe('preferred_max_unit_age → max_unit_age', () => {
  it("maps the dropdown's string value, including the meaningful '0' (new only)", () => {
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: { preferred_max_unit_age: '0' }, savedClientData: null }).max_unit_age).toBe(0);
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: { preferred_max_unit_age: '5' }, savedClientData: null }).max_unit_age).toBe(5);
  });
  it('absent / empty / junk → no max_unit_age', () => {
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: {}, savedClientData: null }).max_unit_age).toBeUndefined();
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: { preferred_max_unit_age: '' }, savedClientData: null }).max_unit_age).toBeUndefined();
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: { preferred_max_unit_age: 'abc' }, savedClientData: null }).max_unit_age).toBeUndefined();
  });
  it('falls back to the saved client when the draft slot is empty', () => {
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: {}, savedClientData: { preferred_max_unit_age: '2' } }).max_unit_age).toBe(2);
  });
});

describe('draftToMatchRequirements — preference_constraints (registered bands)', () => {
  it('maps the persisted band object straight onto requirements.constraints', () => {
    const pc = { area: { mode: 'hard', tolerance_pct: 0.1 }, budget: { mode: 'soft' } };
    const out = draftToMatchRequirements({
      clientsModel: null, prefDraft: { preference_constraints: pc }, savedClientData: null,
    });
    expect(out.constraints).toEqual(pc);
  });
  it('falls back to the SAVED client bands when the draft has none', () => {
    const pc = { bedrooms: { mode: 'hard', tolerance_pct: 0 } };
    const out = draftToMatchRequirements({
      clientsModel: null, prefDraft: {}, savedClientData: { preference_constraints: pc },
    });
    expect(out.constraints).toEqual(pc);
  });
  it('an amenities band set to hard also fills required_amenities (the engine wire format)', () => {
    const out = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { preferred_amenities: ['غرفة سائق', 'ملحق'], preference_constraints: { amenities: { mode: 'hard' } } },
      savedClientData: null,
    });
    expect(out.required_amenities).toEqual(['غرفة سائق', 'ملحق']);
  });
  it('soft amenities does NOT fill required_amenities', () => {
    const out = draftToMatchRequirements({
      clientsModel: null,
      prefDraft: { preferred_amenities: ['مسبح'], preference_constraints: { amenities: { mode: 'soft' } } },
      savedClientData: null,
    });
    expect(out.required_amenities).toBeUndefined();
  });
  it('no band object → no constraints key', () => {
    expect(draftToMatchRequirements({ clientsModel: null, prefDraft: {}, savedClientData: null }).constraints).toBeUndefined();
  });
});
