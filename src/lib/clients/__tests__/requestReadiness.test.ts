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
    expect(requestPreferenceGaps({})).toEqual(['unit_type', 'districts', 'specs']);
    expect(requestPreferenceGaps(null)).toEqual(['unit_type', 'districts', 'specs']);
  });

  it('an excluded district alone does not count — offices match on included ones', () => {
    expect(requestPreferenceGaps({ ...READY, location_items: [district('d1', 'exclude')] })).toEqual(['districts']);
  });

  it('a drawn area counts as districts (the districts it covers) — operator, 2026-10-05', () => {
    const ring = [[46.7, 24.7], [46.8, 24.7], [46.8, 24.8], [46.7, 24.7]];
    expect(hasRequestedDistrict([{ id: 'a', kind: 'drawn_area', polarity: 'include', coordinates: ring }])).toBe(true);
    expect(requestPreferenceGaps({ ...READY, location_items: [{ id: 'a', kind: 'drawn_area', polarity: 'include', coordinates: ring }] })).toEqual([]);
  });

  it('an excluded drawing, a broken drawing or a geo-element rule is not a district', () => {
    const ring = [[46.7, 24.7], [46.8, 24.7], [46.8, 24.8], [46.7, 24.7]];
    expect(hasRequestedDistrict([{ id: 'a', kind: 'drawn_area', polarity: 'exclude', coordinates: ring }])).toBe(false);
    expect(hasRequestedDistrict([{ id: 'a', kind: 'drawn_area', polarity: 'include', coordinates: ring.slice(0, 2) }])).toBe(false);
    expect(hasRequestedDistrict([{ id: 'e', kind: 'element_rule', polarity: 'include', element_label: 'x' }])).toBe(false);
    expect(hasRequestedDistrict([{ ...district(''), district_id: '' }])).toBe(false);
  });

  it('needs ONE of budget, bedrooms or size — any one is enough', () => {
    const none = { ...READY, budget: { min: 0, max: 0 } };
    expect(requestPreferenceGaps(none)).toEqual(['specs']);
    expect(requestPreferenceGaps({ ...none, budget: { min: '900000', max: null } })).toEqual([]);
    expect(requestPreferenceGaps({ ...none, preferred_bedrooms: { min: 4, max: null } })).toEqual([]);
    expect(requestPreferenceGaps({ ...none, preferred_area: { min: null, max: 300 } })).toEqual([]);
  });

  it('blank unit types do not count', () => {
    expect(requestPreferenceGaps({ ...READY, preferred_unit_type: [' '] })).toEqual(['unit_type']);
  });

  it('lists gaps in the reader’s language', () => {
    expect(gapListText(['districts', 'specs'], true)).toBe('الأحياء المطلوبة، الميزانية أو عدد الغرف أو المساحة');
    expect(gapListText(['districts', 'specs'], false)).toBe('Requested districts, Budget, bedrooms or size');
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
