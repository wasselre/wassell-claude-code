import { describe, it, expect } from 'vitest';
import { inZone, relPos } from './zones';

describe('zone geometric bands — mirror of wassell_city_zone_districts', () => {
  it('north = top 40% by latitude; south = bottom 40%', () => {
    expect(inZone('north', 0.9, 0.5)).toBe(true);
    expect(inZone('north', 0.6, 0.5)).toBe(true);
    expect(inZone('north', 0.59, 0.5)).toBe(false);
    expect(inZone('south', 0.1, 0.5)).toBe(true);
    expect(inZone('south', 0.41, 0.5)).toBe(false);
  });

  it('east/west by longitude', () => {
    expect(inZone('east', 0.5, 0.8)).toBe(true);
    expect(inZone('west', 0.5, 0.2)).toBe(true);
    expect(inZone('east', 0.5, 0.5)).toBe(false);
  });

  it('center is the middle box', () => {
    expect(inZone('center', 0.5, 0.5)).toBe(true);
    expect(inZone('center', 0.9, 0.5)).toBe(false);
  });

  it('diagonals require both axes', () => {
    expect(inZone('northeast', 0.7, 0.7)).toBe(true);
    expect(inZone('northeast', 0.7, 0.4)).toBe(false);
    expect(inZone('southwest', 0.2, 0.2)).toBe(true);
  });

  it('relPos normalizes and is robust to a degenerate range', () => {
    expect(relPos(24.825, 24.364, 25.132)).toBeCloseTo(0.6, 1); // Riyadh north cutoff
    expect(relPos(5, 5, 5)).toBe(0.5);
  });
});
