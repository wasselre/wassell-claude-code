/**
 * «مهامي» › «الفريق» — the pure half of the Team tab (2026-09-27).
 *
 * The server computes every count (mos_team_kpis — one SQL definition). This
 * file only turns those counts into what the page shows: an on-time rate, a
 * load level per day for the 30-day strip, the order people are listed in, and
 * the words for a bucket. No fetching, no React — so it is tested directly.
 */
import type { TeamKpiCounts, TeamKpiDay, TeamKpiPerson } from '@/lib/marketingOS/client';
import { dayName, num, shortDate } from './format';

/**
 * On-time rate, 0–100: on-time tasks ÷ finished tasks that HAD a deadline.
 * A task without a deadline can be neither on time nor late, so it is left out
 * of both sides. Null when nothing with a deadline was finished — shown as «—»,
 * never as 0% or 100%.
 */
export function onTimeRate(c: Pick<TeamKpiCounts, 'done' | 'done_late' | 'done_no_deadline'>): number | null {
  const withDeadline = c.done - c.done_no_deadline;
  if (withDeadline <= 0) return null;
  return (100 * (withDeadline - c.done_late)) / withDeadline;
}

/** Green from 75%, amber from 50%, red below — the same bands as the mockup. */
export type RateTone = 'good' | 'fair' | 'poor';
export function rateTone(rate: number): RateTone {
  if (rate >= 75) return 'good';
  if (rate >= 50) return 'fair';
  return 'poor';
}

/**
 * How full one day is:
 *   off   — weekend or holiday, nothing booked
 *   leave — approved leave, nothing booked
 *   empty — a working day with nothing booked
 *   light — under 60% of the daily limit
 *   busy  — 60% up to (not including) the limit
 *   full  — exactly at the limit
 *   over  — past the limit, OR anything booked on a day off / on leave / in a
 *           bucket where the person has no limit at all
 * With two buckets (a writer who also checks designs) the fuller one decides.
 */
export type LoadLevel = 'off' | 'leave' | 'empty' | 'light' | 'busy' | 'full' | 'over';

const EPS = 1e-6;

export function dayLevel(d: TeamKpiDay): LoadLevel {
  const booked = d.loads.filter((l) => l.units > EPS);
  if (booked.length === 0) {
    if (d.leave) return 'leave';
    if (d.off) return 'off';
    return 'empty';
  }
  if (d.leave || d.off) return 'over';
  let worst = 0;
  for (const l of booked) {
    if (l.capacity <= 0) return 'over';
    worst = Math.max(worst, l.units / l.capacity);
  }
  if (worst > 1 + EPS) return 'over';
  if (worst >= 1 - EPS) return 'full';
  if (worst >= 0.6) return 'busy';
  return 'light';
}

/**
 * Today's booked work against the daily limit, fullest bucket first — what
 * «اليوم ٧ من ٧» shows. Buckets with nothing booked today are dropped unless
 * nothing is booked at all, in which case the first bucket still shows its
 * limit («٠ من ١٠»). Empty when the person has no bucket in the strip.
 */
export function todayLoads(days: TeamKpiDay[]): Array<{ bucket: string; units: number; capacity: number }> {
  const today = days[0];
  if (!today || today.loads.length === 0) return [];
  const use = (l: { units: number; capacity: number }): number => (
    l.capacity > 0 ? l.units / l.capacity : (l.units > EPS ? Number.POSITIVE_INFINITY : 0)
  );
  const sorted = [...today.loads].sort((a, b) => use(b) - use(a) || b.units - a.units);
  const booked = sorted.filter((l) => l.units > EPS);
  return booked.length > 0 ? booked : sorted.slice(0, 1);
}

/** Days in the strip at the limit, and days past it. */
export function fullDays(days: TeamKpiDay[]): { full: number; over: number } {
  let full = 0;
  let over = 0;
  for (const d of days) {
    const lv = dayLevel(d);
    if (lv === 'full') full += 1;
    else if (lv === 'over') over += 1;
  }
  return { full, over };
}

/**
 * Problems first: late work now, then open work, then the most booked, then
 * who finished most. Ties fall back to the name so the order never jumps
 * between two loads of the same numbers.
 */
export function sortPeople(people: TeamKpiPerson[], isAr: boolean): TeamKpiPerson[] {
  return [...people].sort((a, b) => (
    b.late_now - a.late_now
    || b.open_now - a.open_now
    || b.booked_units - a.booked_units
    || b.done - a.done
    || personName(a, isAr).localeCompare(personName(b, isAr))
  ));
}

export function personName(p: Pick<TeamKpiPerson, 'name_ar' | 'name_en' | 'user_id'>, isAr: boolean): string {
  const name = isAr ? (p.name_ar ?? p.name_en) : (p.name_en ?? p.name_ar);
  return name ?? p.user_id.slice(0, 8);
}

const BUCKET_LABELS: Record<string, { ar: string; en: string }> = {
  post: { ar: 'إنتاج', en: 'Production' },
  approvals: { ar: 'مراجعة واعتماد', en: 'Reviews and approvals' },
  video: { ar: 'فيديو', en: 'Video' },
  publishing: { ar: 'نشر', en: 'Publishing' },
};

export function bucketLabel(bucket: string, isAr: boolean): string {
  const l = BUCKET_LABELS[bucket];
  return l ? (isAr ? l.ar : l.en) : bucket;
}

/** A date-only string read as LOCAL noon, so no timezone can shift its day. */
const localNoon = (day: string): string => `${day}T12:00:00`;

/** «الاثنين ٢٨ سبتمبر» / "Mon Sep 28". */
export function dayHeading(day: string, isAr: boolean): string {
  const iso = localNoon(day);
  return `${dayName(iso, isAr)} ${shortDate(iso, isAr)}`;
}

/**
 * The hover text for one square of the strip:
 * «الاثنين ٢٨ سبتمبر — إنتاج ٧ من ٧ · مراجعة واعتماد ١٨ من ٢٠».
 */
export function dayTitle(d: TeamKpiDay, isAr: boolean): string {
  const head = dayHeading(d.day, isAr);
  const parts: string[] = [];
  if (d.leave) parts.push(isAr ? 'إجازة' : 'On leave');
  else if (d.off) parts.push(isAr ? 'عطلة' : 'Day off');
  const booked = d.loads.filter((l) => l.units > EPS);
  for (const l of booked) {
    parts.push(isAr
      ? `${bucketLabel(l.bucket, true)} ${num(round1(l.units), true)} من ${num(l.capacity, true)}`
      : `${bucketLabel(l.bucket, false)} ${num(round1(l.units), false)} of ${num(l.capacity, false)}`);
  }
  if (booked.length === 0 && !d.leave && !d.off) parts.push(isAr ? 'لا شيء محجوز' : 'Nothing booked');
  return `${head} — ${parts.join(' · ')}`;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** «٨٫٤ س» / "8.4 h"; «—» when there is nothing to measure. */
export function hoursLabel(h: number | null, isAr: boolean): string {
  if (h === null || !Number.isFinite(h)) return '—';
  return isAr ? `${num(round1(h), true)} س` : `${num(round1(h), false)} h`;
}
