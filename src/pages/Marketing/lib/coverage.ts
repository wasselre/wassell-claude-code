/**
 * Coverage & demand math — shared by the calendar strip, the Organic coverage
 * panel, and the Performance desk so they can never disagree. Spec:
 * docs/marketing-task-load-plan.md §9.
 *
 * TWO distinct notions the reporting must never conflate:
 *
 *   • Distribution demand (احتياج النشر) — every required platform PLACEMENT.
 *     The same video posted to Instagram AND TikTok is TWO placements. Summed
 *     across platforms. This is what platform coverage counts.
 *
 *   • Production demand (احتياج الإنتاج الفعلي) — the UNIQUE creatives the team
 *     must actually produce. Because the same video is REUSED across platforms
 *     (the smaller platform's set is a subset of the larger's), the unique count
 *     per bucket is the MAX across platforms, not the sum. A creative reused on
 *     Instagram + TikTok + several paid ads counts ONCE in production but
 *     separately in every placement. Paid placements reuse existing content_ids,
 *     so they never raise production demand unless they reference a new content.
 *
 * Publishing runs 7 days/week; production runs across `productionDaysPerWeek`
 * working days (default 6). Production CAPACITY is the slowest producer stage
 * (a piece passes every stage; the bottleneck sets the rate) × working days, and
 * is compared against PRODUCTION demand — never against distribution.
 */
import type { PerfBucket, PerfCalendarData } from '@/lib/marketingOS/client';

export const BUCKETS: readonly PerfBucket[] = ['post', 'video'];

export const DEFAULT_PRODUCTION_DAYS = 6;

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

/* ── shared target/capacity shapes (the fields these functions actually use) ── */

export interface TargetLite {
  platform: string;
  bucket: PerfBucket;
  per_day: number;
  weekday: number | null;
  active?: boolean;
}
export interface CapacityRow {
  role_key: string;
  bucket: PerfBucket;
  per_day: number;
}

/** The target for (platform,bucket) on a given weekday — weekday row overrides
 *  the every-day (weekday=null) base. */
function targetRate(active: TargetLite[], platform: string, bucket: PerfBucket, weekday: number): number {
  const wd = active.find((t) => t.platform === platform && t.bucket === bucket && t.weekday === weekday);
  if (wd) return wd.per_day;
  const every = active.find((t) => t.platform === platform && t.bucket === bucket && t.weekday === null);
  return every ? every.per_day : 0;
}

/** The every-day (weekday=null) base target for (platform,bucket). */
function baseRate(active: TargetLite[], platform: string, bucket: PerfBucket): number {
  const every = active.find((t) => t.platform === platform && t.bucket === bucket && t.weekday === null);
  return every ? every.per_day : 0;
}

/* ── the demand-vs-capacity summary (distribution vs production) ────────────── */

export interface DemandLine {
  bucket: PerfBucket;
  /** Distribution = placements (Σ across platforms). */
  distributionPerDay: number;
  distributionPerWeek: number;
  /** Production = unique creatives (MAX across platforms — content is reused). */
  productionPerDay: number;
  productionPerWeek: number;
  /** Production spread over the working days it's actually made on. */
  productionWorkingDayAvg: number;
  /** Slowest producer stage (finished-piece throughput) × working days. */
  capacityPerWorkingDay: number;
  capacityPerWeek: number;
  bottleneckRole: string | null;
  /** Weekly shortfall of PRODUCTION vs CAPACITY (never distribution). */
  productionGapPerWeek: number;
  short: boolean;
}

/**
 * Distribution demand (placements) and production demand (unique creatives) per
 * bucket, plus the production capacity to compare production against.
 */
export function computeDemand(
  targets: TargetLite[],
  capacity: CapacityRow[],
  productionDaysPerWeek: number = DEFAULT_PRODUCTION_DAYS,
): DemandLine[] {
  const active = targets.filter((t) => t.active !== false);
  const platforms = Array.from(new Set(active.map((t) => t.platform)));
  const days = productionDaysPerWeek > 0 ? productionDaysPerWeek : DEFAULT_PRODUCTION_DAYS;

  return BUCKETS.map((bucket): DemandLine => {
    // Per-day figures from the every-day base rate.
    const perPlatform = platforms.map((p) => baseRate(active, p, bucket));
    const distributionPerDay = perPlatform.reduce((s, n) => s + n, 0);
    const productionPerDay = perPlatform.reduce((m, n) => Math.max(m, n), 0);

    // Weekly figures iterate the 7 publishing days (honouring weekday overrides):
    // distribution SUMS placements; production takes the MAX (reuse) each day.
    let distributionPerWeek = 0;
    let productionPerWeek = 0;
    for (let wd = 0; wd < 7; wd += 1) {
      const rates = platforms.map((p) => targetRate(active, p, bucket, wd));
      distributionPerWeek += rates.reduce((s, n) => s + n, 0);
      productionPerWeek += rates.reduce((m, n) => Math.max(m, n), 0);
    }

    // Capacity = the slowest producer stage for this bucket × working days.
    const producers = capacity.filter((c) => c.bucket === bucket && c.per_day > 0);
    let capacityPerWorkingDay = 0;
    let bottleneckRole: string | null = null;
    if (producers.length > 0) {
      const slowest = producers.reduce((a, b) => (b.per_day < a.per_day ? b : a));
      capacityPerWorkingDay = slowest.per_day;
      bottleneckRole = slowest.role_key;
    }
    const capacityPerWeek = capacityPerWorkingDay * days;
    const productionWorkingDayAvg = productionPerWeek / days;
    const productionGapPerWeek = Math.max(0, productionPerWeek - capacityPerWeek);

    return {
      bucket,
      distributionPerDay, distributionPerWeek,
      productionPerDay, productionPerWeek, productionWorkingDayAvg,
      capacityPerWorkingDay, capacityPerWeek, bottleneckRole,
      productionGapPerWeek,
      short: productionGapPerWeek > 0,
    };
  }).filter((d) => d.distributionPerWeek > 0 || d.capacityPerWeek > 0);
}

/* ── placement vs production counting (proves "once produced, many placed") ─── */

export interface PlacementCount {
  /** Placements = one per platform row (distribution). */
  placements: number;
  /** Unique = distinct content_ids among them (production). */
  unique: number;
}

/**
 * Count placements vs unique creatives in a bucket. One creative published to
 * Instagram AND TikTok is `{ placements: 2, unique: 1 }`. Optionally filter by
 * publication status.
 */
export function placementCounts(
  publications: Array<{ content_id: string | null; bucket: PerfBucket; status?: string }>,
  bucket: PerfBucket,
  statuses?: string[],
): PlacementCount {
  const rows = publications.filter((p) =>
    p.bucket === bucket && (!statuses || statuses.includes(p.status ?? '')));
  const uniq = new Set(rows.map((p) => p.content_id).filter((c): c is string => Boolean(c)));
  return { placements: rows.length, unique: uniq.size };
}

/* ── per-platform placement coverage (distribution) — window based ──────────── */

export interface CoverageCell {
  bucket: PerfBucket;
  fullTarget: number;    // placement target across the WHOLE window
  targetToDate: number;  // placement target up to min(today, window end)
  published: number;     // placements already published in-window
  planned: number;       // placements scheduled (future, in-window)
  short: number;         // projected placement shortfall to date, floored at 0
}

export interface CoveragePlatform {
  platform: string;
  cells: CoverageCell[];
}

/** Actual output in-window: placements published vs unique creatives produced. */
export interface ActualLine {
  bucket: PerfBucket;
  distributionPublished: number; // placements published
  productionPublished: number;   // distinct content_ids published
  distributionScheduled: number; // placements scheduled
}

export interface Coverage {
  platforms: CoveragePlatform[];
  overall: { fullTarget: number; targetToDate: number; published: number; planned: number; short: number };
  demand: DemandLine[];
  actual: ActualLine[];
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
  const active = (data.targets as TargetLite[]).filter((t) => t.active !== false);
  const platforms = Array.from(new Set(active.map((t) => t.platform)));

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
        const t = targetRate(active, platform, bucket, d.getDay());
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

  const demand = computeDemand(
    active, data.capacity as CapacityRow[], data.production_days_per_week ?? DEFAULT_PRODUCTION_DAYS,
  );

  const actual: ActualLine[] = BUCKETS.map((bucket) => {
    const pub = placementCounts(data.publications, bucket, ['published']);
    const sched = placementCounts(data.publications, bucket, ['scheduled']);
    return {
      bucket,
      distributionPublished: pub.placements,
      productionPublished: pub.unique,
      distributionScheduled: sched.placements,
    };
  });

  const daysTotal = dayCount(period.start, period.end);
  const daysElapsed = lastElapsed ? dayCount(period.start, lastElapsed < period.start ? period.start : lastElapsed) : 0;

  return { platforms: rows, overall, demand, actual, daysElapsed, daysTotal };
}
