/**
 * Marketing Workspace — formatting.
 *
 * Decision 1 of the design review: «الأرقام عربي» — Arabic-Indic digits
 * everywhere in Arabic, including tables, counters and money. Every number the
 * workspace prints goes through `num()`, so there is exactly one place that
 * decides digit shape rather than a `toLocaleString` scattered per component.
 */

const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/** Latin digits → Arabic-Indic. Anything that isn't 0-9 passes through. */
export function toArabicDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)] ?? d);
}

/** A number for display. `null`/`undefined` becomes an em-dash, never "0". */
export function num(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = new Intl.NumberFormat('en-US').format(v);
  return isAr ? toArabicDigits(s) : s;
}

/**
 * Round a value to a whole number for display, preserving null/undefined.
 * Spend from Meta insights carries halalas (e.g. 782.38 SAR); rendered raw with
 * the Arabic decimal mark it misreads as "782,038". Money is shown in whole
 * riyals across the marketing surfaces, so round before `num()`.
 */
export function whole(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v);
}

/** Money. SAR is written ر.س in Arabic and SAR in English. */
export function money(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${num(Math.round(v), isAr)} ${isAr ? 'ر.س' : 'SAR'}`;
}

const AR_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const EN_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function shortDate(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = num(d.getDate(), isAr);
  const month = (isAr ? AR_MONTHS : EN_MONTHS)[d.getMonth()] ?? '';
  return isAr ? `${day} ${month}` : `${month} ${day}`;
}

/** «١ يوليو ٢٠٢٦» / "1 Jul 2026" — a full calendar date WITH the year. */
export function fullDate(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = num(d.getDate(), isAr);
  const month = (isAr ? AR_MONTHS : EN_MONTHS)[d.getMonth()] ?? '';
  const year = num(d.getFullYear(), isAr);
  return isAr ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`;
}

export function dayName(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (isAr ? AR_DAYS : EN_DAYS)[d.getDay()] ?? '';
}

/** Month name by 0-based index — «أغسطس» / "Aug". */
export function monthName(monthIndex: number, isAr: boolean): string {
  return (isAr ? AR_MONTHS : EN_MONTHS)[monthIndex] ?? '';
}

/** The month name of an ISO date — for «الإعلانات المدفوعة — أغسطس». */
export function monthOf(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return monthName(d.getMonth(), isAr);
}

/** «الاثنين ٢٨» / "Mon 28" — the week-card row's leading label. */
export function dayLabel(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const name = dayName(iso, isAr);
  return name ? `${name} ${num(d.getDate(), isAr)}` : num(d.getDate(), isAr);
}

export function dateTime(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = isAr ? (h < 12 ? 'صباحًا' : 'مساءً') : h < 12 ? 'AM' : 'PM';
  return `${shortDate(iso, isAr)} · ${num(h12, isAr)}:${isAr ? toArabicDigits(m) : m} ${suffix}`;
}

/**
 * Screen 08's approver stamp — «٢٧ يوليو، ٢:١٤م» / "Jul 27, 2:14pm". The short
 * ص/م suffix (not صباحًا/مساءً) is the mockup's own shape.
 */
export function dateStamp(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = isAr ? (h < 12 ? 'ص' : 'م') : h < 12 ? 'am' : 'pm';
  return `${shortDate(iso, isAr)}، ${num(h12, isAr)}:${isAr ? toArabicDigits(m) : m}${suffix}`;
}

/**
 * Screen 06's publishing-plan slot — «١٠ أغسطس · ٧:٠٠ م» / "Aug 10 · 7:00 pm".
 * Same short ص/م suffix as `dateStamp`, but a «·» separator and a space, which
 * is the mockup's own shape for scheduled slots.
 */
export function dateTimeShort(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = isAr ? (h < 12 ? 'ص' : 'م') : h < 12 ? 'am' : 'pm';
  return `${shortDate(iso, isAr)} · ${num(h12, isAr)}:${isAr ? toArabicDigits(m) : m} ${suffix}`;
}

/** Whole days between now and `iso`. Negative = in the past. */
export function daysFromNow(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

/** "٤ أيام" / "4 days" — the stalled column's unit. */
export function daysAgo(iso: string | null | undefined, isAr: boolean): string {
  const d = daysFromNow(iso);
  if (d === null) return '—';
  const n = Math.abs(d);
  if (n === 0) return isAr ? 'اليوم' : 'today';
  if (isAr) {
    if (n === 1) return 'يوم';
    if (n === 2) return 'يومان';
    if (n <= 10) return `${num(n, true)} أيام`;
    return `${num(n, true)} يومًا`;
  }
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/** The dot in the avatar circle. Falls back to the role's first letter. */
export function initial(name: string | null | undefined): string {
  const s = (name ?? '').trim();
  return s ? Array.from(s)[0] ?? '•' : '•';
}

/**
 * A stable colour class per role, so the same role is the same colour on every
 * screen. Deliberately keyed on ROLE, not on person — people change, the design
 * decision was «الدور لأن الأشخاص يتغيرون».
 */
export function roleAvatarClass(role: string | null | undefined): string {
  switch (role) {
    case 'writer': return 'a-m';
    case 'montage': return 'a-s';
    case 'ops_supervisor': return 'a-n';
    case 'marketing_manager': return 'a-r';
    case 'ceo': return 'a-c';
    default: return 'a-c';
  }
}

/** ISO date (no time) for `<input type="date">`. */
export function isoDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** ISO local value for `<input type="datetime-local">`. */
export function isoDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
