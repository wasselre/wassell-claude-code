/**
 * The Bayut flat-rate financing math, duplicated exactly (their webpack module
 * 90319, decompiled 2026-08-20):
 *
 *   downPayment  = price × dp%
 *   loan         = price − downPayment
 *   totalPayable = loan + loan × flatRate × years      ← simple/flat interest
 *   monthly      = totalPayable / (12 × years)
 *
 * NOTE this is a FLAT rate, not reducing-balance amortization — a 3.8% flat
 * rate over 15y costs about the same as a ~6.5% APR. That is exactly what
 * Bayut shows and what we were asked to duplicate; the UI prints the flat
 * rate next to the result so the basis is visible.
 */

export interface FinancingCalc {
  downPaymentAmount: number;
  totalLoanAmount: number;
  interestAmount: number;
  totalPayableValue: number;
  /** Share of the total that is interest, 0..1 (drives the donut). */
  interestShare: number;
  monthlyInstalment: number;
}

export function calcFinancing(price: number, downPaymentAmount: number, years: number, flatRate: number): FinancingCalc {
  const loan = Math.max(0, price - downPaymentAmount);
  const interest = loan * flatRate * years;
  const total = loan + interest;
  const months = 12 * years;
  return {
    downPaymentAmount,
    totalLoanAmount: loan,
    interestAmount: interest,
    totalPayableValue: total,
    interestShare: total > 0 ? interest / total : 0,
    monthlyInstalment: months > 0 ? total / months : 0,
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
