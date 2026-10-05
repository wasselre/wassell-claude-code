import { describe, it, expect } from 'vitest';
import { isIsoDay, riyadhTenAm, riyadhToday } from '../escalation';

describe('isIsoDay', () => {
  it('accepts a real calendar day only', () => {
    expect(isIsoDay('2026-10-01')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);   // not a day
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('tomorrow')).toBe(false);
    expect(isIsoDay('2026-10-1')).toBe(false);
  });
});

describe('riyadhToday', () => {
  it('is the Riyadh calendar day, not the UTC one', () => {
    // 22:30 UTC is already 01:30 the NEXT day in Riyadh (UTC+3).
    expect(riyadhToday(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01');
    expect(riyadhToday(new Date('2026-09-30T10:00:00Z'))).toBe('2026-09-30');
  });
});

describe('riyadhTenAm', () => {
  const now = new Date('2026-10-05T09:00:00Z');   // 12:00 Riyadh
  it('is 10:00 Riyadh (07:00 UTC) on the day before', () => {
    expect(riyadhTenAm('2026-10-08', -1, now)).toBe('2026-10-07T07:00:00.000Z');
  });
  it('crosses a month boundary', () => {
    expect(riyadhTenAm('2026-10-31', 1, now)).toBe('2026-11-01T07:00:00.000Z');
  });
  it('is now when that moment has passed (a visit booked for tomorrow)', () => {
    expect(riyadhTenAm('2026-10-06', -1, now)).toBe(now.toISOString());
  });
});
