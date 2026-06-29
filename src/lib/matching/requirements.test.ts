import { describe, it, expect } from 'vitest';
import { draftToMatchRequirements } from './requirements';

// A district id → name resolver, as the modal wires from the loaded districts records.
const NAMES: Record<string, string> = {
  'd-narjis': 'النرجس',
  'd-aqiq': 'العقيق',
  'd-yasmin': 'الياسمين',
  'c-riyadh': 'الرياض',
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
});
