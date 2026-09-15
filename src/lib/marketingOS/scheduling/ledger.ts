/**
 * The capacity ledger — ONE definition of "how much work does this person
 * already have on this day", used by the preview, by the commit, and by the
 * SQL validator (`mos_work_ledger_v` produces exactly these rows).
 *
 * Plan v2.1 §4.3 rules encoded here:
 *   • every unit of remaining work appears exactly once (the snapshot loader
 *     guarantees that; a consumed reservation leaves as its task enters);
 *   • elapsed time is NEVER progress — remaining effort shrinks only when the
 *     assignee records it (the loader applies `progress_days`);
 *   • `stale` reservations stay at full weight, projected from today;
 *   • leave and holidays are HARD constraints, not deadline extensions.
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import { isWorkingDay, daysBetween } from './calendar';
import type { LedgerRow, LoadBucket, PersonCapacity, WorkloadSnapshot } from './types';

const key = (userId: string, day: string, bucket: LoadBucket): string => `${userId}|${day}|${bucket}`;

/**
 * A mutable capacity book: how much of each (person, day, bucket) is used, and
 * what the ceiling is. Built once per plan run from the snapshot, then written
 * to as the placement search assigns and un-assigns stages.
 */
export class CapacityBook {
  private used = new Map<string, number>();

  private readonly people = new Map<string, PersonCapacity>();

  private readonly onLeave = new Set<string>();

  constructor(
    private readonly snapshot: WorkloadSnapshot,
    private readonly cal: WorkCalendar,
  ) {
    for (const p of snapshot.people) {
      this.people.set(p.userId, p);
      for (const l of p.leaves) {
        // Inclusive range; guarded so a bad row cannot spin.
        const span = daysBetween(l.from, l.to);
        if (span < 0 || span > 730) continue;
        let d = l.from;
        for (let i = 0; i <= span; i += 1) {
          this.onLeave.add(`${p.userId}|${d}`);
          d = shift(d, 1);
        }
      }
    }
    for (const row of snapshot.ledger) {
      this.add(row.userId, row.day, row.bucket, row.weight);
    }
  }

  /** The people who may perform work in `bucket` for `roleKey`. Stable order. */
  eligible(roleKey: string, bucket: LoadBucket): PersonCapacity[] {
    return this.snapshot.people
      .filter((p) => p.roles.includes(roleKey as PersonCapacity['roles'][number]))
      .filter((p) => (p.caps[bucket] ?? 0) > 0)
      .slice()
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  capacityOf(userId: string, bucket: LoadBucket): number {
    return this.people.get(userId)?.caps[bucket] ?? 0;
  }

  usedOn(userId: string, day: string, bucket: LoadBucket): number {
    return this.used.get(key(userId, day, bucket)) ?? 0;
  }

  freeOn(userId: string, day: string, bucket: LoadBucket): number {
    if (!isWorkingDay(day, this.cal)) return 0;
    if (this.onLeave.has(`${userId}|${day}`)) return 0;
    return Math.max(0, this.capacityOf(userId, bucket) - this.usedOn(userId, day, bucket));
  }

  /** Does `userId` have room for `weights[i]` on each of `days[i]`? */
  fits(userId: string, days: string[], bucket: LoadBucket, weights: number[]): boolean {
    for (let i = 0; i < days.length; i += 1) {
      const day = days[i];
      const w = weights[i] ?? 1;
      if (day === undefined) continue;
      if (this.freeOn(userId, day, bucket) + 1e-9 < w) return false;
    }
    return true;
  }

  add(userId: string, day: string, bucket: LoadBucket, weight: number): void {
    const k = key(userId, day, bucket);
    this.used.set(k, (this.used.get(k) ?? 0) + weight);
  }

  remove(userId: string, day: string, bucket: LoadBucket, weight: number): void {
    const k = key(userId, day, bucket);
    const next = (this.used.get(k) ?? 0) - weight;
    if (next <= 1e-9) this.used.delete(k);
    else this.used.set(k, next);
  }

  /** Total free slot-days for `bucket` across every eligible person in `[from, to]`. */
  freeCapacityInWindow(roleKey: string, bucket: LoadBucket, from: string, to: string): number {
    let total = 0;
    const span = daysBetween(from, to);
    if (span < 0) return 0;
    for (const p of this.eligible(roleKey, bucket)) {
      let d = from;
      for (let i = 0; i <= span; i += 1) {
        total += this.freeOn(p.userId, d, bucket);
        d = shift(d, 1);
      }
    }
    return total;
  }

  /** Snapshot of the pre-existing load for the preview's load table. */
  existingFor(userId: string, day: string, bucket: LoadBucket): number {
    return this.baseline.get(key(userId, day, bucket)) ?? 0;
  }

  private readonly baseline = new Map<string, number>();

  /** Freeze the current usage as "existing" — call once, after construction. */
  freezeBaseline(): void {
    this.baseline.clear();
    for (const [k, v] of this.used) this.baseline.set(k, v);
  }
}

/** Local day shift that avoids importing addDays into a hot loop signature. */
function shift(day: string, n: number): string {
  const parts = day.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Split an effort in working days into per-day weights.
 *
 *   1    → [1]
 *   2    → [1, 1]
 *   0.5  → [0.5]
 *   1.5  → [1, 0.5]
 *
 * The window is `weights.length` consecutive WORKING days.
 */
export function effortWeights(workingDays: number): number[] {
  const e = Math.max(0.25, Number(workingDays) || 0.25);
  const whole = Math.ceil(e - 1e-9);
  const out: number[] = [];
  let left = e;
  for (let i = 0; i < whole; i += 1) {
    const w = Math.min(1, left);
    out.push(Number(w.toFixed(4)));
    left -= w;
  }
  return out;
}

/**
 * The SAME-DAY spread: the whole weight lands on one day.
 *
 * `effortWeights` above answers "how long does this take", spreading N across N
 * consecutive working days. A ROW asks the opposite question. Three posts
 * written side by side in one sitting are ONE task, ONE submit and THREE slots
 * **on the same day** — running them through `effortWeights(3)` would reserve
 * one slot on each of three days, which is not a row at all.
 *
 * The SQL twin is `mos_spread_effort_same_day(start, effort)`
 * (2026-09-15). **Both must agree exactly**: the preview computes load in JS and
 * `mos_campaign_plan_commit`'s conflict test recomputes it in SQL, so any
 * divergence surfaces as a WS409 on a plan that actually fits — a bug the
 * commit's own comment records having happened once already.
 *
 *   3    → [3]
 *   0.25 → [0.25]
 */
export function effortWeightsSameDay(slots: number): number[] {
  return [Math.max(0, Number(slots) || 0)];
}

/** Rows for the preview's load table: existing vs proposed vs capacity. */
export function buildLoadCells(
  book: CapacityBook,
  snapshot: WorkloadSnapshot,
  touched: Array<{ userId: string; day: string; bucket: LoadBucket }>,
): Array<{ userId: string; day: string; bucket: LoadBucket; existing: number; proposed: number; capacity: number }> {
  const seen = new Set<string>();
  const out: Array<{ userId: string; day: string; bucket: LoadBucket; existing: number; proposed: number; capacity: number }> = [];
  const all = [
    ...snapshot.ledger.map((r) => ({ userId: r.userId, day: r.day, bucket: r.bucket })),
    ...touched,
  ];
  for (const t of all) {
    const k = key(t.userId, t.day, t.bucket);
    if (seen.has(k)) continue;
    seen.add(k);
    const existing = book.existingFor(t.userId, t.day, t.bucket);
    const total = book.usedOn(t.userId, t.day, t.bucket);
    out.push({
      userId: t.userId,
      day: t.day,
      bucket: t.bucket,
      existing: round2(existing),
      proposed: round2(Math.max(0, total - existing)),
      capacity: book.capacityOf(t.userId, t.bucket),
    });
  }
  out.sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1
      : a.userId < b.userId ? -1 : a.userId > b.userId ? 1
        : a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0);
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type { LedgerRow };
