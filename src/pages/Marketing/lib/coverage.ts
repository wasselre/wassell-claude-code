/**
 * Coverage math — shared by the calendar strip and the Organic coverage panel
 * so they can never disagree. Turns raw perf_calendar data + a period window
 * into per-platform × bucket rows (target vs published vs planned) plus the
 * demand-vs-capacity structural summary.
 *
 * Spec: docs/marketing-task-load-plan.md §9. Weekday-specific targets override
 * the every-day target for that weekday; the daily target is summed across the
 * exact days in the window, so a week and a month are the same computation with
 * a different window.
 */
import type { PerfBucket, PerfCalendarData } from '@/lib/marketingOS/client';

export const BUCKETS: readonly PerfBucket[] = ['post', 'video'];

export type PeriodKind = 'week' | 'month';

export interface Period {
  kind: PeriodKind;
  start: Date; // local midnight, inclusive
  end: Date;   // local midnight, inclusive (the last day of the window)
}

/** YYYY-MM-DD in local time (Riyadh) — the strings perf_calendar filters on. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Sunday that begins the week containing `d` (Saudi week starts Sunday). */
function sundayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

/** The window for the calendar's current view + cursor. */
export function periodWindow(kind: PeriodKind, cursor: Date): Period {
  if (kind === 'week') {
    const start = sundayOf(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { kind, start, end };
  }
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0); // last day of month
  return { kind, start, end };
}

export interface CoverageCell {
  bucket: PerfBucket;
  fullTarget: number;    // target across the WHOLE window
  targetToDate: number;  // target up to min(today, window end)
  published: number;     // publications already published in-window
  planned: number;       // scheduled (future, in-window)
  /** Projected shortfall to date: how far behind the pace we are, floored at 0. */
  short: number;
}

export interface CoveragePlatform {
  platform: string;
  cells: CoverageCell[];
}

export interface CapacityLine {
  bucket: PerfBucket;
  demandPerDay: number;       // every-day target summed across platforms
  bottleneckPerDay: number;   // slowest producer stage (finished-piece throughput)
  bottleneckRole: string | null;
  short: boolean;             // demand exceeds what the team can produce
}

export interface Coverage {
  platforms: CoveragePlatform[];
  overall: { fullTarget: number; targetToDate: number; published: number; planned: number; short: number };
  capacity: CapacityLine[];
  /** days elapsed in-window (for a "day N of M" caption). */
  daysElapsed: number;
  daysTotal: number;
}

/** Inclusive day count between two local-midnight dates. */
function dayCount(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function computeCoverage(
  data: PerfCalendarData,
  period: Period,
  now: Date = new Date(),
): Coverage {
  const active = data.targets.filter((t) => t.active);
  const platforms = Array.from(new Set(active.map((t) => t.platform)));

  // Per (platform,bucket): every-day rate + weekday overrides.
  const rate = (platform: string, bucket: PerfBucket, weekday: number): number => {
    const wd = active.find((t) => t.platform === platform && t.bucket === bucket && t.weekday === weekday);
    if (wd) return wd.per_day;
    const every = active.find((t) => t.platform === platform && t.bucket === bucket && t.weekday === null);
    return every ? every.per_day : 0;
  };

  // Compare on WHOLE days (all windows are local-midnight). Today counts as
  // elapsed. Aligning to midnight avoids the 23:59 → dayCount off-by-one.
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const lastElapsed = today < period.start ? null : (today > period.end ? period.end : today);

  const rows: CoveragePlatform[] = platforms.map((platform) => {
    const cells = BUCKETS.map((bucket): CoverageCell => {
      let fullTarget = 0;
      let targetToDate = 0;
      for (const d = new Date(period.start); d <= period.end; d.setDate(d.getDate() + 1)) {
        const t = rate(platform, bucket, d.getDay());
        fullTarget += t;
        if (lastElapsed && d <= lastElapsed) targetToDate += t;
      }
      const inBucket = data.publications.filter((p) => p.platform === platform && p.bucket === bucket);
      const published = inBucket.filter((p) => p.status === 'published').length;
      const planned = inBucket.filter((p) => p.status === 'scheduled').length;
      return {
        bucket, fullTarget, targetToDate, published, planned,
        short: Math.max(0, targetToDate - published - planned),
      };
    }).filter((c) => c.fullTarget > 0);
    return { platform, cells };
  }).filter((r) => r.cells.length > 0);

  const overall = rows.flatMap((r) => r.cells).reduce(
    (acc, c) => ({
      fullTarget: acc.fullTarget + c.fullTarget,
      targetToDate: acc.targetToDate + c.targetToDate,
      published: acc.published + c.published,
      planned: acc.planned + c.planned,
      short: acc.short + c.short,
    }),
    { fullTarget: 0, targetToDate: 0, published: 0, planned: 0, short: 0 },
  );

  // Demand vs production capacity, per bucket.
  const capacity: CapacityLine[] = BUCKETS.map((bucket) => {
    const demandPerDay = active
      .filter((t) => t.bucket === bucket && t.weekday === null)
      .reduce((s, t) => s + t.per_day, 0);
    // Finished-piece throughput = the SLOWEST producer stage for this bucket
    // (a piece must pass every stage; the bottleneck sets the rate).
    const producers = data.capacity.filter((c) => c.bucket === bucket);
    let bottleneckPerDay = 0;
    let bottleneckRole: string | null = null;
    if (producers.length > 0) {
      const min = producers.reduce((m, c) => (c.per_day < m.per_day ? c : m));
      bottleneckPerDay = min.per_day;
      bottleneckRole = min.role_key;
    }
    return {
      bucket, demandPerDay, bottleneckPerDay, bottleneckRole,
      short: demandPerDay > 0 && bottleneckPerDay > 0 && demandPerDay > bottleneckPerDay,
    };
  }).filter((c) => c.demandPerDay > 0 || c.bottleneckPerDay > 0);

  const daysTotal = dayCount(period.start, period.end);
  const daysElapsed = lastElapsed ? dayCount(period.start, lastElapsed < period.start ? period.start : lastElapsed) : 0;

  return { platforms: rows, overall, capacity, daysElapsed, daysTotal };
}
