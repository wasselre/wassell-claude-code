/**
 * Annual Percentage Rate, per SAMA's published methodology.
 *
 * SOURCE — SAMA "Rules Governing Calculation of the Annual Percentage Rate
 * (APR)", circular 45025707 dated 17/4/1445H (31/10/2023G), which superseded
 * Annex 1 of the Regulations for Consumer Financing (351000116619). The
 * defining equation:
 *
 *     Σ(d=1..m)  C_d / (1+X)^S_d   =   Σ(p=1..n)  B_p / (1+X)^t_p
 *
 *   C_d = amounts received BY the borrower,  S_d = years from the first flow
 *   B_p = amounts paid BY the borrower,      t_p = years from the first flow
 *   X   = the APR
 *
 * Two rules from the text that this implementation follows literally, because
 * getting either wrong shifts the answer by tens of basis points:
 *
 *  1. "periods between dates shall be based on a year of 12 equal months" —
 *     so the exponent is (months since first flow)/12, NOT actual/365. The
 *     `TWELVE_EQUAL_MONTHS` helper is the only place time enters the formula.
 *
 *  2. "the Total Amount Payable by the Borrower shall be determined, including
 *     all unavoidable costs and fees with the exception of charges and fees
 *     payable by the Borrower as a result of non-compliance" — so mandatory
 *     admin/valuation/insurance charges are IN, and default penalties are OUT.
 *     That decision is carried per-flow by `included_in_apr`, decided upstream
 *     where the fee's mandatory-ness is actually known.
 *
 * This is a cash-flow IRR. It is NOT a nominal-rate conversion, and the two
 * differ materially the moment any fee exists — which is the single most common
 * way an APR gets published wrong.
 */
import { roundPct } from './money';
import type { CashFlow } from './types';

/** SAMA's time convention: whole-month steps, twelve to a year. */
export function yearsFromFirstFlow(firstDateIso: string, dateIso: string): number {
  const [fy, fm, fd] = firstDateIso.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = dateIso.slice(0, 10).split('-').map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  const wholeMonths = (ty - fy) * 12 + (tm - fm);
  // Within-month fraction, expressed against a 30-day idealised month so a
  // disbursement on the 5th and a first payment on the 20th are not treated as
  // a full month apart.
  const dayFraction = (td - fd) / 30;
  return (wholeMonths + dayFraction) / 12;
}

export interface AprInput {
  flows: CashFlow[];
  /** Overrides the flow-level flag; used by tests to prove fee inclusion moves
   *  the APR. Production passes nothing and lets the flows decide. */
  includeAllFees?: boolean;
}

export interface AprResult {
  apr_pct: number | null;
  /** Why an APR could not be produced, when it could not. */
  reason: string | null;
  iterations: number;
  /** Residual of the NPV equation at the solution — a sanity check the tests
   *  assert on, and evidence the solve actually converged. */
  residual: number | null;
}

/** Net present value of the APR equation at a candidate annual rate. */
function npvAt(flows: CashFlow[], firstDate: string, annualRate: number, includeAll: boolean): number {
  let npv = 0;
  for (const f of flows) {
    if (!includeAll && !f.included_in_apr) continue;
    const t = yearsFromFirstFlow(firstDate, f.date);
    const discount = Math.pow(1 + annualRate, t);
    if (!Number.isFinite(discount) || discount === 0) continue;
    const signed = f.direction === 'to_borrower' ? f.amount : -f.amount;
    npv += signed / discount;
  }
  return npv;
}

/**
 * Solve for X. Bisection rather than Newton–Raphson on purpose: the cash-flow
 * profile here is a sign-regular annuity, so a bracketed bisection is
 * guaranteed to converge and cannot fly off to a nonsense root the way Newton
 * can when a schedule contains a balloon or a mid-term fee. Determinism beats
 * a few extra iterations — the same inputs must give the same basis points in
 * six months' time.
 */
export function calculateApr(input: AprInput): AprResult {
  const includeAll = input.includeAllFees === true;
  const flows = input.flows
    .filter((f) => (includeAll || f.included_in_apr) && f.amount !== 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sequence - b.sequence));

  if (flows.length < 2) {
    return { apr_pct: null, reason: 'not_enough_cash_flows', iterations: 0, residual: null };
  }
  const firstDate = flows[0]!.date;

  const received = flows.filter((f) => f.direction === 'to_borrower').reduce((s, f) => s + f.amount, 0);
  const paid = flows.filter((f) => f.direction === 'from_borrower').reduce((s, f) => s + f.amount, 0);
  if (received <= 0) {
    return { apr_pct: null, reason: 'no_disbursement', iterations: 0, residual: null };
  }
  if (paid <= 0) {
    return { apr_pct: null, reason: 'no_repayments', iterations: 0, residual: null };
  }
  // A total repayment at or below the amount received means a zero (or
  // negative) cost of credit. 0% financing is real in this market; report it
  // rather than letting the solver hunt for a negative root.
  if (paid <= received) {
    return { apr_pct: 0, reason: null, iterations: 0, residual: 0 };
  }

  let low = 0;
  let high = 1; // 100% — far above any Saudi retail product
  let npvLow = npvAt(flows, firstDate, low, includeAll);
  let npvHigh = npvAt(flows, firstDate, high, includeAll);

  // Expand the bracket if a pathological input sits outside it, but bound the
  // expansion so a malformed schedule fails loudly instead of looping.
  let expansions = 0;
  while (npvLow * npvHigh > 0 && expansions < 12) {
    high *= 2;
    npvHigh = npvAt(flows, firstDate, high, includeAll);
    expansions += 1;
  }
  if (npvLow * npvHigh > 0) {
    return { apr_pct: null, reason: 'no_sign_change_in_bracket', iterations: expansions, residual: null };
  }

  let mid = 0;
  let iterations = 0;
  const MAX_ITERATIONS = 200;
  // 1e-9 on the RATE is ~1e-7 of a basis point: far tighter than the two
  // basis points SAMA requires, so the rounding below is the only precision
  // loss in the pipeline.
  const TOLERANCE = 1e-9;

  while (iterations < MAX_ITERATIONS) {
    mid = (low + high) / 2;
    const npvMid = npvAt(flows, firstDate, mid, includeAll);
    if (Math.abs(npvMid) < 1e-7 || (high - low) / 2 < TOLERANCE) break;
    if (npvLow * npvMid <= 0) {
      high = mid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
    iterations += 1;
  }

  const residual = npvAt(flows, firstDate, mid, includeAll);
  // "expressed in percentage points with minimum two basis points" — roundPct
  // keeps four decimals of a percent, i.e. hundredths of a basis point, which
  // satisfies the minimum with room to spare.
  return { apr_pct: roundPct(mid * 100), reason: null, iterations, residual };
}

/**
 * Whether a compliant APR can be produced at all.
 *
 * When the contractual rate is unknown we can still build an approximate
 * schedule, but calling the resulting figure an APR would misrepresent it —
 * so the caller shows the PUBLISHED APR (labelled as published) instead of a
 * derived one. This helper is what makes that branch explicit rather than
 * incidental.
 */
export function canCalculateCompliantApr(params: {
  hasContractualRate: boolean;
  hasFeeData: boolean;
  methodKnown: boolean;
}): { ok: boolean; reason: string | null } {
  if (!params.hasContractualRate) {
    return { ok: false, reason: 'contractual_rate_unavailable' };
  }
  if (!params.methodKnown) {
    return { ok: false, reason: 'calculation_method_unknown' };
  }
  if (!params.hasFeeData) {
    // Fees are part of the mandated APR base; without them the number would be
    // understated. We return it anyway but the caller flags the gap, because a
    // fee-less APR is still more useful than none — as long as it says so.
    return { ok: true, reason: 'fees_unknown_apr_may_be_understated' };
  }
  return { ok: true, reason: null };
}
