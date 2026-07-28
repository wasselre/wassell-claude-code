/**
 * Payment / principal mathematics and cash-flow schedule construction.
 *
 * Each supported product family gets its OWN schedule builder rather than one
 * "mortgage formula" applied everywhere. Saudi Islamic products genuinely
 * differ in how cash flows fall — a Murabaha fixed-instalment sale, an Ijara
 * rental, a flat-profit contract and a staged off-plan disbursement do not
 * share a payment shape, and pretending they do is how a comparison table ends
 * up quietly wrong for half its rows.
 */
import {
  HALALAS,
  addMonths,
  fromHalalas,
  monthlyRateFromAnnualPct,
  round2,
  toHalalas,
} from './money';
import type { CalculationMethod, CashFlow } from './types';

/**
 * Standard amortising payment.
 *
 *   payment = P·r·(1+r)^n / ((1+r)^n − 1)
 *
 * The r = 0 branch is not a rounding edge case — a 0% profit rate is a REAL
 * Saudi product (Bank Albilad publishes 0% on subsidised financing for salaries
 * at or below SAR 14,000), and the closed form divides by zero there.
 */
export function monthlyPayment(principal: number, annualRatePct: number, termMonths: number): number {
  if (!(principal > 0) || !(termMonths > 0)) return 0;
  const r = monthlyRateFromAnnualPct(annualRatePct);
  if (r === 0) return round2(principal / termMonths);
  const growth = Math.pow(1 + r, termMonths);
  return round2((principal * r * growth) / (growth - 1));
}

/**
 * Reverse of the above: the largest principal a given monthly capacity supports.
 * This is what turns "you can afford SAR 4,200/month" into "…which is about
 * SAR 700,000".
 */
export function principalFromPayment(payment: number, annualRatePct: number, termMonths: number): number {
  if (!(payment > 0) || !(termMonths > 0)) return 0;
  const r = monthlyRateFromAnnualPct(annualRatePct);
  if (r === 0) return round2(payment * termMonths);
  const growth = Math.pow(1 + r, termMonths);
  return round2((payment * (growth - 1)) / (r * growth));
}

/** Flat-profit contract: profit accrues on the ORIGINAL principal for the whole
 *  term, so the instalment is (P + P·rate·years) / n. Materially more expensive
 *  than amortising at the same headline rate — which is exactly why the product
 *  version records its method instead of the engine assuming one. */
export function flatProfitPayment(principal: number, annualRatePct: number, termMonths: number): number {
  if (!(principal > 0) || !(termMonths > 0)) return 0;
  const years = termMonths / 12;
  const totalProfit = principal * (annualRatePct / 100) * years;
  return round2((principal + totalProfit) / termMonths);
}

export function flatProfitPrincipalFromPayment(payment: number, annualRatePct: number, termMonths: number): number {
  if (!(payment > 0) || !(termMonths > 0)) return 0;
  const years = termMonths / 12;
  const factor = 1 + (annualRatePct / 100) * years;
  return round2((payment * termMonths) / factor);
}

/** Payment when a balloon (final lump) sits at the end: the instalments only
 *  amortise (P − PV(balloon)). */
export function balloonPayment(
  principal: number,
  annualRatePct: number,
  termMonths: number,
  balloon: number,
): number {
  if (!(principal > 0) || !(termMonths > 0)) return 0;
  const r = monthlyRateFromAnnualPct(annualRatePct);
  if (r === 0) return round2((principal - balloon) / termMonths);
  const growth = Math.pow(1 + r, termMonths);
  const balloonPv = balloon / growth;
  const amortised = principal - balloonPv;
  return round2((amortised * r * growth) / (growth - 1));
}

export interface ScheduleOptions {
  principal: number;
  annualRatePct: number;
  termMonths: number;
  startDate: string;
  method: CalculationMethod;
  /** Months of interest-only / no-payment grace before instalments begin. */
  gracePeriodMonths?: number;
  balloon?: number | null;
  /** Step-up: the fixed instalment paid during the construction window, and
   *  how long that window lasts (Al Rajhi publishes both for off-plan). */
  stepUpInitialPayment?: number | null;
  stepUpMonths?: number | null;
  /** Upfront charges that belong in the APR cash flows. */
  upfrontFees?: Array<{ label: string; amount: number; includeInApr: boolean }>;
  /** Down payment the customer pays at closing. */
  downPayment?: number | null;
}

export interface Schedule {
  cashFlows: CashFlow[];
  monthlyPayment: number;
  totalRepayment: number;
  financingCost: number;
  /** True when the schedule is an approximation because the product's real
   *  cash-flow method is not published. */
  isApproximation: boolean;
  approximationNote: string | null;
}

/**
 * Build the full dated cash-flow schedule.
 *
 * The schedule is the single source for BOTH the displayed instalment and the
 * APR, so the two can never disagree — which is the failure mode where a screen
 * shows a monthly payment computed one way and an APR computed from something
 * else entirely.
 */
export function buildSchedule(opts: ScheduleOptions): Schedule {
  const {
    principal,
    annualRatePct,
    termMonths,
    startDate,
    method,
    gracePeriodMonths = 0,
    balloon = null,
    stepUpInitialPayment = null,
    stepUpMonths = null,
    upfrontFees = [],
    downPayment = null,
  } = opts;

  const flows: CashFlow[] = [];
  let seq = 0;

  // t=0: the financing is made available to the borrower.
  flows.push({
    sequence: seq++,
    date: startDate,
    type: 'disbursement',
    amount: round2(principal),
    direction: 'to_borrower',
    principal_component: null,
    profit_component: null,
    outstanding_balance: round2(principal),
    included_in_apr: true,
    label: 'Financing disbursement',
  });

  if (downPayment && downPayment > 0) {
    // Excluded from APR: the down payment is the customer's own equity, not a
    // cost of the credit. Including it would understate the APR.
    flows.push({
      sequence: seq++,
      date: startDate,
      type: 'down_payment',
      amount: round2(downPayment),
      direction: 'from_borrower',
      principal_component: null,
      profit_component: null,
      outstanding_balance: null,
      included_in_apr: false,
      label: 'Down payment',
    });
  }

  for (const fee of upfrontFees) {
    if (!(fee.amount > 0)) continue;
    flows.push({
      sequence: seq++,
      date: startDate,
      type: 'fee',
      amount: round2(fee.amount),
      direction: 'from_borrower',
      principal_component: null,
      profit_component: null,
      outstanding_balance: null,
      included_in_apr: fee.includeInApr,
      label: fee.label,
    });
  }

  let isApproximation = false;
  let approximationNote: string | null = null;
  let payment = 0;

  const balanceHalalas0 = toHalalas(principal);
  const monthlyRate = monthlyRateFromAnnualPct(annualRatePct);

  // ── Choose the instalment shape by the product's DOCUMENTED method ────────
  switch (method) {
    case 'flat_profit':
      payment = flatProfitPayment(principal, annualRatePct, termMonths);
      break;
    case 'balloon':
      payment = balloonPayment(principal, annualRatePct, termMonths, balloon ?? 0);
      break;
    case 'step_up':
      // The published step-up shape is: a low fixed instalment for the
      // construction window, then a normal amortising instalment over what is
      // left. The tail payment is derived from the balance actually remaining.
      payment = monthlyPayment(principal, annualRatePct, termMonths);
      break;
    case 'fixed_amortizing':
    case 'variable_benchmark_margin':
    case 'ijara_rental':
    case 'staged_construction':
    case 'off_plan_staged':
      payment = monthlyPayment(principal, annualRatePct, termMonths);
      break;
    case 'manual_quotation':
    case 'unknown':
    default:
      // We still produce numbers, but they are explicitly labelled an
      // approximation and the caller drops confidence to 'low'.
      payment = monthlyPayment(principal, annualRatePct, termMonths);
      isApproximation = true;
      approximationNote =
        'The provider does not publish this product’s cash-flow method; a standard amortising schedule was assumed.';
      break;
  }

  if (method === 'ijara_rental' || method === 'staged_construction' || method === 'off_plan_staged') {
    isApproximation = true;
    approximationNote =
      'Rental / staged-disbursement products settle on a schedule the provider sets per contract; the figures shown assume level payments over the full term.';
  }

  // ── Grace period: profit accrues, nothing is paid, balance grows ──────────
  let balanceH = balanceHalalas0;
  let cursor = startDate;
  for (let g = 0; g < gracePeriodMonths; g += 1) {
    cursor = addMonths(cursor, 1);
    const profitH = Math.round(balanceH * monthlyRate);
    balanceH += profitH;
    flows.push({
      sequence: seq++,
      date: cursor,
      type: 'installment',
      amount: 0,
      direction: 'from_borrower',
      principal_component: 0,
      profit_component: fromHalalas(profitH),
      outstanding_balance: fromHalalas(balanceH),
      included_in_apr: true,
      label: `Grace period month ${g + 1}`,
    });
  }

  const paymentMonths = Math.max(0, termMonths);
  const stepUpWindow = method === 'step_up' && stepUpMonths ? Math.min(stepUpMonths, paymentMonths) : 0;
  const stepUpAmountH = stepUpInitialPayment ? toHalalas(stepUpInitialPayment) : 0;

  // Tail payment for a step-up product: what the remaining months must carry.
  let tailPayment = payment;
  if (stepUpWindow > 0) {
    let projected = balanceH;
    for (let i = 0; i < stepUpWindow; i += 1) {
      const profitH = Math.round(projected * monthlyRate);
      projected = projected + profitH - stepUpAmountH;
    }
    const remainingMonths = paymentMonths - stepUpWindow;
    tailPayment =
      remainingMonths > 0 ? monthlyPayment(fromHalalas(projected), annualRatePct, remainingMonths) : 0;
  }

  let totalPaidH = 0;
  let totalProfitH = 0;

  for (let i = 0; i < paymentMonths; i += 1) {
    cursor = addMonths(cursor, 1);
    const isStepUpMonth = i < stepUpWindow;

    if (method === 'flat_profit') {
      // Flat profit: every instalment carries the same profit slice, and the
      // "outstanding balance" is a straight-line principal draw-down.
      const principalSliceH = Math.round(balanceHalalas0 / paymentMonths);
      const paymentH = toHalalas(payment);
      const profitSliceH = paymentH - principalSliceH;
      balanceH -= principalSliceH;
      totalPaidH += paymentH;
      totalProfitH += profitSliceH;
      flows.push({
        sequence: seq++,
        date: cursor,
        type: 'installment',
        amount: fromHalalas(paymentH),
        direction: 'from_borrower',
        principal_component: fromHalalas(principalSliceH),
        profit_component: fromHalalas(profitSliceH),
        outstanding_balance: fromHalalas(Math.max(0, balanceH)),
        included_in_apr: true,
        label: `Installment ${i + 1}`,
      });
      continue;
    }

    const nominalH = isStepUpMonth ? stepUpAmountH : toHalalas(stepUpWindow > 0 ? tailPayment : payment);
    const profitH = Math.round(balanceH * monthlyRate);
    let payH = nominalH;
    const isLast = i === paymentMonths - 1;

    // Final instalment absorbs accumulated rounding so the balance lands EXACTLY
    // at zero (or at the balloon). Without this the schedule ends a few halalas
    // off and the APR solver chases a phantom cash flow.
    if (isLast) {
      const balloonH = balloon ? toHalalas(balloon) : 0;
      payH = balanceH + profitH - balloonH;
      if (payH < 0) payH = 0;
    }

    const principalH = payH - profitH;
    balanceH = balanceH + profitH - payH;
    totalPaidH += payH;
    totalProfitH += profitH;

    flows.push({
      sequence: seq++,
      date: cursor,
      type: 'installment',
      amount: fromHalalas(payH),
      direction: 'from_borrower',
      principal_component: fromHalalas(principalH),
      profit_component: fromHalalas(profitH),
      outstanding_balance: fromHalalas(Math.max(0, balanceH)),
      included_in_apr: true,
      label: `Installment ${i + 1}`,
    });
  }

  if (balloon && balloon > 0) {
    totalPaidH += toHalalas(balloon);
    flows.push({
      sequence: seq++,
      date: cursor,
      type: 'balloon',
      amount: round2(balloon),
      direction: 'from_borrower',
      principal_component: round2(balloon),
      profit_component: 0,
      outstanding_balance: 0,
      included_in_apr: true,
      label: 'Balloon payment',
    });
  }

  const displayPayment = stepUpWindow > 0 ? round2(stepUpInitialPayment ?? payment) : payment;

  return {
    cashFlows: flows,
    monthlyPayment: displayPayment,
    totalRepayment: fromHalalas(totalPaidH),
    financingCost: fromHalalas(totalProfitH),
    isApproximation,
    approximationNote,
  };
}

/**
 * Largest principal a monthly capacity supports under a given method.
 * Mirrors buildSchedule's method switch so "what can I afford" and "what will I
 * pay" cannot drift apart.
 */
export function principalFromCapacity(
  capacity: number,
  annualRatePct: number,
  termMonths: number,
  method: CalculationMethod,
): number {
  if (!(capacity > 0) || !(termMonths > 0)) return 0;
  if (method === 'flat_profit') return flatProfitPrincipalFromPayment(capacity, annualRatePct, termMonths);
  return principalFromPayment(capacity, annualRatePct, termMonths);
}

/** Total of a schedule's outflows, in SAR — used to cross-check totals. */
export function scheduleOutflowTotal(flows: CashFlow[]): number {
  let totalH = 0;
  for (const f of flows) {
    if (f.direction === 'from_borrower') totalH += toHalalas(f.amount);
  }
  return totalH / HALALAS;
}
