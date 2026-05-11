/**
 * Human-friendly Arabic date/time formatting for outbound message bodies
 * (WhatsApp templates, IVR TTS, notifications). Used by the workflow
 * engine's `{slug|human_ar}` token formatter — see
 * `substituteFieldTokens` in `workflowEngineCore.ts`.
 *
 * **Timezone semantics.** Saudi runs Asia/Riyadh year-round at UTC+3 with
 * no DST. The stored `datetime` field has no timezone suffix (it's the
 * wall-clock the user typed via `<input type="datetime-local">`). We
 * interpret it as Riyadh wall-clock regardless of where the code runs —
 * critical because the server engine fires from Vercel (UTC by default).
 *
 * **What it produces.** Examples (assuming "now" is Sun 2026-05-10 18:00 Riyadh):
 *   "2026-05-10T18:00" → "اليوم، الساعة 6:00 مساءً"
 *   "2026-05-11T17:40" → "غدًا، الساعة 5:40 عصرًا"
 *   "2026-05-12T10:00" → "يوم الثلاثاء الأسبوع هذا، الساعة 10:00 صباحًا"
 *   "2026-05-19T10:00" → "يوم الثلاثاء الأسبوع القادم، الساعة 10:00 صباحًا"
 *   "2026-06-15T10:00" → "يوم الإثنين 15 يونيو 2026، الساعة 10:00 صباحًا"
 *
 * **Time-of-day buckets** (Saudi cultural norms):
 *   05:00–11:59 → صباحًا (morning)
 *   12:00–13:59 → ظهرًا (noon)
 *   14:00–17:59 → عصرًا (afternoon)
 *   18:00–23:59 → مساءً (evening)
 *   00:00–04:59 → ليلًا (night / pre-dawn)
 *
 * Returns "" for empty / invalid input — callers should not show a stray
 * literal token to the customer.
 */

const RIYADH_TZ_OFFSET_HOURS = 3;
const MS_PER_HOUR = 3600 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DAY_NAMES_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// Saudi/Gregorian month names (شهور ميلادية) — what business users say in
// daily speech. Not Hijri.
const MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

interface RiyadhWallClock {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number; // 0-59
  weekday: number; // 0=Sun, 6=Sat
  /** Midnight-of-the-day as a UTC timestamp; lets us diff days cleanly. */
  dateOnlyMs: number;
}

/**
 * Parse a stored datetime string (`YYYY-MM-DDTHH:MM` or
 * `YYYY-MM-DDTHH:MM:SS`) as Riyadh wall-clock time. The input has no TZ
 * suffix; we treat it as Asia/Riyadh.
 */
function parseRiyadhWallClock(raw: string): RiyadhWallClock | null {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const day = parseInt(m[3]!, 10);
  const hour = parseInt(m[4]!, 10);
  const minute = parseInt(m[5]!, 10);
  // Use UTC math to avoid the runtime's local timezone leaking in.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(utcMs)) return null;
  const weekday = new Date(utcMs).getUTCDay();
  const dateOnlyMs = Date.UTC(year, month - 1, day);
  return { year, month, day, hour, minute, weekday, dateOnlyMs };
}

/** "Now" in Riyadh wall-clock. */
function getRiyadhNow(): RiyadhWallClock {
  // Shift UTC `now` by +3 hours so reading UTC components on the shifted
  // Date returns Riyadh wall-clock components. (Saudi has no DST, so the
  // offset is a true constant.)
  const shiftedMs = Date.now() + RIYADH_TZ_OFFSET_HOURS * MS_PER_HOUR;
  const d = new Date(shiftedMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const weekday = d.getUTCDay();
  const dateOnlyMs = Date.UTC(year, month - 1, day);
  return { year, month, day, hour, minute, weekday, dateOnlyMs };
}

/** Pick the Arabic time-of-day suffix from a 24h hour. */
function timeOfDayAr(hour24: number): string {
  if (hour24 >= 5 && hour24 <= 11) return 'صباحًا';
  if (hour24 >= 12 && hour24 <= 13) return 'ظهرًا';
  if (hour24 >= 14 && hour24 <= 17) return 'عصرًا';
  if (hour24 >= 18) return 'مساءً';
  return 'ليلًا';
}

/** "الساعة 6:00 مساءً" — pure time portion, 12-hour, Arabic period. */
function formatTimePartAr(hour24: number, minute: number): string {
  // 24h → 12h. 0 → 12, 13 → 1, etc. 12 stays 12.
  let h12 = hour24 % 12;
  if (h12 === 0) h12 = 12;
  const mm = String(minute).padStart(2, '0');
  return `الساعة ${h12}:${mm} ${timeOfDayAr(hour24)}`;
}

/**
 * Public: format a stored datetime value (or `Date`) as a friendly
 * Arabic phrase suitable for embedding in an outbound message body.
 * See module header for examples + edge cases.
 */
export function formatDateHumanAr(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';

  let parsed: RiyadhWallClock | null;
  if (value instanceof Date) {
    // A real Date is treated as a UTC instant; shift to Riyadh wall-clock.
    if (Number.isNaN(value.getTime())) return '';
    const shifted = new Date(value.getTime() + RIYADH_TZ_OFFSET_HOURS * MS_PER_HOUR);
    parsed = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      weekday: shifted.getUTCDay(),
      dateOnlyMs: Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
    };
  } else {
    parsed = parseRiyadhWallClock(String(value));
  }
  if (!parsed) return String(value); // Unparseable — fall back to raw rather than blank.

  const now = getRiyadhNow();

  // Day difference (calendar days, ignoring time within the day).
  const dayDiff = Math.round((parsed.dateOnlyMs - now.dateOnlyMs) / MS_PER_DAY);

  // Saudi week starts on Sunday (0). "This week" = current week's Sun..Sat.
  // dayOfWeekIndex says how many days into THIS week today is (0..6).
  const daysIntoThisWeek = now.weekday; // Sun=0 → 0 days in
  const startOfThisWeekDayDiff = -daysIntoThisWeek;          // negative or zero
  const endOfThisWeekDayDiff = 6 - daysIntoThisWeek;         // 0..6
  const startOfNextWeekDayDiff = endOfThisWeekDayDiff + 1;
  const endOfNextWeekDayDiff = endOfThisWeekDayDiff + 7;

  const time = formatTimePartAr(parsed.hour, parsed.minute);
  const dayName = DAY_NAMES_AR[parsed.weekday] ?? '';

  // Today / tomorrow / this week / next week / further.
  if (dayDiff === 0) return `اليوم، ${time}`;
  if (dayDiff === 1) return `غدًا، ${time}`;
  if (dayDiff === 2) return `بعد غدٍ، ${time}`;
  if (dayDiff >= startOfThisWeekDayDiff && dayDiff <= endOfThisWeekDayDiff) {
    return `يوم ${dayName} الأسبوع هذا، ${time}`;
  }
  if (dayDiff >= startOfNextWeekDayDiff && dayDiff <= endOfNextWeekDayDiff) {
    return `يوم ${dayName} الأسبوع القادم، ${time}`;
  }
  // Further away (or past) — fall back to "يوم {day} {DD MONTH YYYY}، الساعة …"
  const monthName = MONTH_NAMES_AR[parsed.month - 1] ?? String(parsed.month);
  return `يوم ${dayName} ${parsed.day} ${monthName} ${parsed.year}، ${time}`;
}
