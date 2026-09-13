/**
 * Organic publishing distribution — decide WHAT publishes WHEN, before any
 * production is scheduled. Production is then planned backward from this
 * (see `schedule.ts`), which is what makes the system produce in publishing
 * batches (A1,B1,C1 → D1,E1,A2 → …) instead of finishing one project at a time.
 *
 * The selection rule is "largest remaining project first, subject to the
 * platform's rules, with backtracking". On a balanced request (5 projects × 3
 * posts, 3/day) that reproduces the operator's own example exactly:
 *   day 1 → A1 B1 C1 · day 2 → D1 E1 A2 · day 3 → B2 C2 D2 · …
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import { calendarDaysIn, daysBetween, toInstant, weekdayOf } from './calendar';
import type { PlanConflict, PlatformFrequency, PlatformRules, PlannedPlacement } from './types';
import { slotTime } from './platforms';

export interface DistItem {
  key: string;
  projectId: string;
  bucket: 'post' | 'video';
}

export interface DistSlot {
  platform: string;
  executionKey: string;
  day: string;
  /** Index within the day, 0-based. */
  slotIndex: number;
  /** Global chronological index within the platform — drives grid position. */
  seq: number;
}

export interface DistributionResult {
  /** itemKey → its placements (one per platform when cross-posting). */
  placements: Map<string, PlannedPlacement[]>;
  conflicts: PlanConflict[];
  ok: boolean;
  /** How many items could be placed — used for the "same dates, fewer items" alternative. */
  placedCount: number;
}

export interface PlatformPlan {
  platform: string;
  executionKey: string;
  rules: PlatformRules;
  frequency: PlatformFrequency;
}

/** Every publishing day the platform offers inside the range, in order. */
export function publishingDays(plan: PlatformPlan, rangeStart: string, rangeEnd: string): string[] {
  if (daysBetween(rangeStart, rangeEnd) < 0) return [];
  return calendarDaysIn(rangeStart, rangeEnd).filter((day) =>
    !plan.frequency.weekdays || plan.frequency.weekdays.includes(weekdayOf(day)));
}

/** The ceiling on how many items this platform can take in the range. */
export function slotCapacity(plan: PlatformPlan, rangeStart: string, rangeEnd: string): number {
  const perDay = Math.max(0, Math.floor(plan.frequency.perDay));
  const cap = plan.rules.maxPerDay == null ? perDay : Math.min(perDay, plan.rules.maxPerDay);
  return publishingDays(plan, rangeStart, rangeEnd).length * cap;
}

/**
 * The slots this platform will ACTUALLY use for `count` items.
 *
 * The frequency is authoritative: `count` items at `perDay` need
 * `ceil(count / perDay)` publishing days. When the requested range is longer
 * than that, those days are spread EVENLY across the range rather than crammed
 * at the front — the operator asked for a date range, not a burst. Per-day
 * counts are balanced (10 items at 3/day over 4 days → 3, 3, 2, 2).
 *
 * Crucially there are no empty slots between used ones, so "the previous post"
 * and "this grid row" mean the same thing in the slot list as they do in the
 * published feed. (Allowing gaps was a bug: an empty slot made two same-project
 * posts look non-adjacent when the audience would see them back to back.)
 */
export function buildSlots(
  plan: PlatformPlan, rangeStart: string, rangeEnd: string, count: number,
): DistSlot[] {
  const out: DistSlot[] = [];
  const perDay = Math.max(0, Math.floor(plan.frequency.perDay));
  const cap = plan.rules.maxPerDay == null ? perDay : Math.min(perDay, plan.rules.maxPerDay);
  const days = publishingDays(plan, rangeStart, rangeEnd);
  if (cap === 0 || !days.length || count <= 0) return out;

  const need = Math.min(count, days.length * cap);
  const daysNeeded = Math.min(days.length, Math.ceil(need / cap));
  // Even stride across the available days.
  const chosen: string[] = [];
  if (daysNeeded === 1) {
    const first = days[0];
    if (first) chosen.push(first);
  } else {
    for (let k = 0; k < daysNeeded; k += 1) {
      const d = days[Math.round((k * (days.length - 1)) / (daysNeeded - 1))];
      if (d) chosen.push(d);
    }
  }
  // Balance the per-day counts so the last day is not the only short one.
  const base = Math.floor(need / daysNeeded);
  const extra = need % daysNeeded;
  let seq = 0;
  for (let d = 0; d < chosen.length; d += 1) {
    const day = chosen[d];
    if (!day) continue;
    const n = Math.min(cap, base + (d < extra ? 1 : 0));
    for (let i = 0; i < n; i += 1) {
      out.push({ platform: plan.platform, executionKey: plan.executionKey, day, slotIndex: i, seq });
      seq += 1;
    }
  }
  return out;
}

interface Assigned {
  itemKey: string;
  projectId: string;
}

/**
 * Fill one platform's slots from `items`, honouring the platform rules.
 * Returns the per-slot assignment, or null when no arrangement exists within
 * the search budget.
 */
function fillPlatform(
  items: DistItem[],
  slots: DistSlot[],
  rules: PlatformRules,
  budget: number,
): { assigned: Array<Assigned | null>; exhausted: boolean } {
  const n = Math.min(items.length, slots.length);
  const assigned: Array<Assigned | null> = new Array(slots.length).fill(null);

  // Remaining items grouped by project, each queue in stable order.
  const byProject = new Map<string, DistItem[]>();
  for (const it of items) {
    const q = byProject.get(it.projectId);
    if (q) q.push(it);
    else byProject.set(it.projectId, [it]);
  }
  const projectOrder = Array.from(byProject.keys());
  const remaining = new Map<string, number>();
  for (const [p, q] of byProject) remaining.set(p, q.length);

  let expansions = 0;
  let exhausted = false;

  const violates = (slotIdx: number, projectId: string): boolean => {
    const slot = slots[slotIdx];
    if (!slot) return true;
    if (!rules.allowSameProjectSameDay) {
      for (let i = 0; i < slotIdx; i += 1) {
        const a = assigned[i];
        if (a && slots[i]?.day === slot.day && a.projectId === projectId) return true;
      }
    }
    if (!rules.allowConsecutiveSameProject && slotIdx > 0) {
      const prev = assigned[slotIdx - 1];
      if (prev && prev.projectId === projectId) return true;
    }
    if (rules.distinctProjectsPerGridRow && rules.gridColumns && rules.gridColumns > 1) {
      const cols = rules.gridColumns;
      const rowStart = Math.floor(slotIdx / cols) * cols;
      for (let i = rowStart; i < slotIdx; i += 1) {
        const a = assigned[i];
        if (a && a.projectId === projectId) return true;
      }
    }
    return false;
  };

  const dfs = (slotIdx: number, placed: number): boolean => {
    if (placed >= n) return true;
    if (slotIdx >= slots.length) return false;
    expansions += 1;
    if (expansions > budget) {
      exhausted = true;
      return false;
    }
    void placed;
    // Candidate projects: most remaining first (the classic rearrangement
    // heuristic — it is what keeps "no two adjacent the same" satisfiable),
    // then the declared project order for determinism.
    const candidates = projectOrder
      .filter((p) => (remaining.get(p) ?? 0) > 0 && !violates(slotIdx, p))
      .sort((a, b) => {
        const d = (remaining.get(b) ?? 0) - (remaining.get(a) ?? 0);
        if (d !== 0) return d;
        return projectOrder.indexOf(a) - projectOrder.indexOf(b);
      });
    for (const p of candidates) {
      const queue = byProject.get(p) ?? [];
      const idx = queue.length - (remaining.get(p) ?? 0);
      const item = queue[idx];
      if (!item) continue;
      assigned[slotIdx] = { itemKey: item.key, projectId: p };
      remaining.set(p, (remaining.get(p) ?? 0) - 1);
      if (dfs(slotIdx + 1, placed + 1)) return true;
      remaining.set(p, (remaining.get(p) ?? 0) + 1);
      assigned[slotIdx] = null;
      if (exhausted) return false;
    }
    // No gap-skipping: `slots` holds exactly the slots we intend to publish in,
    // so an empty one would break "the previous post" and "this grid row".
    return false;
  };

  const ok = dfs(0, 0);
  if (!ok && !exhausted) {
    // No arrangement at all — return the best-effort greedy fill so the caller
    // can report how many DID fit.
    return { assigned: greedyFill(items, slots, rules), exhausted: false };
  }
  return { assigned, exhausted };
}

/** Constraint-respecting greedy fill, used only to report a partial count. */
function greedyFill(items: DistItem[], slots: DistSlot[], rules: PlatformRules): Array<Assigned | null> {
  const assigned: Array<Assigned | null> = new Array(slots.length).fill(null);
  const pool = items.slice();
  for (let s = 0; s < slots.length && pool.length; s += 1) {
    const idx = pool.findIndex((it) => {
      const slot = slots[s];
      if (!slot) return false;
      if (!rules.allowSameProjectSameDay) {
        for (let i = 0; i < s; i += 1) {
          const a = assigned[i];
          if (a && slots[i]?.day === slot.day && a.projectId === it.projectId) return false;
        }
      }
      if (!rules.allowConsecutiveSameProject && s > 0) {
        const prev = assigned[s - 1];
        if (prev && prev.projectId === it.projectId) return false;
      }
      if (rules.distinctProjectsPerGridRow && rules.gridColumns && rules.gridColumns > 1) {
        const cols = rules.gridColumns;
        const rowStart = Math.floor(s / cols) * cols;
        for (let i = rowStart; i < s; i += 1) {
          const a = assigned[i];
          if (a && a.projectId === it.projectId) return false;
        }
      }
      return true;
    });
    if (idx < 0) continue;
    const it = pool.splice(idx, 1)[0];
    if (!it) continue;
    assigned[s] = { itemKey: it.key, projectId: it.projectId };
  }
  return assigned;
}

/**
 * Distribute `items` across the campaign's platforms.
 *
 * `crossPost = false` — every item belongs to ONE platform; items are dealt
 * across platforms round-robin (so a mixed campaign covers each channel) and
 * then arranged within each platform's slots.
 *
 * `crossPost = true` — every item publishes on EVERY platform; each platform's
 * slot list is filled with the same item set, arranged independently.
 */
export function distribute(
  items: DistItem[],
  platforms: PlatformPlan[],
  rangeStart: string,
  rangeEnd: string,
  cal: WorkCalendar,
  crossPost: boolean,
  budget = 200_000,
): DistributionResult {
  const placements = new Map<string, PlannedPlacement[]>();
  const conflicts: PlanConflict[] = [];
  let ok = true;
  const placedItems = new Set<string>();

  if (!platforms.length) {
    conflicts.push({
      kind: 'not_enough_slots', itemKey: null, stepKey: null, day: null,
      messageAr: 'لم تُختر أي منصة نشر.',
      messageEn: 'No publishing platform was selected.',
    });
    return { placements, conflicts, ok: false, placedCount: 0 };
  }

  const perPlatformItems = new Map<string, DistItem[]>();
  if (crossPost) {
    for (const p of platforms) perPlatformItems.set(p.executionKey, items.slice());
  } else {
    // Deal round-robin so each platform gets a mix of projects, weighted by the
    // number of slots each platform actually offers.
    const capacities = platforms.map((p) => slotCapacity(p, rangeStart, rangeEnd));
    const totalCap = capacities.reduce((a, b) => a + b, 0);
    for (const p of platforms) perPlatformItems.set(p.executionKey, []);
    if (totalCap === 0) {
      conflicts.push({
        kind: 'not_enough_slots', itemKey: null, stepKey: null, day: null,
        messageAr: 'لا توجد فترات نشر في المدى المطلوب (تحقّق من التكرار وأيام الأسبوع).',
        messageEn: 'The requested range offers no publishing slots (check frequency and weekdays).',
      });
      return { placements, conflicts, ok: false, placedCount: 0 };
    }
    let cursor = 0;
    const used = platforms.map(() => 0);
    for (const it of items) {
      // Next platform with room, starting from the rotating cursor.
      let picked = -1;
      for (let i = 0; i < platforms.length; i += 1) {
        const idx = (cursor + i) % platforms.length;
        if ((used[idx] ?? 0) < (capacities[idx] ?? 0)) { picked = idx; break; }
      }
      const target = picked >= 0 ? platforms[picked] : undefined;
      if (!target) break; // no room anywhere; reported below
      used[picked] = (used[picked] ?? 0) + 1;
      cursor = (picked + 1) % platforms.length;
      perPlatformItems.get(target.executionKey)?.push(it);
    }
  }

  for (const p of platforms) {
    const mine = perPlatformItems.get(p.executionKey) ?? [];
    const slots = buildSlots(p, rangeStart, rangeEnd, mine.length);
    if (mine.length > slots.length) {
      ok = false;
      conflicts.push({
        kind: 'not_enough_slots', itemKey: null, stepKey: null, day: p.platform,
        messageAr: `فترات النشر في «${p.platform}» أقل من المطلوب: ${slots.length} مقابل ${mine.length}.`,
        messageEn: `${p.platform} offers ${slots.length} publishing slots but ${mine.length} are needed.`,
        detail: { platform: p.platform, slots: slots.length, needed: mine.length },
      });
    }
    const { assigned, exhausted } = fillPlatform(mine, slots, p.rules, budget);
    if (exhausted) {
      ok = false;
      conflicts.push({
        kind: 'search_incomplete', itemKey: null, stepKey: null, day: null,
        messageAr: `تعذّر ترتيب منشورات «${p.platform}» ضمن حدّ البحث. هذا ليس إثباتًا بأنّ الترتيب مستحيل.`,
        messageEn: `No arrangement for ${p.platform} was found within the search budget. This is NOT proof that none exists.`,
        detail: { platform: p.platform },
      });
    }
    const cols = p.rules.gridColumns;
    for (let i = 0; i < assigned.length; i += 1) {
      const a = assigned[i];
      const slot = slots[i];
      if (!a || !slot) continue;
      const placement: PlannedPlacement = {
        platform: p.platform,
        executionKey: p.executionKey,
        day: slot.day,
        plannedAt: toInstant(slot.day, slotTime(p.rules, slot.slotIndex, p.frequency.times), cal),
        batchKey: `${p.executionKey}|${slot.day}`,
        slotIndex: slot.slotIndex,
        gridRow: cols ? Math.floor(i / cols) : null,
        gridCol: cols ? i % cols : null,
      };
      const list = placements.get(a.itemKey);
      if (list) list.push(placement);
      else placements.set(a.itemKey, [placement]);
      placedItems.add(a.itemKey);
    }
    const unplaced = mine.filter((it) => !placedItems.has(it.key));
    if (unplaced.length && !exhausted) {
      ok = false;
      conflicts.push({
        kind: 'platform_rule', itemKey: unplaced[0]?.key ?? null, stepKey: null, day: null,
        messageAr: `قواعد «${p.platform}» تمنع جدولة ${unplaced.length} عنصرًا في هذا المدى (تكرار المشروع نفسه).`,
        messageEn: `${p.platform}'s rules leave ${unplaced.length} item(s) unschedulable in this range (same-project spacing).`,
        detail: { platform: p.platform, unplaced: unplaced.map((u) => u.key) },
      });
    }
  }

  return { placements, conflicts, ok, placedCount: placedItems.size };
}
