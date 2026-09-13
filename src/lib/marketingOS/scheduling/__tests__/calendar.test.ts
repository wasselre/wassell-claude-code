import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CALENDAR, addDays, addWorkingDays, dayOfInstant, isWorkingDay, nextWorkingDay,
  prevWorkingDay, toInstant, weekdayOf, workingDaysBetween, workingDaysIn, workingDaysPerWeek,
  workingWindowEndingAt, parseDay,
} from '../calendar';

const CAL = DEFAULT_CALENDAR; // Friday off

describe('calendar — the real Saudi week', () => {
  it('knows 2026-10-01 is a Thursday (the anchor every worked example uses)', () => {
    expect(weekdayOf('2026-10-01')).toBe(4);
    expect(weekdayOf('2026-10-02')).toBe(5); // Friday
    expect(weekdayOf('2026-10-11')).toBe(0); // Sunday
  });

  it('treats Friday as the only non-working day by default', () => {
    expect(isWorkingDay('2026-10-01', CAL)).toBe(true);
    expect(isWorkingDay('2026-10-02', CAL)).toBe(false);
    expect(isWorkingDay('2026-10-03', CAL)).toBe(true); // Saturday works
    expect(workingDaysPerWeek(CAL)).toBe(6);
  });

  it('honours holidays as data', () => {
    const withEid = { ...CAL, holidays: ['2026-10-05'] };
    expect(isWorkingDay('2026-10-05', withEid)).toBe(false);
    expect(addWorkingDays('2026-10-04', 1, withEid)).toBe('2026-10-06');
  });

  it('skips, never stretches, across the weekend', () => {
    expect(addWorkingDays('2026-10-01', 1, CAL)).toBe('2026-10-03');
    expect(addWorkingDays('2026-10-08', -1, CAL)).toBe('2026-10-07');
    expect(addWorkingDays('2026-10-10', -1, CAL)).toBe('2026-10-08'); // Oct 9 is Friday
    expect(addWorkingDays('2026-10-03', -1, CAL)).toBe('2026-10-01');
  });

  it('counts inclusive working days', () => {
    expect(workingDaysBetween('2026-10-01', '2026-10-03', CAL)).toBe(2);
    expect(workingDaysIn('2026-09-30', '2026-10-07', CAL)).toEqual([
      '2026-09-30', '2026-10-01', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07',
    ]);
  });

  it('builds a window that ENDS on the given day', () => {
    expect(workingWindowEndingAt('2026-10-07', 2, CAL)).toEqual(['2026-10-06', '2026-10-07']);
    expect(workingWindowEndingAt('2026-10-10', 3, CAL)).toEqual(['2026-10-07', '2026-10-08', '2026-10-10']);
  });

  it('snaps to working days in both directions', () => {
    expect(nextWorkingDay('2026-10-02', CAL)).toBe('2026-10-03');
    expect(prevWorkingDay('2026-10-02', CAL)).toBe('2026-10-01');
    expect(nextWorkingDay('2026-10-01', CAL)).toBe('2026-10-01');
  });

  it('round-trips Riyadh wall clock without drifting a day', () => {
    const iso = toInstant('2026-10-11', '20:30', CAL);
    expect(iso).toBe('2026-10-11T17:30:00.000Z');
    expect(dayOfInstant(iso, CAL)).toBe('2026-10-11');
    // 01:00 Riyadh is still the same civil day even though UTC is the day before.
    const early = toInstant('2026-10-11', '01:00', CAL);
    expect(early).toBe('2026-10-10T22:00:00.000Z');
    expect(dayOfInstant(early, CAL)).toBe('2026-10-11');
  });

  it('rejects impossible dates instead of silently rolling over', () => {
    expect(() => parseDay('2026-02-31')).toThrow();
    expect(() => parseDay('nope')).toThrow();
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
