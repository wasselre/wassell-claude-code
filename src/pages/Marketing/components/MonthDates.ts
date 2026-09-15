/**
 * Dates and money for the month screens — two shapes the shared helpers get
 * wrong for this page, isolated here so the fix is one place.
 *
 * 1. **A YEAR IS NOT A QUANTITY.** `format.ts`'s `fullDate` runs the year
 *    through `num()`, which inserts a thousands separator — so 2026 renders as
 *    «٢,٠٢٦», and the month screen shows a year in every week header, every
 *    computed date and every exception line. `monthDate` formats the year as
 *    digits only.
 *
 * 2. **A PER-LEAD PRICE NEEDS ITS DECIMAL.** `money()` rounds to whole riyals,
 *    which is right for a 6,000-riyal budget and wrong for a 13.15-riyal cost
 *    per lead: rounding turns «١٣٫٢» and «١٣٫٨» into the same number, and the
 *    weekly rule's whole point is a 20 % gap between two figures that close.
 *    `sar1` keeps one decimal, with the Arabic decimal mark «٫» that `num()`
 *    already applies.
 *
 * Both take the same `isAr` argument as every other formatter here, and both
 * return «—» for an absent value rather than a zero that reads as a measurement.
 */
import { num, toArabicDigits, monthName } from '../lib/format';

/** «٢٠ يوليو ٢٠٢٦» / "Jul 20, 2026" — the year never carries a separator. */
export function monthDate(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = num(d.getDate(), isAr);
  const mon = monthName(d.getMonth(), isAr);
  const year = isAr ? toArabicDigits(String(d.getFullYear())) : String(d.getFullYear());
  return isAr ? `${day} ${mon} ${year}` : `${mon} ${day}, ${year}`;
}

/** Riyals with ONE decimal — for per-lead prices, where the decimal decides. */
export function sar1(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const rounded = Math.round(v * 10) / 10;
  const body = Number.isInteger(rounded)
    ? num(rounded, isAr)
    : (isAr
      ? toArabicDigits(rounded.toFixed(1)).replace('.', '٫')
      : rounded.toFixed(1));
  return `${body} ${isAr ? 'ر.س' : 'SAR'}`;
}
