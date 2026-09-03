/**
 * Marketing dashboards — period selection math.
 *
 * One place that turns a {period, anchor} (or a custom from/to) into a
 * [from, to) window, a human label, and prev/next navigation. Shared by the
 * DateControl and the pages that read it, so the rail control, the header
 * label, and the API request can never disagree on what "this month" means.
 *
 * The API (periodBounds in api/marketing-os.ts) resolves the SAME window from
 * period + week_of; this is its client twin for display + navigation.
 */
import { monthName, num, shortDate } from './format';

const AR_MON = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface DailyRow { day: string; spend: number; leads: number; qualified: number }
export interface DayBucket { label: string; spend: number; leads: number; qualified: number }

/**
 * Fill a [fromIso, toIso) window day-by-day (so gaps read as zero), then bucket
 * by day / week / month depending on span. Shared by the Analytics page and the
 * Overview spend chart so both agree on granularity + labels.
 */
export function bucketDaily(
  daily: DailyRow[], fromIso: string, toIso: string, isAr: boolean,
): { mode: 'day' | 'week' | 'month'; items: DayBucket[] } {
  const from = new Date(`${fromIso}T00:00`);
  const to = new Date(`${toIso}T00:00`);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  const mode: 'day' | 'week' | 'month' = days <= 31 ? 'day' : days <= 126 ? 'week' : 'month';
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const mon = (i: number): string => (isAr ? AR_MON : EN_MON)[i] ?? '';
  const items: DayBucket[] = [];
  let curKey = '';
  for (let d = new Date(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const wkStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
    const key = mode === 'day' ? iso
      : mode === 'week' ? `w${wkStart.getFullYear()}-${wkStart.getMonth()}-${wkStart.getDate()}`
        : `m${d.getFullYear()}-${d.getMonth()}`;
    const label = mode === 'day' ? num(d.getDate(), isAr)
      : mode === 'week' ? `${num(wkStart.getDate(), isAr)} ${mon(wkStart.getMonth())}`
        : mon(d.getMonth());
    if (curKey !== key) {
      items.push({ label, spend: 0, leads: 0, qualified: 0 });
      curKey = key;
    }
    const b = items[items.length - 1];
    const row = byDay.get(iso);
    if (b && row) { b.spend += row.spend; b.leads += row.leads; b.qualified += row.qualified; }
  }
  return { mode, items };
}

export function granLabel(mode: 'day' | 'week' | 'month', isAr: boolean): string {
  if (mode === 'day') return isAr ? 'يومي' : 'daily';
  if (mode === 'week') return isAr ? 'أسبوعي' : 'weekly';
  return isAr ? 'شهري' : 'monthly';
}

export type SelPeriod = 'week' | 'month' | 'quarter' | 'year' | 'custom';

export interface DateSel {
  period: SelPeriod;
  /** Any ISO date inside the target window (ignored for custom). */
  anchorIso: string;
  /** Custom range only, inclusive yyyy-mm-dd. */
  from?: string;
  to?: string;
}

const QUARTER_AR = ['الأول', 'الثاني', 'الثالث', 'الرابع'];

function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

export function todayIso(): string { return new Date().toISOString(); }

/** yyyy-mm-dd for a Date, in local time (matches <input type="date">). */
export function ymd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The [from, to) window (to exclusive) for a selection. */
export function windowOf(sel: DateSel): { from: Date; to: Date } {
  if (sel.period === 'custom') {
    const f = sel.from ? new Date(`${sel.from}T00:00`) : new Date();
    const t = sel.to ? new Date(`${sel.to}T00:00`) : f;
    const from = startOfDay(f <= t ? f : t);
    const to = addDays(startOfDay(f <= t ? t : f), 1);
    return { from, to };
  }
  const a = new Date(sel.anchorIso);
  const y = a.getFullYear();
  const m = a.getMonth();
  if (sel.period === 'week') {
    const s = addDays(a, -a.getDay());
    return { from: startOfDay(s), to: addDays(startOfDay(s), 7) };
  }
  if (sel.period === 'month') return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1) };
  if (sel.period === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return { from: new Date(y, q, 1), to: new Date(y, q + 3, 1) };
  }
  return { from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) };
}

/** Header label — «سبتمبر ٢٠٢٦», «الربع الثالث ٢٠٢٦», «٢٠٢٦», a week/custom span. */
export function windowLabel(sel: DateSel, isAr: boolean): { main: string; sub: string } {
  const w = windowOf(sel);
  const lastDay = addDays(w.to, -1);
  if (sel.period === 'custom') {
    return {
      main: `${shortDate(w.from.toISOString(), isAr)} – ${shortDate(lastDay.toISOString(), isAr)}`,
      sub: isAr ? 'نطاق مخصّص' : 'custom range',
    };
  }
  const a = new Date(sel.anchorIso);
  const year = num(a.getFullYear(), isAr);
  if (sel.period === 'week') {
    return {
      main: `${shortDate(w.from.toISOString(), isAr)} – ${shortDate(lastDay.toISOString(), isAr)}`,
      sub: isAr ? `أسبوع · ${year}` : `week · ${year}`,
    };
  }
  if (sel.period === 'month') {
    return { main: `${monthName(a.getMonth(), isAr)} ${year}`, sub: isAr ? 'شهر' : 'month' };
  }
  if (sel.period === 'quarter') {
    const q = Math.floor(a.getMonth() / 3);
    return {
      main: isAr ? `الربع ${QUARTER_AR[q]} ${year}` : `Q${q + 1} ${year}`,
      sub: isAr ? 'ربع سنة' : 'quarter',
    };
  }
  return { main: year, sub: isAr ? 'سنة كاملة' : 'full year' };
}

/** true when the window includes today (i.e. it is the current period). */
export function windowContainsToday(sel: DateSel): boolean {
  const w = windowOf(sel);
  const now = startOfDay(new Date());
  return now >= w.from && now < w.to;
}

/** Shift the anchor one period older (dir -1) or newer (dir +1). */
export function shiftAnchor(sel: DateSel, dir: -1 | 1): DateSel {
  if (sel.period === 'custom') {
    const w = windowOf(sel);
    const len = Math.round((w.to.getTime() - w.from.getTime()) / 86_400_000);
    const from = addDays(w.from, dir * len);
    const to = addDays(addDays(w.to, -1), dir * len);
    return { ...sel, from: ymd(from), to: ymd(to) };
  }
  const a = new Date(sel.anchorIso);
  let next: Date;
  if (sel.period === 'week') next = addDays(a, dir * 7);
  else if (sel.period === 'month') next = new Date(a.getFullYear(), a.getMonth() + dir, 1);
  else if (sel.period === 'quarter') next = new Date(a.getFullYear(), a.getMonth() + dir * 3, 1);
  else next = new Date(a.getFullYear() + dir, 0, 1);
  return { ...sel, anchorIso: next.toISOString() };
}
