import { describe, it, expect } from 'vitest';
import { isIsoDay, riyadhToday } from '../escalation';

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
