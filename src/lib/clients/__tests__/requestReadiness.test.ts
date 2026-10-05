import { describe, it, expect } from 'vitest';
import { gapListText, hasRequestedDistrict, requestPreferenceGaps } from '../requestReadiness';
import { validateFollowUpCompletion } from '@/lib/salesProcess/validators';

const district = (id: string, polarity: 'include' | 'exclude' = 'include') =>
  ({ id: `it-${id}`, kind: 'district', polarity, district_id: id, district_label: `حي ${id}` });

const READY = {
  preferred_unit_type: ['فيلا'],
  location_items: [district('d1')],
  budget: { min: null, max: 2_500_000 },
};

describe('requestPreferenceGaps', () => {
  it('a complete profile has no gaps', () => {
    expect(requestPreferenceGaps(READY)).toEqual([]);
  });

  it('an empty profile is missing all three', () => {
    expect(requestPreferenceGaps({})).toEqual(['unit_type', 'districts', 'budget']);
    expect(requestPreferenceGaps(null)).toEqual(['unit_type', 'districts', 'budget']);
  });

  it('an excluded district alone does not count — offices match on included ones', () => {
    expect(requestPreferenceGaps({ ...READY, location_items: [district('d1', 'exclude')] })).toEqual(['districts']);
  });

  it('a geo-element rule or drawn area is not a district (office matching reads district ids only)', () => {
    const items = [{ id: 'e', kind: 'element_rule', polarity: 'include', element_label: 'x' }, { id: 'a', kind: 'drawn_area', polarity: 'include' }];
    expect(hasRequestedDistrict(items)).toBe(false);
    expect(hasRequestedDistrict([{ ...district(''), district_id: '' }])).toBe(false);
  });

  it('a budget needs a positive min or max', () => {
    expect(requestPreferenceGaps({ ...READY, budget: { min: 0, max: 0 } })).toEqual(['budget']);
    expect(requestPreferenceGaps({ ...READY, budget: { min: '900000', max: null } })).toEqual([]);
  });

  it('blank unit types do not count', () => {
    expect(requestPreferenceGaps({ ...READY, preferred_unit_type: [' '] })).toEqual(['unit_type']);
  });

  it('lists gaps in the reader’s language', () => {
    expect(gapListText(['districts', 'budget'], true)).toBe('الأحياء المطلوبة، الميزانية');
    expect(gapListText(['districts', 'budget'], false)).toBe('Requested districts, Budget');
  });
});

describe('«طلب غير مجاب» outcome requires request-ready client preferences', () => {
  const base = { followupType: 'appointment_booking_call', selectedOutcome: 'unanswered_request', draft: { actual_datetime: '2026-10-05T10:00:00Z' } };

  it('passes with complete preferences — notes are no longer required', () => {
    expect(validateFollowUpCompletion({ ...base, clientData: READY }).ok).toBe(true);
  });

  it('is refused while preferences are incomplete, naming what is missing', () => {
    const r = validateFollowUpCompletion({ ...base, clientData: { ...READY, location_items: [] } });
    expect(r.ok).toBe(false);
    expect(r.hardErrors[0]?.message_ar).toContain('الأحياء المطلوبة');
    expect(r.hardErrors[0]?.message_en).toContain('Requested districts');
  });

  it('fails CLOSED when the caller did not pass the client', () => {
    expect(validateFollowUpCompletion(base).ok).toBe(false);
  });

  it('other outcomes are unaffected by the client check', () => {
    const r = validateFollowUpCompletion({ ...base, selectedOutcome: 'interested' });
    expect(r.hardErrors.some((e) => e.message_en.includes('preferences'))).toBe(false);
  });
});
