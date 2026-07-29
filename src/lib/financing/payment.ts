/**
 * Service 2 of 3 — payment mathematics.
 *
 * ONE method in V2: standard fixed-rate amortisation, used only when a
 * CONTRACTUAL rate or a manually entered bank QUOTATION exists.
 *
 * V1 carried schedule builders for balloon, step-up, flat-profit, staged
 * construction and off-plan disbursement, plus a cash-flow IRR APR solver. All
 * of it is gone. Those products now return "exact calculation requires a bank
 * quotation", which is what a rep would have to say anyway — none of those
 * banks publish the cash-flow method those builders were guessing at.
 *
 * APR is DISPLAYED as the bank publishes it. It is never derived here.
 */
import { round2 } from './money';

/**
 * Standard amortising payment.
 *
 *   payment = P·r·(1+r)^n / ((1+r)^n − 1)
 *
 * The zero-rate branch is not an edge case: Bank Albilad publishes 0% on the
 * subsidised tier for salaries at or below SAR 14,000, and the closed form
 * divides by zero there.
 */
export function monthlyPayment(principal: number, annualRatePct: number, termMonths: number): number {
  if (!(principal > 0) || !(termMonths > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return round2(principal / termMonths);
  const growth = Math.pow(1 + r, termMonths);
  return round2((principal * r * growth) / (growth - 1));
}

/**
 * The reverse: the largest principal a monthly capacity supports. This is what
 * turns "you can afford SAR 4,200/month" into "…which is about SAR 700,000".
 */
export function principalFromPayment(payment: number, annualRatePct: number, termMonths: number): number {
  if (!(payment > 0) || !(termMonths > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return round2(payment * termMonths);
  const growth = Math.pow(1 + r, termMonths);
  return round2((payment * (growth - 1)) / (r * growth));
}

export function totalRepayment(payment: number, termMonths: number): number {
  return round2(payment * termMonths);
}

export interface UpfrontCash {
  down_payment: number;
  transaction_tax: number | null;
  tax_relief: number | null;
  total: number;
  shortfall: number | null;
}

/**
 * Cash needed at closing.
 *
 * RETT is shown as its own line because by default the SELLER bears it — it
 * becomes the buyer's cash only when the deal puts it there, and a rep needs to
 * see the figure either way. First-home relief is applied up to the published
 * cap when the customer qualifies.
 */
export function upfrontCash(params: {
  propertyPrice: number;
  financingAmount: number;
  availableCash: number | null;
  isFirstHome: boolean | null;
  rett: { rate_pct: number; first_home_relief_cap: number | null } | null;
}): UpfrontCash {
  const downPayment = round2(Math.max(0, params.propertyPrice - params.financingAmount));

  let tax: number | null = null;
  let relief: number | null = null;
  if (params.rett && params.propertyPrice > 0) {
    tax = round2((params.propertyPrice * params.rett.rate_pct) / 100);
    if (params.isFirstHome === true && params.rett.first_home_relief_cap !== null) {
      const base = Math.min(params.propertyPrice, params.rett.first_home_relief_cap);
      relief = round2((base * params.rett.rate_pct) / 100);
    }
  }

  const total = round2(downPayment + (tax ?? 0) - (relief ?? 0));
  const shortfall = params.availableCash === null ? null : round2(Math.max(0, total - params.availableCash));

  return { down_payment: downPayment, transaction_tax: tax, tax_relief: relief, total, shortfall };
}
