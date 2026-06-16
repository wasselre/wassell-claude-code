/**
 * The SINGLE home for all analytics date math. Everything here is Asia/Riyadh
 * (UTC+3, no DST) — never the browser timezone, never UTC. The offset constant
 * is imported from `dateFormat.ts` so there is exactly one definition of it.
 *
 * Two value shapes appear in records and BOTH resolve to Riyadh wall-clock here:
 *  - user `date` / `datetime` fields: bare strings (`YYYY-MM-DD[THH:MM[:SS]]`),
 *    no tz suffix — already Riyadh wall-clock (what the user typed).
 *  - `created_at` / `updated_at`: true UTC instants (`…Z` / `±offset`) from
 *    Postgres `now()` — shifted +3h into Riyadh wall-clock.
 *
 * `now` is injectable everywhere so the engine is deterministic and testable
 * (the server passes `new Date()`; tests pass a fixed instant). This module is
 * isomorphic — no browser- or Node-only APIs.
 */
import { RIYADH_TZ_OFFSET_HOURS, MONTH_NAMES_AR } from '../dateFormat.js';
import type { DateFilterMode, DateRange, TimeBucket } from './types';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const OFFSET_MS = RIYADH_TZ_OFFSET_HOURS * MS_PER_HOUR;

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface RiyadhParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  ms: number; // 0-999
  weekday: number; // 0=Sun … 6=Sat
}

interface Civil {
  y: number;
  m: number; // 1-12
  d: number;
}

const pad = (n: number, w = 2): string => String(Math.trunc(n)).padStart(w, '0');

// Matches a bare (tz-less) date/datetime. A trailing `Z` or `±offset` makes the
// match fail (there must be nothing after the optional seconds.ms), so those
// fall through to instant parsing.
const BARE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

function partsFromInstant(epochMs: number): RiyadhParts {
  const d = new Date(epochMs + OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
    weekday: d.getUTCDay(),
  };
}

/**
 * Parse any stored value into Riyadh wall-clock parts. Bare strings are taken
 * as Riyadh literally; tz-bearing strings and `Date`s are treated as instants
 * and shifted into Riyadh. Returns null for empty / unparseable input.
 */
export function toRiyadhParts(value: unknown): RiyadhParts | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : partsFromInstant(value.getTime());
  }
  const s = String(value).trim();
  if (s === '') return null;
  const m = BARE_DATETIME.exec(s);
  if (m) {
    const year = +m[1]!;
    const month = +m[2]!;
    const day = +m[3]!;
    const hour = m[4] ? +m[4] : 0;
    const minute = m[5] ? +m[5] : 0;
    const second = m[6] ? +m[6] : 0;
    const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    if (Number.isNaN(utcMs)) return null;
    return { year, month, day, hour, minute, second, ms, weekday: new Date(utcMs).getUTCDay() };
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : partsFromInstant(t);
}

/**
 * A monotonic, comparable number for Riyadh wall-clock parts: we treat the
 * Riyadh components AS IF they were UTC. Both record values and window bounds go
 * through this, so comparisons are apples-to-apples regardless of source shape.
 */
function msFromParts(p: RiyadhParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
}

/** Comparable Riyadh ms for any stored value, or null if unparseable. */
export function valueRiyadhMs(value: unknown): number | null {
  const p = toRiyadhParts(value);
  return p ? msFromParts(p) : null;
}

// ── Civil-date arithmetic (Riyadh, time-stripped) ───────────────────────────

function civilMs(c: Civil): number {
  return Date.UTC(c.y, c.m - 1, c.d);
}
function civilFromMs(ms: number): Civil {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function addDays(c: Civil, n: number): Civil {
  return civilFromMs(civilMs(c) + n * MS_PER_DAY);
}
function firstOfMonth(y: number, m1: number): Civil {
  return civilFromMs(Date.UTC(y, m1 - 1, 1)); // normalizes m1 out of [1,12]
}
function lastOfMonth(y: number, m1: number): Civil {
  return civilFromMs(Date.UTC(y, m1, 1) - MS_PER_DAY); // first of next month, minus a day
}
function startOfDayStr(c: Civil): string {
  return `${c.y}-${pad(c.m)}-${pad(c.d)}T00:00:00.000`;
}
function endOfDayStr(c: Civil): string {
  return `${c.y}-${pad(c.m)}-${pad(c.d)}T23:59:59.999`;
}
function dayRange(c: Civil): DateRange {
  return { from: startOfDayStr(c), to: endOfDayStr(c) };
}
function weekRange(sunday: Civil): DateRange {
  return { from: startOfDayStr(sunday), to: endOfDayStr(addDays(sunday, 6)) };
}
function monthRange(y: number, m1: number): DateRange {
  return { from: startOfDayStr(firstOfMonth(y, m1)), to: endOfDayStr(lastOfMonth(y, m1)) };
}
function quarterRangeByStartMonth(y: number, startMonth: number): DateRange {
  return { from: startOfDayStr(firstOfMonth(y, startMonth)), to: endOfDayStr(lastOfMonth(y, startMonth + 2)) };
}
function yearRange(y: number): DateRange {
  return { from: startOfDayStr({ y, m: 1, d: 1 }), to: endOfDayStr({ y, m: 12, d: 31 }) };
}

function normalizeCustom(from: string | undefined, to: string | undefined, today: Civil): DateRange {
  const f = from && from.trim() ? from.trim() : '1970-01-01T00:00:00.000';
  let t = to && to.trim() ? to.trim() : endOfDayStr(today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T23:59:59.999`; // date-only `to` → inclusive end-of-day
  return { from: f, to: t };
}

/**
 * Resolve a relative/custom date mode to a concrete inclusive Riyadh
 * wall-clock window. The returned bounds are bare wall-clock strings; compare
 * against record values via {@link valueRiyadhMs} (or {@link inDateRange}).
 */
export function resolveDateRange(
  mode: DateFilterMode,
  now: Date,
  from?: string,
  to?: string,
): DateRange {
  const n = partsFromInstant(now.getTime());
  const today: Civil = { y: n.year, m: n.month, d: n.day };
  const qStartMonth = Math.floor((n.month - 1) / 3) * 3 + 1;
  switch (mode) {
    case 'today':
      return dayRange(today);
    case 'yesterday':
      return dayRange(addDays(today, -1));
    case 'this_week':
      return weekRange(addDays(today, -n.weekday));
    case 'last_week':
      return weekRange(addDays(today, -n.weekday - 7));
    case 'this_month':
      return monthRange(today.y, today.m);
    case 'last_month':
      return monthRange(today.y, today.m - 1);
    case 'this_quarter':
      return quarterRangeByStartMonth(today.y, qStartMonth);
    case 'this_year':
      return yearRange(today.y);
    case 'last_7_days':
      return { from: startOfDayStr(addDays(today, -6)), to: endOfDayStr(today) };
    case 'last_30_days':
      return { from: startOfDayStr(addDays(today, -29)), to: endOfDayStr(today) };
    case 'custom':
      return normalizeCustom(from, to, today);
    default:
      return normalizeCustom(from, to, today);
  }
}

/**
 * The immediately-preceding equal window, used for comparison metrics
 * ("vs last month", "vs yesterday"). Calendar modes step to the natural prior
 * calendar period; rolling/custom modes shift back by the window's length.
 */
export function previousWindow(
  mode: DateFilterMode,
  now: Date,
  from?: string,
  to?: string,
): DateRange {
  const n = partsFromInstant(now.getTime());
  const today: Civil = { y: n.year, m: n.month, d: n.day };
  const qStartMonth = Math.floor((n.month - 1) / 3) * 3 + 1;
  switch (mode) {
    case 'today':
      return dayRange(addDays(today, -1));
    case 'yesterday':
      return dayRange(addDays(today, -2));
    case 'this_week':
      return weekRange(addDays(today, -n.weekday - 7));
    case 'last_week':
      return weekRange(addDays(today, -n.weekday - 14));
    case 'this_month':
      return monthRange(today.y, today.m - 1);
    case 'last_month':
      return monthRange(today.y, today.m - 2);
    case 'this_quarter':
      return quarterRangeByStartMonth(today.y, qStartMonth - 3);
    case 'this_year':
      return yearRange(today.y - 1);
    case 'last_7_days':
      return { from: startOfDayStr(addDays(today, -13)), to: endOfDayStr(addDays(today, -7)) };
    case 'last_30_days':
      return { from: startOfDayStr(addDays(today, -59)), to: endOfDayStr(addDays(today, -30)) };
    case 'custom':
    default: {
      const cur = normalizeCustom(from, to, today);
      const fromMs = valueRiyadhMs(cur.from);
      const toMs = valueRiyadhMs(cur.to);
      if (fromMs === null || toMs === null) return cur;
      const span = toMs - fromMs;
      const prevToMs = fromMs - 1;
      const prevFromMs = prevToMs - span;
      return { from: wallClockFromMs(prevFromMs), to: wallClockFromMs(prevToMs) };
    }
  }
}

/** Format a Riyadh-as-if-UTC ms back into a bare wall-clock string. */
function wallClockFromMs(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/** Inclusive membership test of a stored value in a resolved window. */
export function inDateRange(value: unknown, range: DateRange): boolean {
  const v = valueRiyadhMs(value);
  if (v === null) return false;
  const fromMs = valueRiyadhMs(range.from);
  const toMs = valueRiyadhMs(range.to);
  if (fromMs === null || toMs === null) return false;
  return v >= fromMs && v <= toMs;
}

// ── Time bucketing ──────────────────────────────────────────────────────────

export interface DateBucket {
  raw: string;
  label_ar: string;
  label_en: string;
  start: string; // inclusive lower edge (Riyadh wall-clock)
  end: string; // inclusive upper edge
}

/** Bucket a stored date/datetime value by the given grain (Riyadh). */
export function bucketDate(value: unknown, bucket: TimeBucket): DateBucket | null {
  const p = toRiyadhParts(value);
  if (!p) return null;
  const c: Civil = { y: p.year, m: p.month, d: p.day };
  switch (bucket) {
    case 'hour': {
      const stem = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}`;
      const label = `${stem}:00`;
      return { raw: stem, label_ar: label, label_en: label, start: `${stem}:00:00.000`, end: `${stem}:59:59.999` };
    }
    case 'day': {
      const raw = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
      return { raw, label_ar: raw, label_en: raw, start: startOfDayStr(c), end: endOfDayStr(c) };
    }
    case 'week': {
      const sunday = addDays(c, -p.weekday);
      const raw = `${sunday.y}-${pad(sunday.m)}-${pad(sunday.d)}`;
      return { raw, label_ar: `أسبوع ${raw}`, label_en: `Week of ${raw}`, start: startOfDayStr(sunday), end: endOfDayStr(addDays(sunday, 6)) };
    }
    case 'month': {
      const raw = `${p.year}-${pad(p.month)}`;
      const r = monthRange(p.year, p.month);
      return { raw, label_ar: `${MONTH_NAMES_AR[p.month - 1]} ${p.year}`, label_en: `${MONTH_NAMES_EN[p.month - 1]} ${p.year}`, start: r.from, end: r.to };
    }
    case 'quarter': {
      const q = Math.floor((p.month - 1) / 3) + 1;
      const raw = `${p.year}-Q${q}`;
      const r = quarterRangeByStartMonth(p.year, (q - 1) * 3 + 1);
      return { raw, label_ar: `الربع ${q} ${p.year}`, label_en: `Q${q} ${p.year}`, start: r.from, end: r.to };
    }
    case 'year': {
      const raw = `${p.year}`;
      const r = yearRange(p.year);
      return { raw, label_ar: raw, label_en: raw, start: r.from, end: r.to };
    }
    default:
      return null;
  }
}
