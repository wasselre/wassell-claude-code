/**
 * Backward production scheduling against the live work ledger.
 *
 * Given each item's publishing date(s), this computes the stage deadlines
 * (backward from the required-ready date) and then PLACES every stage on a real
 * person and real working days, respecting the capacity already committed to
 * other work.
 *
 * Two properties the reviews demanded:
 *
 *  1. **Publishing batches drive production.** Items are placed in publishing
 *     order, and within an item stages are placed LAST first, each as late as
 *     its deadline allows. Batch 1 therefore takes the slots nearest its own
 *     deadlines and later batches are pushed EARLIER into their slack — never
 *     the other way round. A later batch's capacity problem can never displace
 *     an earlier batch.
 *
 *  2. **A search limit is never presented as proof of infeasibility.**
 *     Placement is a depth-first search WITH BACKTRACKING over (person, window)
 *     choices, so a first-fit mistake is reconsidered. Separately, two SOUND
 *     bounds can *prove* impossibility — a time bound (the chain cannot finish
 *     by the deadline even with infinite people) and a capacity bound (required
 *     slot-days exceed every free slot-day before the deadline). When neither
 *     bound fires and the search still fails, the result says
 *     `searchIncomplete: true` with `infeasibleProof: null`, and the UI must
 *     word it as "no schedule found", never "impossible".
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import { addWorkingDays, daysBetween, isWorkingDay, nextWorkingDay, prevWorkingDay, workingWindowEndingAt } from './calendar';
import { CapacityBook, effortWeights } from './ledger';
import type {
  LoadBucket, PathRole, PlanConflict, PlannedStage, StepSpec, WorkflowSpec,
} from './types';
import { bucketOfStep } from './types';

export interface ScheduleItem {
  key: string;
  priority: number;
  workflow: WorkflowSpec;
  /** Civil day the creative is first needed. */
  needDay: string;
  /** Working days between the final approval and the need day. */
  publishBufferDays: number;
  lockedAssignees?: Record<string, string>;
}

export interface ScheduledItem {
  key: string;
  requiredReadyAt: string;
  productionStart: string;
  stages: PlannedStage[];
}

export interface ScheduleResult {
  ok: boolean;
  items: Map<string, ScheduledItem>;
  conflicts: PlanConflict[];
  infeasibleProof: 'time_bound' | 'capacity_bound' | null;
  searchIncomplete: boolean;
  stats: { expansions: number; backtracks: number; budget: number };
  touched: Array<{ userId: string; day: string; bucket: LoadBucket }>;
}

interface StageReq {
  itemKey: string;
  priority: number;
  order: number;
  step: StepSpec;
  bucket: LoadBucket;
  weights: number[];
  span: number;
  /** Latest END day allowed by the chain. */
  deadline: string;
  afterReady: boolean;
}

/** The chain of production steps (everything up to and including the final approval). */
function productionSteps(wf: WorkflowSpec): StepSpec[] {
  return wf.steps.filter((s) => !s.afterReady);
}

/** Bilingual label with a safe fall-back to the step key. */
const labelAr = (s: StepSpec): string => s.labelAr || s.key;

/**
 * Backward deadlines: the last production step ends on the required-ready day,
 * and every earlier step must END `effort(next)` working days before that.
 */
export function computeDeadlines(
  steps: StepSpec[],
  requiredReadyAt: string,
  cal: WorkCalendar,
): string[] {
  const out: string[] = new Array<string>(steps.length).fill(requiredReadyAt);
  if (!steps.length) return out;
  out[steps.length - 1] = requiredReadyAt;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    const next = steps[i + 1];
    const later = out[i + 1] ?? requiredReadyAt;
    const nextSpan = effortWeights(next ? next.workingDays : 1).length;
    out[i] = addWorkingDays(later, -nextSpan, cal);
  }
  return out;
}

/** Earliest possible end for each step given `today` and infinite people. */
function earliestEnds(steps: StepSpec[], today: string, cal: WorkCalendar): string[] {
  const out: string[] = new Array<string>(steps.length).fill(today);
  let cursor = nextWorkingDay(today, cal);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const span = effortWeights(step ? step.workingDays : 1).length;
    const end = addWorkingDays(cursor, span - 1, cal);
    out[i] = end;
    cursor = addWorkingDays(end, 1, cal);
  }
  return out;
}

export function scheduleProduction(
  items: ScheduleItem[],
  book: CapacityBook,
  cal: WorkCalendar,
  today: string,
  budget: number,
): ScheduleResult {
  const conflicts: PlanConflict[] = [];
  const touched: Array<{ userId: string; day: string; bucket: LoadBucket }> = [];
  const result = new Map<string, ScheduledItem>();

  // ---------------------------------------------------------------- setup
  const ordered = items.slice().sort((a, b) => {
    if (a.needDay !== b.needDay) return a.needDay < b.needDay ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.key < b.key ? -1 : 1;
  });

  const itemByKey = new Map(ordered.map((o) => [o.key, o] as const));
  const reqs: StageReq[] = [];
  const perItem = new Map<string, { requiredReadyAt: string; prod: StepSpec[]; deadlines: string[] }>();

  for (const it of ordered) {
    const prod = productionSteps(it.workflow);
    let ready = it.needDay;
    for (let i = 0; i < Math.max(0, it.publishBufferDays); i += 1) ready = addWorkingDays(ready, -1, cal);
    if (it.publishBufferDays <= 0) ready = prevWorkingDay(it.needDay, cal);
    const deadlines = computeDeadlines(prod, ready, cal);
    perItem.set(it.key, { requiredReadyAt: ready, prod, deadlines });

    // ---- sound bound #1: time. Even with infinite people, does the chain fit?
    const est = earliestEnds(prod, today, cal);
    for (let i = 0; i < prod.length; i += 1) {
      const step = prod[i];
      const earliest = est[i];
      const due = deadlines[i];
      if (!step || !earliest || !due) continue;
      if (daysBetween(earliest, due) < 0) {
        conflicts.push({
          kind: 'time_bound',
          itemKey: it.key,
          stepKey: step.key,
          day: due,
          messageAr: `«${labelAr(step)}» لا يمكن أن ينتهي قبل ${earliest} بينما الموعد النهائي ${due} — المدى المطلوب أقصر من زمن الإنتاج نفسه.`,
          messageEn: `"${step.labelEn}" cannot finish before ${earliest} but is due ${due} — the requested range is shorter than production itself.`,
          detail: { earliest, deadline: due },
        });
        return {
          ok: false, items: result, conflicts, infeasibleProof: 'time_bound',
          searchIncomplete: false, stats: { expansions: 0, backtracks: 0, budget }, touched,
        };
      }
    }

    for (let i = 0; i < prod.length; i += 1) {
      const step = prod[i];
      const due = deadlines[i];
      if (!step || !due) continue;
      const w = effortWeights(step.workingDays);
      reqs.push({
        itemKey: it.key,
        priority: it.priority,
        order: i,
        step,
        bucket: bucketOfStep(step, it.workflow.bucket),
        weights: w,
        span: w.length,
        deadline: due,
        afterReady: false,
      });
    }
  }

  // ---- sound bound #2: capacity. Per (role, bucket) and per deadline horizon.
  const proof = capacityBound(reqs, book, cal, today, conflicts);
  if (proof) {
    return {
      ok: false, items: result, conflicts, infeasibleProof: 'capacity_bound',
      searchIncomplete: false, stats: { expansions: 0, backtracks: 0, budget }, touched,
    };
  }

  // ------------------------------------------------------------- placement
  // Order: items in publishing order; stages LAST → FIRST inside each item.
  const plan: StageReq[][] = ordered.map((it) =>
    reqs.filter((r) => r.itemKey === it.key).sort((a, b) => b.order - a.order));
  const flat: StageReq[] = plan.flat();

  const chosen = new Map<string, PlannedStage>();
  let expansions = 0;
  let backtracks = 0;
  let exhausted = false;

  const stageKey = (r: StageReq): string => `${r.itemKey}|${r.step.key}`;

  /** Latest END this stage may take: its own deadline, capped by the successor's start. */
  const effectiveDeadline = (r: StageReq): string => {
    const succ = chosen.get(`${r.itemKey}|${succKeyOf(r)}`);
    if (!succ) return r.deadline;
    const cap = addWorkingDays(succ.start, -1, cal);
    return daysBetween(cap, r.deadline) < 0 ? cap : r.deadline;
  };

  function succKeyOf(r: StageReq): string {
    const info = perItem.get(r.itemKey)!;
    const next = info.prod[r.order + 1];
    return next ? next.key : ' none';
  };

  const dfs = (idx: number): boolean => {
    if (idx >= flat.length) return true;
    expansions += 1;
    if (expansions > budget) { exhausted = true; return false; }

    const r = flat[idx];
    if (!r) return dfs(idx + 1);
    const dl = effectiveDeadline(r);
    if (daysBetween(today, dl) < 0) return false;

    const itemSpec = itemByKey.get(r.itemKey);
    const lockedUser = itemSpec?.lockedAssignees?.[r.step.key] ?? null;

    let people = book.eligible(r.step.roleKey, r.bucket);
    if (lockedUser) people = people.filter((p) => p.userId === lockedUser);
    if (!people.length) {
      conflicts.push({
        kind: 'no_eligible_person', itemKey: r.itemKey, stepKey: r.step.key, day: null,
        messageAr: `لا يوجد من يشغل دور «${r.step.roleKey}» بسعة في «${r.bucket}».`,
        messageEn: `Nobody holds the "${r.step.roleKey}" role with capacity in "${r.bucket}".`,
        detail: { role: r.step.roleKey, bucket: r.bucket },
      });
      return false;
    }

    // Candidate windows, LATEST first (leaves the most room for predecessors).
    let end = dl;
    for (let guard = 0; guard < 400; guard += 1) {
      if (daysBetween(today, end) < 0) break;
      if (!isWorkingDay(end, cal)) { end = addWorkingDays(end, -1, cal); continue; }
      const win = workingWindowEndingAt(end, r.span, cal);
      const winStart = win[0];
      const winEnd = win[win.length - 1];
      if (!winStart || !winEnd) break;
      if (daysBetween(today, winStart) < 0) break;

      // Person order: most free capacity across the window (balance), then
      // fewest total open slots, then id — deterministic.
      const ranked = people
        .map((p) => ({
          p,
          free: Math.min(...win.map((d, i) => book.freeOn(p.userId, d, r.bucket) - (r.weights[i] ?? 1))),
          load: win.reduce((acc, d) => acc + book.usedOn(p.userId, d, r.bucket), 0),
        }))
        .filter((x) => x.free >= -1e-9)
        .sort((a, b) => (b.free - a.free) || (a.load - b.load) || (a.p.userId < b.p.userId ? -1 : 1));

      for (const cand of ranked) {
        win.forEach((d, i) => book.add(cand.p.userId, d, r.bucket, r.weights[i] ?? 1));
        chosen.set(stageKey(r), {
          stepKey: r.step.key,
          roleKey: r.step.roleKey,
          bucket: r.bucket,
          assigneeUserId: cand.p.userId,
          start: winStart,
          end: winEnd,
          deadline: r.deadline,
          workingDays: r.step.workingDays,
        });
        if (dfs(idx + 1)) return true;
        backtracks += 1;
        chosen.delete(stageKey(r));
        win.forEach((d, i) => book.remove(cand.p.userId, d, r.bucket, r.weights[i] ?? 1));
        if (exhausted) return false;
      }
      end = addWorkingDays(end, -1, cal);
    }
    return false;
  };

  const ok = dfs(0);

  if (!ok) {
    if (exhausted) {
      conflicts.push({
        kind: 'search_incomplete', itemKey: null, stepKey: null, day: null,
        messageAr: 'لم يُعثر على جدول ضمن حدّ البحث. هذا ليس إثباتًا بأنّ الجدولة مستحيلة — جرّب تعديل المدى أو السعة.',
        messageEn: 'No schedule was found within the search budget. This is NOT proof that scheduling is impossible — adjust the range or capacity and retry.',
        detail: { budget, expansions },
      });
    } else {
      const worst = flat.find((r) => !chosen.has(stageKey(r)));
      conflicts.push({
        kind: 'no_capacity',
        itemKey: worst?.itemKey ?? null,
        stepKey: worst?.step.key ?? null,
        day: worst?.deadline ?? null,
        messageAr: 'لا توجد سعة كافية قبل المواعيد المطلوبة رغم إعادة توزيع المهام على كل الأشخاص المتاحين.',
        messageEn: 'No capacity fits before the required dates, even after reconsidering every eligible person.',
      });
    }
    return {
      ok: false, items: result, conflicts,
      infeasibleProof: null, searchIncomplete: exhausted,
      stats: { expansions, backtracks, budget }, touched,
    };
  }

  // ------------------------------------------------------ assemble the items
  //
  // Production only. The old `scheduling` / `publish_check` tail used to be
  // placed forward from the ready date here, which charged publishing work to a
  // PRODUCTION bucket and gave N destinations a single owner. Releases are now
  // their own job — see `releases.ts`. Steps flagged `afterReady` are still
  // filtered out of `prod` above, because content pinned to an older workflow
  // version still carries them and they are not production effort.
  for (const it of ordered) {
    const info = perItem.get(it.key);
    if (!info) continue;
    const stages: PlannedStage[] = info.prod
      .map((s) => chosen.get(`${it.key}|${s.key}`))
      .filter((s): s is PlannedStage => Boolean(s));
    result.set(it.key, {
      key: it.key,
      requiredReadyAt: info.requiredReadyAt,
      productionStart: stages[0]?.start ?? info.requiredReadyAt,
      stages,
    });
  }

  for (const st of result.values()) {
    for (const s of st.stages) {
      if (!s.assigneeUserId) continue;
      const win = workingWindowEndingAt(s.end, effortWeights(s.workingDays).length, cal);
      for (const d of win) touched.push({ userId: s.assigneeUserId, day: d, bucket: s.bucket });
    }
  }

  return {
    ok: true, items: result, conflicts,
    infeasibleProof: null, searchIncomplete: false,
    stats: { expansions, backtracks, budget }, touched,
  };
}

/**
 * Sound capacity bound. For every (role, bucket) group and every deadline
 * horizon D, the work that MUST be done by D cannot exceed the free capacity
 * available up to D. Because a person holding two roles is counted in both
 * groups, the available side is an over-estimate — so this can only ever
 * PROVE infeasibility, never falsely claim it.
 */
function capacityBound(
  reqs: StageReq[],
  book: CapacityBook,
  _cal: WorkCalendar,
  today: string,
  conflicts: PlanConflict[],
): boolean {
  const groups = new Map<string, StageReq[]>();
  for (const r of reqs) {
    const k = `${r.step.roleKey}|${r.bucket}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  for (const [k, list] of groups) {
    const [roleKey, bucket] = k.split('|') as [PathRole, LoadBucket];
    const horizons = Array.from(new Set(list.map((r) => r.deadline))).sort();
    for (const D of horizons) {
      const required = list
        .filter((r) => daysBetween(r.deadline, D) >= 0)
        .reduce((acc, r) => acc + r.weights.reduce((a, b) => a + b, 0), 0);
      const available = book.freeCapacityInWindow(roleKey, bucket, today, D);
      if (required > available + 1e-9) {
        conflicts.push({
          kind: 'no_capacity', itemKey: null, stepKey: null, day: D,
          messageAr: `الطاقة المتاحة لدور «${roleKey}» في «${bucket}» حتى ${D} هي ${round(available)} يوم-فتحة بينما المطلوب ${round(required)} — مستحيل مهما أُعيد التوزيع.`,
          messageEn: `Role "${roleKey}" has ${round(available)} free slot-days in "${bucket}" up to ${D} but ${round(required)} are required — provably impossible however the work is rearranged.`,
          detail: { role: roleKey, bucket, horizon: D, required: round(required), available: round(available) },
        });
        return true;
      }
    }
  }
  return false;
}

const round = (n: number): number => Math.round(n * 100) / 100;
