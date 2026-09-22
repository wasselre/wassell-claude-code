/**
 * Production scheduling against the live work ledger.
 *
 * Given each item's publishing date(s), this computes the stage deadlines
 * (backward from the required-ready date) and then PLACES every stage on a real
 * person and real working days, respecting the capacity already committed to
 * other work.
 *
 * Two properties the reviews demanded:
 *
 *  1. **Publishing batches drive production.** Items are placed in publishing
 *     order, so batch 1 chooses its days before batch 2 — a later batch's
 *     capacity problem can never displace an earlier batch. WHERE inside its
 *     window each stage lands is `placement`:
 *       • `earliest` (the rule since 2026-09-22 — the operator: «tasks should
 *         be booked as early as possible, not as late as possible»): stages
 *         FIRST to LAST, each on the first window with room at or after the
 *         item's production-window start (`earliestStart`, today when unset)
 *         and its predecessor's end, never past its own deadline. A month's
 *         work is therefore done as soon as capacity allows and the slack
 *         sits AFTER the work, not before it.
 *       • `latest`: stages LAST to FIRST, each as late as its deadline allows
 *         (the pre-2026-09-22 behaviour, kept for rollback).
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
import {
  addWorkingDays, daysBetween, isWorkingDay, nextWorkingDay, prevWorkingDay,
  workingDaysIn, workingWindowEndingAt, workingWindowStartingAt,
} from './calendar';
import { CapacityBook, effortWeights, effortWeightsSameDay } from './ledger';
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
  /**
   * The day this item's production may START (its lead-time window's first
   * working day). Earliest-first placement books forward from here; `today`
   * when unset or in the past. Ignored by latest-first placement.
   */
  earliestStart?: string;
  lockedAssignees?: Record<string, string>;
  /**
   * SAME-DAY mode — the subject is a ROW of N posts worked in one sitting.
   *
   * Every stage then occupies exactly ONE day and charges `sameDaySlots` slots
   * on it (`effortWeightsSameDay`), instead of one slot on each of
   * `step.workingDays` days. The step's day-estimate is deliberately ignored:
   * the month model counts throughput as one number per person per day (the
   * proposal's §0 — the second knob, "days per task", is what silently halved
   * the designer and produced a false "does not fit"), and A5 removed the
   * per-step effort rows for posts for exactly that reason.
   *
   * `undefined` = the classic path, untouched.
   */
  sameDaySlots?: number;
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
 * The per-day weights ONE stage of `item` consumes.
 *
 * Classic: `effortWeights(step.workingDays)` — N days, one slot each.
 * Row (`sameDaySlots`): one day carrying every member's slot.
 */
function stageWeights(step: StepSpec, sameDaySlots?: number): number[] {
  return sameDaySlots && sameDaySlots > 0
    ? effortWeightsSameDay(sameDaySlots)
    : effortWeights(step.workingDays);
}

/**
 * Backward deadlines: the last production step ends on the required-ready day,
 * and every earlier step must END `span(next)` working days before that.
 *
 * `spanOf` overrides how long a step occupies; a ROW passes `() => 1`, because
 * each of its stages is one sitting on one day.
 *
 * `sameDayChain` (see `WorkflowSpec.sameDayChain`): the predecessor may END on
 * the day its successor STARTS, rather than the working day before it. For a
 * one-day successor that is the same day.
 */
export function computeDeadlines(
  steps: StepSpec[],
  requiredReadyAt: string,
  cal: WorkCalendar,
  spanOf: (step: StepSpec) => number = (step) => effortWeights(step.workingDays).length,
  sameDayChain = false,
): string[] {
  const out: string[] = new Array<string>(steps.length).fill(requiredReadyAt);
  if (!steps.length) return out;
  out[steps.length - 1] = requiredReadyAt;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    const next = steps[i + 1];
    const later = out[i + 1] ?? requiredReadyAt;
    const nextSpan = next ? spanOf(next) : 1;
    out[i] = addWorkingDays(later, -(sameDayChain ? nextSpan - 1 : nextSpan), cal);
  }
  return out;
}

/** Earliest possible end for each step given `today` and infinite people. */
function earliestEnds(
  steps: StepSpec[], today: string, cal: WorkCalendar, spanOf: (step: StepSpec) => number,
  sameDayChain = false,
): string[] {
  const out: string[] = new Array<string>(steps.length).fill(today);
  let cursor = nextWorkingDay(today, cal);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const span = step ? spanOf(step) : 1;
    const end = addWorkingDays(cursor, span - 1, cal);
    out[i] = end;
    // The mirror of `computeDeadlines`: the next step may start the day this one
    // ends. Both bounds must move together, or the time proof and the deadlines
    // disagree about what "fits".
    cursor = sameDayChain ? end : addWorkingDays(end, 1, cal);
  }
  return out;
}

export type Placement = 'earliest' | 'latest';

export interface ScheduleOptions {
  placement?: Placement;
  /**
   * A SEEDED placement: every stage's (person, window) is given — keyed
   * `<itemKey>|<stepKey>` — and the search is skipped. The seed is booked
   * as-is (a misfit throws: it is an invariant violation, not a planning
   * outcome) and only the earliest-first pass runs on top of it.
   *
   * This is how a MONTH gets earliest-first placement without starving its
   * later plans: `compileMonth` first places its four plans backward, in
   * sequence, then re-places each one from its own seed against a ledger that
   * holds every OTHER plan's cells — so a stage only ever moves into capacity
   * nobody else is using. Running the forward pass inside each plan's own
   * search (2026-09-22, first attempt) let the organic plan fill the early
   * days before the paid plans were placed, and a 16-Sep catch-up month lost
   * its 20-Sep batch.
   */
  seed?: ReadonlyMap<string, PlannedStage>;
}

export function scheduleProduction(
  items: ScheduleItem[],
  book: CapacityBook,
  cal: WorkCalendar,
  today: string,
  budget: number,
  opts: ScheduleOptions = {},
): ScheduleResult {
  const placement: Placement = opts.placement ?? 'earliest';
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
    const spanOf = (step: StepSpec): number => stageWeights(step, it.sameDaySlots).length;
    let ready = it.needDay;
    for (let i = 0; i < Math.max(0, it.publishBufferDays); i += 1) ready = addWorkingDays(ready, -1, cal);
    if (it.publishBufferDays <= 0) ready = prevWorkingDay(it.needDay, cal);
    const chain = it.workflow.sameDayChain === true;
    const deadlines = computeDeadlines(prod, ready, cal, spanOf, chain);
    perItem.set(it.key, { requiredReadyAt: ready, prod, deadlines });

    // ---- sound bound #1: time. Even with infinite people, does the chain fit?
    const est = earliestEnds(prod, today, cal, spanOf, chain);
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
      const w = stageWeights(step, it.sameDaySlots);
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
  // The search itself is backward (latest-first): it proves feasibility with a
  // bounded, well-tested search. Earliest-first placement is a SECOND pass
  // over the feasible schedule (the block after the search) — a forward
  // search greedily fills the early days with slack work and then cannot
  // backtrack far enough, within any budget, to free them for tight work
  // (measured on the 16-Sep catch-up scenario: two designers, fifteen
  // creatives due the 20th, feasible backward, "no capacity" forward). A
  // SEEDED call (`opts.seed`) skips the search and books the given stages.
  const plan: StageReq[][] = ordered.map((it) =>
    reqs.filter((r) => r.itemKey === it.key).sort((a, b) => b.order - a.order));
  const flat: StageReq[] = plan.flat();
  const forward = placement === 'earliest';

  /** The first working day an item may be worked on: its window start, never before today. */
  const floorOf = new Map<string, string>();
  for (const it of ordered) {
    const base = it.earliestStart && daysBetween(today, it.earliestStart) > 0 ? it.earliestStart : today;
    floorOf.set(it.key, nextWorkingDay(base, cal));
  }

  const chosen = new Map<string, PlannedStage>();
  let expansions = 0;
  let backtracks = 0;
  let exhausted = false;

  const stageKey = (r: StageReq): string => `${r.itemKey}|${r.step.key}`;
  const reqByKey = new Map(flat.map((r) => [stageKey(r), r] as const));

  /** Latest END this stage may take: its own deadline, capped by the successor's start. */
  const effectiveDeadline = (r: StageReq): string => {
    const succ = chosen.get(`${r.itemKey}|${succKeyOf(r)}`);
    if (!succ) return r.deadline;
    // Same rule as `computeDeadlines`: on a same-day path a step may finish on
    // the day its successor starts; otherwise it must finish the day before.
    const chain = itemByKey.get(r.itemKey)?.workflow.sameDayChain === true;
    const cap = chain ? succ.start : addWorkingDays(succ.start, -1, cal);
    // The EARLIER of the two. Until 2026-09-22 this returned the later one, so
    // a predecessor kept its own deadline when its successor had been pulled
    // earlier by capacity, and 35 live creatives had the design booked after
    // the writer's check of it (`successorCap.test.ts`).
    return daysBetween(cap, r.deadline) > 0 ? cap : r.deadline;
  };

  function succKeyOf(r: StageReq): string {
    const info = perItem.get(r.itemKey)!;
    const next = info.prod[r.order + 1];
    return next ? next.key : ' none';
  }

  /** The people who may take a stage: the role's holders, or the one locked to it. */
  const peopleFor = (r: StageReq) => {
    const lockedUser = itemByKey.get(r.itemKey)?.lockedAssignees?.[r.step.key] ?? null;
    let people = book.eligible(r.step.roleKey, r.bucket);
    if (lockedUser) people = people.filter((p) => p.userId === lockedUser);
    return people;
  };

  /**
   * Person order for one window: most free capacity across it (balance), then
   * fewest total open slots, then id — deterministic. Only people with room.
   */
  const rankedFor = (r: StageReq, win: string[], people: ReturnType<typeof peopleFor>) => people
    .map((p) => ({
      p,
      free: Math.min(...win.map((d, i) => book.freeOn(p.userId, d, r.bucket) - (r.weights[i] ?? 1))),
      load: win.reduce((acc, d) => acc + book.usedOn(p.userId, d, r.bucket), 0),
    }))
    .filter((x) => x.free >= -1e-9)
    .sort((a, b) => (b.free - a.free) || (a.load - b.load) || (a.p.userId < b.p.userId ? -1 : 1));

  const stageOn = (r: StageReq, userId: string, win: string[]): PlannedStage => ({
    stepKey: r.step.key,
    roleKey: r.step.roleKey,
    bucket: r.bucket,
    assigneeUserId: userId,
    start: win[0] as string,
    end: win[win.length - 1] as string,
    deadline: r.deadline,
    // The step's ESTIMATE, kept for display and for the effort screens.
    workingDays: r.step.workingDays,
    // What was actually reserved, day by day. For a ROW this is `[3]` on
    // one day while `workingDays` still reads the step's `2` — recording
    // only the estimate left every reader to re-derive the booking from a
    // number that does not describe it.
    slotWeights: r.weights.slice(0, win.length),
  });

  const dfs = (idx: number): boolean => {
    if (idx >= flat.length) return true;
    expansions += 1;
    if (expansions > budget) { exhausted = true; return false; }

    const r = flat[idx];
    if (!r) return dfs(idx + 1);
    const dl = effectiveDeadline(r);
    if (daysBetween(today, dl) < 0) return false;

    const people = peopleFor(r);
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
      if (!winStart) break;
      if (daysBetween(today, winStart) < 0) break;

      for (const cand of rankedFor(r, win, people)) {
        win.forEach((d, i) => book.add(cand.p.userId, d, r.bucket, r.weights[i] ?? 1));
        chosen.set(stageKey(r), stageOn(r, cand.p.userId, win));
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

  let ok: boolean;
  if (opts.seed) {
    const seed = opts.seed;
    for (const r of flat) {
      const k = stageKey(r);
      const s = seed.get(k);
      if (!s || !s.assigneeUserId) throw new Error(`scheduleProduction: seed has no stage for ${k}`);
      const win = workingDaysIn(s.start, s.end, cal);
      if (win.length !== r.span) {
        throw new Error(`scheduleProduction: seed stage ${k} spans ${win.length} working day(s), the step needs ${r.span}`);
      }
      if (daysBetween(win[win.length - 1] as string, r.deadline) < 0) {
        throw new Error(`scheduleProduction: seed stage ${k} ends ${s.end}, after its deadline ${r.deadline}`);
      }
      if (!book.fits(s.assigneeUserId, win, r.bucket, r.weights)) {
        throw new Error(`scheduleProduction: seed stage ${k} does not fit ${s.assigneeUserId} on ${win.join(",")}`);
      }
      win.forEach((d, i) => book.add(s.assigneeUserId as string, d, r.bucket, r.weights[i] ?? 1));
      chosen.set(k, stageOn(r, s.assigneeUserId, win));
    }
    ok = true;
  } else {
    ok = dfs(0);
  }

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

  /*
   * EARLIEST-FIRST (the rule since 2026-09-22 — the operator: «tasks should
   * be booked as early as possible, not as late as possible»).
   *
   * The backward search above found a feasible schedule with every stage at
   * its LATEST day. This pass walks the items in publishing order and each
   * item's chain FIRST → LAST, and moves every stage to the earliest window
   * that (a) is on or after the item's production-window start (its lead time
   * before the need day, never before today), (b) starts after its predecessor
   * ends (on the same day for a same-day chain), and (c) has room for a person
   * who may take it — the current holder or any other eligible one. A stage
   * that cannot move keeps its place, so the schedule can only get earlier and
   * never stops being feasible; the deadline it was found under still holds.
   * Repeated until nothing moves (bounded), because a stage that moves frees
   * days for the ones behind it.
   *
   * It moves only into capacity THIS book shows as free. A plan compiled on
   * its own sees the whole ledger, so that is exact; the four plans of a
   * month each see only the plans before them, which is why `compileMonth`
   * runs this pass through a seeded re-placement against all the others
   * (`ScheduleOptions.seed`).
   */
  if (forward) {
    for (let pass = 0; pass < 4; pass += 1) {
      let moved = 0;
      for (const it of ordered) {
        const info = perItem.get(it.key);
        if (!info) continue;
        const chain = it.workflow.sameDayChain === true;
        for (let i = 0; i < info.prod.length; i += 1) {
          const step = info.prod[i];
          if (!step) continue;
          const key = `${it.key}|${step.key}`;
          const cur = chosen.get(key);
          const r = reqByKey.get(key);
          if (!cur || !r || !cur.assigneeUserId) continue;
          let start = floorOf.get(it.key) ?? today;
          const prev = i > 0 ? info.prod[i - 1] : undefined;
          const pred = prev ? chosen.get(`${it.key}|${prev.key}`) : undefined;
          if (pred) {
            const after = chain ? pred.end : addWorkingDays(pred.end, 1, cal);
            if (daysBetween(start, after) > 0) start = after;
          }
          start = nextWorkingDay(start, cal);
          if (daysBetween(start, cur.start) <= 0) continue;   // already as early as it can be

          // Lift the current booking so its own cells count as free.
          const curDays = workingDaysIn(cur.start, cur.end, cal);
          curDays.forEach((d, j) => book.remove(cur.assigneeUserId as string, d, r.bucket, r.weights[j] ?? 1));
          const people = peopleFor(r);
          let placed: PlannedStage | null = null;
          for (let s = start; daysBetween(s, cur.start) > 0; s = addWorkingDays(s, 1, cal)) {
            const win = workingWindowStartingAt(s, r.span, cal);
            const winEnd = win[win.length - 1];
            if (!winEnd || daysBetween(winEnd, r.deadline) < 0) break;
            const cand = rankedFor(r, win, people)[0];
            if (!cand) continue;
            win.forEach((d, j) => book.add(cand.p.userId, d, r.bucket, r.weights[j] ?? 1));
            placed = stageOn(r, cand.p.userId, win);
            break;
          }
          if (placed) {
            chosen.set(key, placed);
            moved += 1;
          } else {
            curDays.forEach((d, j) => book.add(cur.assigneeUserId as string, d, r.bucket, r.weights[j] ?? 1));
          }
        }
      }
      if (moved === 0) break;
    }
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
      // The window ACTUALLY booked, read off the stage itself. Recomputing it
      // from `effortWeights(s.workingDays)` was right only while every stage
      // spanned its own effort; a row's stage spans ONE day whatever its step
      // estimate says, and the load table would have missed its cells.
      for (const d of workingDaysIn(s.start, s.end, cal)) {
        touched.push({ userId: s.assigneeUserId, day: d, bucket: s.bucket });
      }
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
