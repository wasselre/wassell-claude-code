/**
 * Pure date math for the campaign content builder's weekly-cadence generator.
 *
 * The operator says "add 8 posts, weekly, starting Sunday" and we hand back 8
 * evenly-spaced target dates. Kept side-effect-free and timezone-stable (all
 * math is on UTC midnights, formatted back as `YYYY-MM-DD` to match the
 * `<input type="date">` value the content form already uses) so it's trivially
 * testable and never drifts a day across the Riyadh boundary.
 *
 * No storage, no React — the builder component owns the UI; this owns the dates.
 */

const DAY_MS = 86_400_000;

export interface CadenceOptions {
  /** How many dates to generate (rows to add). Floored at 0; never silently capped. */
  count: number;
  /** The first target date, `YYYY-MM-DD`. Invalid/empty → no dates. */
  startDate: string;
  /** Days between consecutive dates: 7 = weekly, 14 = biweekly, 1 = daily. */
  intervalDays: number;
  /**
   * Optional weekday (0 = Sunday … 6 = Saturday) to anchor the FIRST date to:
   * the start date is advanced forward to the next matching weekday before the
   * spacing is applied. `null`/`undefined` keeps `startDate` exactly as given.
   */
  weekday?: number | null;
}

/** Parse `YYYY-MM-DD` → UTC-midnight epoch ms, or null when malformed/impossible. */
function parseYMD(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  // Reject rollovers (e.g. 2026-02-31) rather than accept a silently shifted date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return utc;
}

/** Format a UTC-midnight epoch ms back to `YYYY-MM-DD`. */
function toYMD(utc: number): string {
  const dt = new Date(utc);
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mo}-${d}`;
}

/**
 * The generator. Returns `count` `YYYY-MM-DD` strings spaced by `intervalDays`,
 * optionally snapped so the first lands on `weekday`. Empty array when the count
 * is 0 or the start date can't be parsed — the caller decides what "nothing to
 * add" means; we never fabricate a today.
 */
export function generateCadenceDates(opts: CadenceOptions): string[] {
  const count = Math.max(0, Math.floor(Number(opts.count) || 0));
  const interval = Math.max(1, Math.floor(Number(opts.intervalDays) || 1));
  let start = parseYMD(opts.startDate);
  if (start === null || count === 0) return [];

  if (opts.weekday != null && opts.weekday >= 0 && opts.weekday <= 6) {
    const delta = (opts.weekday - new Date(start).getUTCDay() + 7) % 7;
    start += delta * DAY_MS;
  }

  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(toYMD(start + i * interval * DAY_MS));
  return out;
}
