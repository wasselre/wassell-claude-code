import { describe, expect, it } from 'vitest';
import { calcFinancing, clamp } from '../calc';
import { DEFAULT_BANKS, rateFor } from '../banks';

/**
 * Parity fixtures measured live on bayut.sa (2026-08-20). If these fail, the
 * flat-rate formula drifted from the thing we set out to duplicate.
 */
describe('calcFinancing (Bayut parity)', () => {
  const nbd = DEFAULT_BANKS.find((b) => b.slug === 'emirates-nbd')!;
  const bsf = DEFAULT_BANKS.find((b) => b.slug === 'bsf')!;

  it('750k, 10% down, 15y, Emirates NBD → 5,888/mo, total 1,059,750', () => {
    const r = calcFinancing(750_000, 75_000, 15, rateFor(nbd, 15));
    expect(r.totalLoanAmount).toBe(675_000);
    expect(r.totalPayableValue).toBeCloseTo(1_059_750, 0);
    expect(Math.round(r.monthlyInstalment)).toBe(5_888); // 5,887.5 → UI rounds to 5,888
  });

  it('750k, 10% down, 15y, BSF → total 1,064,813', () => {
    const r = calcFinancing(750_000, 75_000, 15, rateFor(bsf, 15));
    expect(Math.round(r.totalPayableValue)).toBe(1_064_813);
  });

  it('1,599,000, 10% down, 15y, Emirates NBD → total 2,259,387 (no 1M tiering)', () => {
    const r = calcFinancing(1_599_000, 159_900, 15, rateFor(nbd, 15));
    expect(r.totalLoanAmount).toBe(1_439_100);
    expect(Math.round(r.totalPayableValue)).toBe(2_259_387);
  });

  it('zero-financing edge: full down payment → nothing due monthly', () => {
    const r = calcFinancing(500_000, 500_000, 15, 0.038);
    expect(r.totalLoanAmount).toBe(0);
    expect(r.monthlyInstalment).toBe(0);
    expect(r.interestShare).toBe(0);
  });
});

describe('rate table', () => {
  it('every bank has a rate for every tenure 5..25', () => {
    for (const b of DEFAULT_BANKS) {
      for (let y = 5; y <= 25; y++) {
        expect(b.rates[y], `${b.slug} @ ${y}y`).toBeGreaterThan(0);
        expect(b.rates[y]).toBeLessThan(0.2);
      }
    }
  });

  it('unknown tenure falls back to the default rate', () => {
    expect(rateFor(DEFAULT_BANKS[0], 99)).toBe(0.036);
    expect(rateFor(null, 15)).toBe(0.036);
  });
});

describe('clamp', () => {
  it('clamps and survives NaN', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 3, 10)).toBe(3);
  });
});
