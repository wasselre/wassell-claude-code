/**
 * A year is a label, not a quantity (2026-10-04): the month page titled every
 * month «أكتوبر ٢,٠٢٦» because the year went through `num()`, which groups
 * thousands. Quantities keep their grouping; years never get one.
 */
import { describe, expect, it } from 'vitest';
import { fullDate, num, yearLabel } from '../format';

describe('years are never grouped', () => {
  it('a year prints as four digits, in both languages', () => {
    expect(yearLabel(2026, true)).toBe('٢٠٢٦');
    expect(yearLabel(2026, false)).toBe('2026');
  });

  it('a full date carries the year without a separator', () => {
    expect(fullDate('2026-10-01T12:00:00Z', true)).toBe('١ أكتوبر ٢٠٢٦');
    expect(fullDate('2026-10-01T12:00:00Z', false)).toBe('Oct 1, 2026');
  });

  it('a quantity still groups its thousands', () => {
    expect(num(2026, true)).toBe('٢,٠٢٦');
    expect(num(2026, false)).toBe('2,026');
  });
});
