import { describe, expect, it } from 'vitest';
import { formatVideoDuration } from '../transcripts';

describe('formatVideoDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatVideoDuration(34.8)).toBe('0:35');
    expect(formatVideoDuration(65)).toBe('1:05');
    expect(formatVideoDuration(600)).toBe('10:00');
  });
  it('rolls into hours past 60 minutes', () => {
    expect(formatVideoDuration(3725)).toBe('1:02:05');
  });
  it('never shows 60 in the seconds place', () => {
    expect(formatVideoDuration(59.6)).toBe('1:00');
  });
  it('returns null when there is no usable length', () => {
    expect(formatVideoDuration(null)).toBeNull();
    expect(formatVideoDuration(undefined)).toBeNull();
    expect(formatVideoDuration(0)).toBeNull();
    expect(formatVideoDuration(Number.NaN)).toBeNull();
  });
});
