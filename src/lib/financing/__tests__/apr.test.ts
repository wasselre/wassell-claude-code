import { describe, it, expect } from 'vitest';
import { calculateApr, canCalculateCompliantApr, yearsFromFirstFlow } from '../apr';
import { buildSchedule } from '../payment';
import type { CashFlow } from '../types';

describe('yearsFromFirstFlow — SAMA’s twelve-equal-months convention', () => {
  it('counts a year as 12 equal months, not actual/365', () => {
    expect(yearsFromFirstFlow('2026-01-01', '2027-01-01')).toBeCloseTo(1, 10);
    expect(yearsFromFirstFlow('2026-01-01', '2026-07-01')).toBeCloseTo(0.5, 10);
  });

  it('is zero at the first flow (SAMA: S1 = 0)', () => {
    expect(yearsFromFirstFlow('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('accounts for a within-month offset between disbursement and first payment', () => {
    const t = yearsFromFirstFlow('2026-01-05', '2026-01-20');
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1 / 12);
  });
});

describe('calculateApr — cash-flow IRR', () => {
  const schedule = (rate: number, fees: Array<{ label: string; amount: number; includeInApr: boolean }> = []) =>
    buildSchedule({
      principal: 500_000,
      annualRatePct: rate,
      termMonths: 240,
      startDate: '2026-08-01',
      method: 'fixed_amortizing',
      upfrontFees: fees,
    });

  it('with NO fees, the APR is the EFFECTIVE annual rate — above the nominal rate', () => {
    // A result worth stating plainly, because it surprises people and drives UI
    // copy: SAMA's APR equation discounts at (1+X)^t with t measured in YEARS,
    // so X is an EFFECTIVE annual rate. A product contracted at a nominal 5%
    // paid monthly therefore has an APR of (1 + 0.05/12)^12 − 1 = 5.1162%
    // BEFORE a single fee is added. APR is never equal to the profit rate, and
    // a rep who quotes them interchangeably is quoting the customer wrong.
    const expectedEffective = (Math.pow(1 + 0.05 / 12, 12) - 1) * 100; // 5.1162
    const apr = calculateApr({ flows: schedule(5).cashFlows });
    expect(apr.apr_pct).not.toBeNull();
    expect(apr.apr_pct!).toBeCloseTo(expectedEffective, 2);
    expect(apr.apr_pct!).toBeGreaterThan(5);
  });

  it('a mandatory upfront fee RAISES the APR above the contractual rate', () => {
    // The entire reason APR must be a cash-flow IRR rather than a nominal-rate
    // conversion. Same 5% contract, more cost, higher APR.
    const noFee = calculateApr({ flows: schedule(5).cashFlows }).apr_pct!;
    const withFee = calculateApr({
      flows: schedule(5, [{ label: 'Administrative fee', amount: 5000, includeInApr: true }]).cashFlows,
    }).apr_pct!;
    expect(withFee).toBeGreaterThan(noFee);
  });

  it('a fee flagged OUT of the APR does not move it', () => {
    const noFee = calculateApr({ flows: schedule(5).cashFlows }).apr_pct!;
    const excluded = calculateApr({
      flows: schedule(5, [{ label: 'Late penalty', amount: 5000, includeInApr: false }]).cashFlows,
    }).apr_pct!;
    expect(excluded).toBeCloseTo(noFee, 3);
  });

  it('returns exactly 0 for a 0% product', () => {
    const apr = calculateApr({ flows: schedule(0).cashFlows });
    expect(apr.apr_pct).toBe(0);
  });

  it('converges with a small residual', () => {
    const apr = calculateApr({ flows: schedule(6).cashFlows });
    expect(Math.abs(apr.residual!)).toBeLessThan(1);
  });

  it('is monotonic in the contractual rate', () => {
    const a = calculateApr({ flows: schedule(4).cashFlows }).apr_pct!;
    const b = calculateApr({ flows: schedule(7).cashFlows }).apr_pct!;
    expect(b).toBeGreaterThan(a);
  });

  it('handles irregular dates (a balloon at the end)', () => {
    const s = buildSchedule({
      principal: 500_000,
      annualRatePct: 5,
      termMonths: 120,
      startDate: '2026-08-15',
      method: 'balloon',
      balloon: 150_000,
    });
    const apr = calculateApr({ flows: s.cashFlows });
    expect(apr.apr_pct).not.toBeNull();
    expect(apr.apr_pct!).toBeGreaterThan(0);
  });

  it('reports a reason instead of a number when there is no disbursement', () => {
    const flows: CashFlow[] = [
      {
        sequence: 0, date: '2026-08-01', type: 'installment', amount: 1000,
        direction: 'from_borrower', principal_component: null, profit_component: null,
        outstanding_balance: null, included_in_apr: true, label: 'x',
      },
      {
        sequence: 1, date: '2026-09-01', type: 'installment', amount: 1000,
        direction: 'from_borrower', principal_component: null, profit_component: null,
        outstanding_balance: null, included_in_apr: true, label: 'y',
      },
    ];
    const apr = calculateApr({ flows });
    expect(apr.apr_pct).toBeNull();
    expect(apr.reason).toBe('no_disbursement');
  });

  it('reports a reason with too few flows rather than guessing', () => {
    const apr = calculateApr({ flows: [] });
    expect(apr.apr_pct).toBeNull();
    expect(apr.reason).toBe('not_enough_cash_flows');
  });

  it('is deterministic across repeated solves', () => {
    const flows = schedule(5.37).cashFlows;
    expect(calculateApr({ flows }).apr_pct).toBe(calculateApr({ flows }).apr_pct);
  });

  it('resolves to at least two basis points of precision', () => {
    const apr = calculateApr({ flows: schedule(5.375).cashFlows }).apr_pct!;
    // roundPct keeps 4 decimals of a percent = hundredths of a basis point.
    expect(String(apr).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

describe('canCalculateCompliantApr — when we may NOT call a number an APR', () => {
  it('refuses without a contractual rate', () => {
    const r = canCalculateCompliantApr({ hasContractualRate: false, hasFeeData: true, methodKnown: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('contractual_rate_unavailable');
  });

  it('refuses when the product’s cash-flow method is unknown', () => {
    const r = canCalculateCompliantApr({ hasContractualRate: true, hasFeeData: true, methodKnown: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('calculation_method_unknown');
  });

  it('allows but flags understatement when fees are unpublished', () => {
    const r = canCalculateCompliantApr({ hasContractualRate: true, hasFeeData: false, methodKnown: true });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('fees_unknown_apr_may_be_understated');
  });

  it('is clean when everything is known', () => {
    const r = canCalculateCompliantApr({ hasContractualRate: true, hasFeeData: true, methodKnown: true });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });
});
