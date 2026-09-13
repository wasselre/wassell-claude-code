/**
 * Working-day calendar math for the campaign scheduling engine.
 *
 * PURE. No imports, no I/O, no `import.meta.env` — this module is imported by
 * `api/**` and `worker/**` as well as the SPA (the same blessed src↔api
 * cross-import as `localizedName.ts` / `platformRules.ts`).
 *
 * Everything here works on **civil dates** as `YYYY-MM-DD` strings in one
 * timezone (Asia/Riyadh, which has no DST, so a civil date maps to exactly one
 * UTC instant at any given wall-clock time). We never do arithmetic on
 * `Date` objects across a timezone boundary — that is how the old code drifted
 * a day (`PerformanceDeskPage`'s hardcoded `+3h`).
 *
 * A "working day" is a day that is neither a configured weekend day nor a
 * configured holiday. The Saudi default is Friday off (`weekendDays: [5]`),
 * which reproduces `mos_perf_due_after`'s hardcoded `EXTRACT(DOW) = 5` — but
 * here it is DATA, so Saturday can be added or a holiday declared without a
 * migration.
 */

/** Day-of-week numbering matches both JS `getUTCDay()` and Postgres `DOW`: 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface WorkCalendar {
  /** Days that are never working days. Saudi default `[5]` (Friday). */
  weekendDays: Weekday[];
  /** Extra non-working dates, `YYYY-MM-DD`. Eid, national day, etc. */
  holidays: string[];
  /** IANA zone the civil dates are expressed in. Riyadh has no DST. */
  timezone: string;
  /** Fixed UTC offset in minutes for `timezone` (Riyadh = +180). */
  utcOffsetMinutes: number;
}

export const DEFAULT_CALENDAR: WorkCalendar = {
  weekendDays: [5],
  holidays: [],
  timezone: 'Asia/Riyadh',
  utcOffsetMinutes: 180,
};

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → UTC-midnight epoch ms. Throws on a malformed or impossible date. */
export function parseDay(day: string): number {
  const m = YMD_RE.exec(day.trim());
  if (!m) throw new Error(`scheduling/calendar: bad date "${day}" (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`scheduling/calendar: impossible date "${day}"`);
  }
  return utc;
}

/** UTC-midnight epoch ms → `YYYY-MM-DD`. */
export function formatDay(utc: number): string {
  const dt = new Date(utc);
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mo}-${d}`;
}

/** Calendar days added (may be negative). Weekends and holidays are NOT skipped. */
export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, for the civil date. */
export function weekdayOf(day: string): Weekday {
  return new Date(parseDay(day)).getUTCDay() as Weekday;
}

/** Whole calendar days from `a` to `b` (b − a). Negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

export function isWorkingDay(day: string, cal: WorkCalendar): boolean {
  if (cal.weekendDays.includes(weekdayOf(day))) return false;
  return !cal.holidays.includes(day);
}

/** The same day when it works, otherwise the next working day. */
export function nextWorkingDay(day: string, cal: WorkCalendar): string {
  let d = day;
  for (let guard = 0; guard < 400; guard += 1) {
    if (isWorkingDay(d, cal)) return d;
    d = addDays(d, 1);
  }
  throw new Error('scheduling/calendar: no working day within 400 days (calendar misconfigured?)');
}

/** The same day when it works, otherwise the previous working day. */
export function prevWorkingDay(day: string, cal: WorkCalendar): string {
  let d = day;
  for (let guard = 0; guard < 400; guard += 1) {
    if (isWorkingDay(d, cal)) return d;
    d = addDays(d, -1);
  }
  throw new Error('scheduling/calendar: no working day within 400 days (calendar misconfigured?)');
}

/**
 * Move `n` WORKING days from `day`.
 *
 * `n === 0` returns `day` snapped to a working day (forward for 0, since the
 * caller means "this day, or the first one that exists"). `n > 0` moves
 * forward, `n < 0` backward, counting only working days. `day` itself is not
 * counted, so `addWorkingDays('Thu', 1)` with Friday off is Saturday.
 */
export function addWorkingDays(day: string, n: number, cal: WorkCalendar): string {
  if (n === 0) return nextWorkingDay(day, cal);
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let d = day;
  for (let guard = 0; guard < 4000 && remaining > 0; guard += 1) {
    d = addDays(d, step);
    if (isWorkingDay(d, cal)) remaining -= 1;
  }
  if (remaining > 0) throw new Error('scheduling/calendar: addWorkingDays exceeded its guard');
  return d;
}

/** Inclusive count of working days in `[from, to]`. 0 when `to` precedes `from`. */
export function workingDaysBetween(from: string, to: string, cal: WorkCalendar): number {
  if (daysBetween(from, to) < 0) return 0;
  let count = 0;
  let d = from;
  for (let guard = 0; guard < 4000; guard += 1) {
    if (isWorkingDay(d, cal)) count += 1;
    if (d === to) return count;
    d = addDays(d, 1);
  }
  throw new Error('scheduling/calendar: workingDaysBetween exceeded its guard');
}

/** Every working day in `[from, to]`, ascending. */
export function workingDaysIn(from: string, to: string, cal: WorkCalendar): string[] {
  const out: string[] = [];
  if (daysBetween(from, to) < 0) return out;
  let d = from;
  for (let guard = 0; guard < 4000; guard += 1) {
    if (isWorkingDay(d, cal)) out.push(d);
    if (d === to) return out;
    d = addDays(d, 1);
  }
  throw new Error('scheduling/calendar: workingDaysIn exceeded its guard');
}

/** Every calendar day in `[from, to]`, ascending (weekends included). */
export function calendarDaysIn(from: string, to: string): string[] {
  const out: string[] = [];
  if (daysBetween(from, to) < 0) return out;
  let d = from;
  for (let guard = 0; guard < 4000; guard += 1) {
    out.push(d);
    if (d === to) return out;
    d = addDays(d, 1);
  }
  throw new Error('scheduling/calendar: calendarDaysIn exceeded its guard');
}

/**
 * The window of `spanDays` consecutive WORKING days that ENDS on `end`.
 * Returns them ascending, so `[0]` is the start. `spanDays` must be ≥ 1.
 */
export function workingWindowEndingAt(end: string, spanDays: number, cal: WorkCalendar): string[] {
  if (spanDays < 1) throw new Error('scheduling/calendar: spanDays must be >= 1');
  const out: string[] = [end];
  let d = end;
  for (let i = 1; i < spanDays; i += 1) {
    d = addWorkingDays(d, -1, cal);
    out.unshift(d);
  }
  return out;
}

/**
 * A civil date + `HH:MM` wall clock in the calendar's zone → an ISO instant.
 * Riyadh has a fixed +03:00 offset, so this is exact without a tz database.
 */
export function toInstant(day: string, time: string, cal: WorkCalendar): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`scheduling/calendar: bad time "${time}" (expected HH:MM)`);
  const utc = parseDay(day) + (Number(m[1]) * 60 + Number(m[2]) - cal.utcOffsetMinutes) * 60_000;
  return new Date(utc).toISOString();
}

/** The civil date, in the calendar's zone, of an ISO instant. */
export function dayOfInstant(iso: string, cal: WorkCalendar): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`scheduling/calendar: bad instant "${iso}"`);
  return formatDay(Math.floor((t + cal.utcOffsetMinutes * 60_000) / DAY_MS) * DAY_MS);
}

/** Working days per week implied by the calendar (holidays excluded — they vary). */
export function workingDaysPerWeek(cal: WorkCalendar): number {
  return 7 - new Set(cal.weekendDays).size;
}
