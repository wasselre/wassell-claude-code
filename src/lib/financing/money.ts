/**
 * Money and rate arithmetic for the financing engine.
 *
 * WHY THIS FILE EXISTS: a mortgage schedule is 360 additions of a rounded
 * number. Doing that in raw floats leaves the final balance a few halalas off
 * zero, which then shows up as a bogus last installment or an APR that differs
 * in the 3rd decimal between two runs of the SAME inputs. Reproducibility is a
 * hard requirement here, so all schedule arithmetic runs in INTEGER HALALAS
 * (1 SAR = 100 halalas) and only converts back at the boundary.
 */

/** Halalas per riyal. */
export const HALALAS = 100;

/** SAR → integer halalas, half-up. */
export function toHalalas(sar: number): number {
  return Math.round(sar * HALALAS);
}

/** Integer halalas → SAR with 2 decimals. */
export function fromHalalas(halalas: number): number {
  return Math.round(halalas) / HALALAS;
}

/** Round a SAR amount to 2 decimals, half-up, without float drift. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Round a percentage to 4 decimals — one basis point is 0.01%, and SAMA's APR
 *  rules require at least two basis points of precision. */
export function roundPct(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * A percentage as an explicit unit. Percent values in this codebase are ALWAYS
 * "per hundred" (5.96 means 5.96%), never fractions — mixing the two is the
 * classic way to ship a 100x-wrong installment.
 */
export function pctToFraction(pct: number): number {
  return pct / 100;
}

export function fractionToPct(fraction: number): number {
  return fraction * 100;
}

/** Nominal annual rate → periodic (monthly) rate, the convention Saudi
 *  amortising products quote: simple division, not compounding. */
export function monthlyRateFromAnnualPct(annualPct: number): number {
  return pctToFraction(annualPct) / 12;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Sum that ignores nulls WITHOUT turning them into zeros in the caller's mind.
 * Returns null when EVERY input is null, so "no data" stays distinguishable
 * from "adds up to zero" — the distinction this whole system rests on.
 */
export function sumOrNull(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const v of values) {
    if (isFiniteNumber(v)) {
      total += v;
      seen = true;
    }
  }
  return seen ? round2(total) : null;
}

/** Smallest non-null value, or null when there is nothing to compare. */
export function minOrNull(values: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (isFiniteNumber(v) && (best === null || v < best)) best = v;
  }
  return best;
}

/** Add whole months to an ISO date, clamping the day to the target month's
 *  length so 31 Jan + 1 month lands on 28/29 Feb rather than rolling into March. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`addMonths: invalid date ${isoDate}`);
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInTarget);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Whole months between two ISO dates (floor). */
export function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = toIso.slice(0, 10).split('-').map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
}

/** Whole days between two ISO dates. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Age in whole years on a given date. */
export function ageOn(dateOfBirthIso: string, onIso: string): number | null {
  const months = monthsBetween(dateOfBirthIso, onIso);
  if (!Number.isFinite(months)) return null;
  return Math.floor(months / 12);
}

/**
 * Thousands separators for a whole number, without `toLocaleString`.
 *
 * These strings go into the frozen `result_snapshot`, so they must not depend on
 * the ICU data of whichever runtime happened to render them.
 */
export function groupDigits(value: number): string {
  const n = Math.round(value);
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
