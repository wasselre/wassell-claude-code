import { describe, it, expect } from 'vitest';
import { forecastCycles, creativeTotals } from '../refresh';
import { DEFAULT_CALENDAR } from '../calendar';
import { DEFAULTS, type PaidPolicy } from '../types';

const CAL = DEFAULT_CALENDAR;

const policy = (over: Partial<PaidPolicy> = {}): PaidPolicy => ({
  ...DEFAULTS.paid,
  bankedSpares: [],
  ...over,
});

const fc = (startsOn: string, endsOn: string, p: Partial<PaidPolicy> = {}) =>
  forecastCycles({ executionKey: 'e1', startsOn, endsOn, policy: policy(p) }, CAL);

describe('paid refresh forecasting — calculated, never hardcoded', () => {
  it('a 30-day campaign from 2026-10-01 keeps three refreshes and skips the last short one', () => {
    const cycles = fc('2026-10-01', '2026-10-30');
    expect(cycles.map((c) => ({ round: c.round, refreshOn: c.refreshOn, produced: c.produced }))).toEqual([
      { round: 0, refreshOn: '2026-10-01', produced: 5 },
      { round: 1, refreshOn: '2026-10-08', produced: 5 },
      { round: 2, refreshOn: '2026-10-15', produced: 5 },
      { round: 3, refreshOn: '2026-10-22', produced: 5 },
      { round: 4, refreshOn: '2026-10-29', produced: 0 }, // only 2 days left < 3
    ]);
    expect(cycles[4].note).toMatch(/skipped/);
    expect(creativeTotals(cycles)).toEqual({
      initial: 5, replacements: 12, fifths: 3, total: 20, cycles: 3,
    });
  });

  it('derives ready / production-start / decision dates on the real working calendar', () => {
    const cycles = fc('2026-10-01', '2026-10-30');
    const r1 = cycles.find((c) => c.round === 1)!;
    expect(r1.readyBy).toBe('2026-10-07');          // one working day before Thu Oct 8
    expect(r1.productionStartOn).toBe('2026-09-30'); // 7 working days up to and including Oct 7
    expect(r1.decisionDueOn).toBe('2026-10-07');
    const r2 = cycles.find((c) => c.round === 2)!;
    expect(r2.readyBy).toBe('2026-10-14');
    expect(r2.productionStartOn).toBe('2026-10-07');
  });

  it('cycle k+1 starts producing before cycle k decides — production cannot wait for a winner', () => {
    const cycles = fc('2026-10-01', '2026-10-30');
    const r1 = cycles.find((c) => c.round === 1)!;
    const r2 = cycles.find((c) => c.round === 2)!;
    expect(r2.productionStartOn! <= r1.decisionDueOn!).toBe(true);
  });

  it('policy B produces four per refresh and leaves the fifth conditional', () => {
    const cycles = fc('2026-10-01', '2026-10-30', { fifthPolicy: 'B' });
    expect(creativeTotals(cycles)).toEqual({
      initial: 5, replacements: 12, fifths: 0, total: 17, cycles: 3,
    });
    expect(cycles[1].note).toMatch(/conditional/);
  });

  it('a banked spare reduces exactly ONE cycle and is earmarked exclusively', () => {
    const cycles = fc('2026-10-01', '2026-10-30', {
      bankedSpares: [{ slotId: 'slot-aaaaaaaa-1111', availableFrom: '2026-09-20' }],
    });
    const reduced = cycles.filter((c) => c.bankedSpareSlotId);
    expect(reduced).toHaveLength(1);
    expect(reduced[0].round).toBe(1);          // earliest eligible cycle
    expect(reduced[0].produced).toBe(4);
    expect(creativeTotals(cycles).total).toBe(19);
    // Two spares → two cycles, never the same slot twice.
    const two = fc('2026-10-01', '2026-10-30', {
      bankedSpares: [
        { slotId: 'slot-a', availableFrom: '2026-09-20' },
        { slotId: 'slot-b', availableFrom: '2026-09-21' },
      ],
    });
    const ids = two.filter((c) => c.bankedSpareSlotId).map((c) => c.bankedSpareSlotId);
    expect(ids).toEqual(['slot-a', 'slot-b']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a spare that only becomes known AFTER a cycle starts producing cannot reduce it', () => {
    // Cycle 1 starts producing 2026-09-30; a spare known from Oct 7 is too late
    // for it, and lands on the next eligible cycle instead.
    const cycles = fc('2026-10-01', '2026-10-30', {
      bankedSpares: [{ slotId: 'late', availableFrom: '2026-10-07' }],
    });
    const reduced = cycles.filter((c) => c.bankedSpareSlotId);
    expect(reduced).toHaveLength(1);
    expect(reduced[0].round).toBe(3);      // production starts 2026-10-14 > 2026-10-07
    expect(cycles.find((c) => c.round === 1)!.produced).toBe(5);
  });

  it('short campaigns get no refresh at all, long ones get proportionally more', () => {
    expect(creativeTotals(fc('2026-10-01', '2026-10-05')).total).toBe(5);   // 5 days, no refresh
    expect(creativeTotals(fc('2026-10-01', '2026-10-14')).cycles).toBe(1);
    expect(creativeTotals(fc('2026-10-01', '2026-11-14')).cycles).toBe(6);
  });

  it('minRemainingDays decides whether the final partial week earns a refresh', () => {
    expect(fc('2026-10-01', '2026-10-30', { minRemainingDays: 1 }).filter((c) => c.produced > 0 && c.round > 0)).toHaveLength(4);
    expect(fc('2026-10-01', '2026-10-30', { minRemainingDays: 5 }).filter((c) => c.produced > 0 && c.round > 0)).toHaveLength(3);
  });
});
