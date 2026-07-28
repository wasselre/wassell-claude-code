import { describe, it, expect } from 'vitest';
import {
  balloonPayment,
  buildSchedule,
  flatProfitPayment,
  flatProfitPrincipalFromPayment,
  monthlyPayment,
  principalFromPayment,
  scheduleOutflowTotal,
} from '../payment';
import { addMonths, monthsBetween, ageOn, round2 } from '../money';

describe('monthlyPayment — standard amortising', () => {
  it('matches the closed-form annuity for a known case', () => {
    // 500,000 @ 5% over 20 years. Hand-checked against the annuity formula:
    // r = 0.05/12, n = 240 → 3,299.78
    expect(monthlyPayment(500_000, 5, 240)).toBeCloseTo(3299.78, 2);
  });

  it('handles a 0% product without dividing by zero', () => {
    // Not hypothetical: Bank Albilad publishes 0% on subsidised financing for
    // salaries at or below SAR 14,000.
    expect(monthlyPayment(600_000, 0, 300)).toBe(2000);
  });

  it('returns 0 for a non-positive principal or term', () => {
    expect(monthlyPayment(0, 5, 240)).toBe(0);
    expect(monthlyPayment(500_000, 5, 0)).toBe(0);
  });

  it('is monotonic in rate and in term', () => {
    expect(monthlyPayment(500_000, 6, 240)).toBeGreaterThan(monthlyPayment(500_000, 5, 240));
    expect(monthlyPayment(500_000, 5, 180)).toBeGreaterThan(monthlyPayment(500_000, 5, 360));
  });

  it('survives very small and very large amounts', () => {
    expect(monthlyPayment(1000, 5, 60)).toBeGreaterThan(0);
    const big = monthlyPayment(25_000_000, 5, 240);
    expect(Number.isFinite(big)).toBe(true);
    expect(big).toBeGreaterThan(0);
  });

  it('handles the maximum published Saudi term (30 years)', () => {
    expect(monthlyPayment(5_000_000, 5, 360)).toBeCloseTo(26841.08, 1);
  });
});

describe('principalFromPayment — the reverse direction', () => {
  it('round-trips against monthlyPayment to within a riyal', () => {
    // Not exact, and shouldn't be: monthlyPayment rounds to the halala, so
    // inverting a rounded instalment cannot recover the principal bit-for-bit.
    // A sub-riyal gap on 750k is the rounding, not an error — asserting
    // equality here would be asserting a false precision.
    const principal = 750_000;
    const pay = monthlyPayment(principal, 4.5, 300);
    expect(Math.abs(principalFromPayment(pay, 4.5, 300) - principal)).toBeLessThan(1);
  });

  it('round-trips at 0%', () => {
    const pay = monthlyPayment(600_000, 0, 300);
    expect(principalFromPayment(pay, 0, 300)).toBeCloseTo(600_000, 2);
  });

  it('turns a monthly capacity into a sensible principal', () => {
    // 4,000/month at 5% over 25 years supports roughly 684k.
    expect(principalFromPayment(4000, 5, 300)).toBeGreaterThan(600_000);
    expect(principalFromPayment(4000, 5, 300)).toBeLessThan(750_000);
  });
});

describe('flat-profit contracts', () => {
  it('charges profit on the ORIGINAL principal for the whole term', () => {
    // 100,000 @ 5% flat for 5 years = 25,000 profit → 125,000 / 60 = 2,083.33
    expect(flatProfitPayment(100_000, 5, 60)).toBeCloseTo(2083.33, 2);
  });

  it('is more expensive than amortising at the same headline rate', () => {
    // This is exactly why the engine refuses to assume one method for all
    // products: same "5%", materially different instalment.
    expect(flatProfitPayment(100_000, 5, 60)).toBeGreaterThan(monthlyPayment(100_000, 5, 60));
  });

  it('round-trips its own reverse', () => {
    const pay = flatProfitPayment(300_000, 6, 120);
    expect(flatProfitPrincipalFromPayment(pay, 6, 120)).toBeCloseTo(300_000, 0);
  });
});

describe('balloon payments', () => {
  it('lowers the instalment relative to a fully amortising schedule', () => {
    const withBalloon = balloonPayment(500_000, 5, 240, 100_000);
    expect(withBalloon).toBeLessThan(monthlyPayment(500_000, 5, 240));
  });

  it('equals the standard payment when the balloon is zero', () => {
    expect(balloonPayment(500_000, 5, 240, 0)).toBeCloseTo(monthlyPayment(500_000, 5, 240), 2);
  });
});

describe('buildSchedule', () => {
  const base = {
    principal: 500_000,
    annualRatePct: 5,
    termMonths: 240,
    startDate: '2026-08-01',
    method: 'fixed_amortizing' as const,
  };

  it('produces one disbursement plus one flow per instalment', () => {
    const s = buildSchedule(base);
    expect(s.cashFlows.filter((f) => f.type === 'disbursement')).toHaveLength(1);
    expect(s.cashFlows.filter((f) => f.type === 'installment')).toHaveLength(240);
  });

  it('drives the balance to EXACTLY zero on the final instalment', () => {
    // The rounding-absorption rule. Without it the schedule ends a few halalas
    // off and the APR solver chases a phantom cash flow.
    const s = buildSchedule(base);
    const last = s.cashFlows.filter((f) => f.type === 'installment').at(-1)!;
    expect(last.outstanding_balance).toBe(0);
  });

  it('total repayment equals the sum of its own instalments', () => {
    const s = buildSchedule(base);
    const installmentTotal = s.cashFlows
      .filter((f) => f.type === 'installment')
      .reduce((sum, f) => sum + f.amount, 0);
    expect(round2(installmentTotal)).toBeCloseTo(s.totalRepayment, 2);
  });

  it('financing cost equals total repayment minus principal', () => {
    const s = buildSchedule(base);
    expect(s.financingCost).toBeCloseTo(round2(s.totalRepayment - base.principal), 1);
  });

  it('marks an unknown calculation method as an approximation', () => {
    const s = buildSchedule({ ...base, method: 'unknown' });
    expect(s.isApproximation).toBe(true);
    expect(s.approximationNote).toContain('does not publish');
  });

  it('does NOT mark a documented fixed-amortising product as an approximation', () => {
    expect(buildSchedule(base).isApproximation).toBe(false);
  });

  it('accrues profit during a grace period without taking a payment', () => {
    const s = buildSchedule({ ...base, gracePeriodMonths: 3 });
    const grace = s.cashFlows.filter((f) => f.label.startsWith('Grace period'));
    expect(grace).toHaveLength(3);
    expect(grace.every((f) => f.amount === 0)).toBe(true);
    // Balance grows because unpaid profit capitalises.
    expect(grace.at(-1)!.outstanding_balance!).toBeGreaterThan(base.principal);
  });

  it('excludes the down payment from APR flows but includes mandatory fees', () => {
    const s = buildSchedule({
      ...base,
      downPayment: 200_000,
      upfrontFees: [{ label: 'Administrative fee', amount: 5000, includeInApr: true }],
    });
    const down = s.cashFlows.find((f) => f.type === 'down_payment')!;
    const fee = s.cashFlows.find((f) => f.type === 'fee')!;
    expect(down.included_in_apr).toBe(false);
    expect(fee.included_in_apr).toBe(true);
  });

  it('adds a balloon flow at the end when one is set', () => {
    const s = buildSchedule({ ...base, method: 'balloon', balloon: 100_000 });
    const balloonFlow = s.cashFlows.find((f) => f.type === 'balloon');
    expect(balloonFlow?.amount).toBe(100_000);
  });

  it('step-up shows the LOW construction-period instalment as the headline', () => {
    const s = buildSchedule({
      ...base,
      method: 'step_up',
      stepUpInitialPayment: 400,
      stepUpMonths: 36,
    });
    // Al Rajhi's published shape: SAR 400/month during construction.
    expect(s.monthlyPayment).toBe(400);
    const first = s.cashFlows.filter((f) => f.type === 'installment')[0]!;
    expect(first.amount).toBe(400);
    // ...and the tail must be materially higher to repay the arrears.
    const tail = s.cashFlows.filter((f) => f.type === 'installment')[40]!;
    expect(tail.amount).toBeGreaterThan(400);
  });

  it('flat-profit schedule keeps every instalment identical', () => {
    const s = buildSchedule({ ...base, method: 'flat_profit', termMonths: 60 });
    const amounts = s.cashFlows.filter((f) => f.type === 'installment').map((f) => f.amount);
    const unique = new Set(amounts.map((a) => a.toFixed(2)));
    expect(unique.size).toBe(1);
  });

  it('outflow total covers instalments, fees and the down payment', () => {
    const s = buildSchedule({ ...base, downPayment: 100_000, upfrontFees: [{ label: 'Fee', amount: 5000, includeInApr: true }] });
    expect(scheduleOutflowTotal(s.cashFlows)).toBeGreaterThan(s.totalRepayment);
  });

  it('is deterministic — identical inputs give byte-identical output', () => {
    // The property the whole reproducibility guarantee rests on.
    expect(JSON.stringify(buildSchedule(base))).toBe(JSON.stringify(buildSchedule(base)));
  });
});

describe('date helpers', () => {
  it('clamps a month-end rollover instead of spilling into the next month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap year
  });

  it('advances across a year boundary', () => {
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('counts whole months only', () => {
    expect(monthsBetween('2026-01-15', '2026-07-14')).toBe(5);
    expect(monthsBetween('2026-01-15', '2026-07-15')).toBe(6);
  });

  it('computes age on a date', () => {
    expect(ageOn('1990-01-15', '2026-07-28')).toBe(36);
    expect(ageOn('1990-08-15', '2026-07-28')).toBe(35);
  });
});
