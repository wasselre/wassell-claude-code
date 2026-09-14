/**
 * `planCampaign` — the one entry point used by BOTH the preview and the commit.
 *
 * Deterministic: the same (input, snapshot, rules, now) yields a byte-identical
 * result. That is what lets the commit path re-plan and compare, and it is
 * asserted by a test.
 *
 * Flow:
 *   requirements → items
 *   organic: distribute publishing slots first (batches, grid) ; paid: forecast
 *   refresh cycles first (creative slots) → need dates
 *   → backward deadlines → resource-constrained placement → reservations
 *   → load table, conflicts, totals, alternatives
 *
 * PURE — no I/O, no env, no Date.now() (the caller passes `today` in the
 * snapshot).
 */
import type { WorkCalendar } from './calendar';
import { addDays, daysBetween, dayOfInstant, addWorkingDays } from './calendar';
import { CapacityBook, buildLoadCells, effortWeights } from './ledger';
import { distribute, type DistItem, type PlatformPlan } from './distribute';
import { platformRulesFor } from './platforms';
import { forecastCycles, creativeTotals, type CycleForecast } from './refresh';
import { scheduleProduction, type ScheduleItem } from './schedule';
import {
  DEFAULTS, ENGINE_VERSION,
  type PlanBatch, type PlanConflict, type PlanInput, type PlanResult, type PlannedItem,
  type PlannedPlacement, type PlannedReservation, type WorkflowSpec, type WorkloadSnapshot,
  type PlatformRules, type LoadBucket,
} from './types';
import { CONTENT_TYPE_BUCKET, CONTENT_TYPE_WORKFLOW, DEFAULT_WORKFLOWS } from './defaults';
import { DEFAULT_PUBLISHING, buildReleases, releaseTotals, type PublishingRules } from './releases';

export interface RuleSet {
  workflows: Record<string, WorkflowSpec>;
  contentTypeWorkflow: Record<string, string>;
  contentTypeBucket: Record<string, 'post' | 'video'>;
  /** Per-platform distribution overrides, keyed by platform. */
  platformOverrides?: Record<string, Partial<PlatformRules>>;
  /** Who can publish by itself, and what a manual release costs. */
  publishing?: PublishingRules;
  searchBudget?: number;
}

export const DEFAULT_RULES: RuleSet = {
  workflows: DEFAULT_WORKFLOWS,
  contentTypeWorkflow: CONTENT_TYPE_WORKFLOW,
  contentTypeBucket: CONTENT_TYPE_BUCKET,
  publishing: DEFAULT_PUBLISHING,
};

interface BuildItem {
  key: string;
  title: string;
  contentTypeKey: string;
  bucket: 'post' | 'video';
  projectId: string;
  projectName?: string;
  workflowKey: string;
  slot?: PlannedItem['slot'];
  /** Paid items know their need day up-front; organic ones learn it from distribution. */
  fixedNeedDay?: string;
}

/* ------------------------------------------------------------------ */

export function planCampaign(
  input: PlanInput,
  snapshot: WorkloadSnapshot,
  rules: RuleSet = DEFAULT_RULES,
  opts: { withAlternatives?: boolean } = {},
): PlanResult {
  const withAlternatives = opts.withAlternatives !== false;
  const cal = snapshot.calendar;
  const conflicts: PlanConflict[] = [];
  const budget = rules.searchBudget ?? DEFAULTS.searchBudget;

  const book = new CapacityBook(snapshot, cal);
  book.freezeBaseline();

  // ------------------------------------------------------------- guardrails
  if (daysBetween(input.rangeStart, input.rangeEnd) < 0) {
    return empty(snapshot, [{
      kind: 'range_in_past', itemKey: null, stepKey: null, day: null,
      messageAr: 'تاريخ النهاية قبل تاريخ البداية.', messageEn: 'The end date precedes the start date.',
    }]);
  }
  if (daysBetween(snapshot.today, input.rangeEnd) < 0) {
    return empty(snapshot, [{
      kind: 'range_in_past', itemKey: null, stepKey: null, day: input.rangeEnd,
      messageAr: 'المدى المطلوب في الماضي.', messageEn: 'The requested range is in the past.',
    }]);
  }

  // ------------------------------------------------------------------ items
  const dropped = new Set(input.overrides?.droppedItemKeys ?? []);
  const items: BuildItem[] = [];
  const cycles: CycleForecast[] = [];

  if (input.kind === 'organic') {
    for (const p of input.projects) {
      for (let i = 0; i < Math.max(0, Math.floor(p.posts)); i += 1) {
        items.push(mkItem(rules, `${p.projectId}:post:${i + 1}`, 'post', p, i + 1));
      }
      for (let i = 0; i < Math.max(0, Math.floor(p.videos)); i += 1) {
        items.push(mkItem(rules, `${p.projectId}:video:${i + 1}`, 'video', p, i + 1));
      }
    }
  } else {
    const primary = input.projects[0];
    for (const child of input.paid ?? []) {
      const fc = forecastCycles(
        { executionKey: child.executionKey, startsOn: input.rangeStart, endsOn: input.rangeEnd, policy: child.policy },
        cal,
      );
      cycles.push(...fc);
      for (const c of fc) {
        if (!c.slotKinds.length || !c.readyBy) continue;
        c.slotKinds.forEach((kind, idx) => {
          const key = `${child.executionKey}:c${c.round}:s${idx + 1}`;
          items.push({
            key,
            title: c.round === 0
              ? `إطلاق — تصميم ${idx + 1}`
              : `تحديث ${c.round} — ${kind === 'fifth' ? 'التصميم الخامس' : `بديل ${idx + 1}`}`,
            contentTypeKey: 'post',
            bucket: rules.contentTypeBucket.post ?? 'post',
            projectId: primary?.projectId ?? '',
            projectName: primary?.projectName,
            workflowKey: rules.contentTypeWorkflow.post ?? 'post_std',
            slot: { executionKey: child.executionKey, cycleRound: c.round, slotIndex: idx, kind },
            fixedNeedDay: c.refreshOn ?? undefined,
          });
        });
      }
    }
  }

  const live = items.filter((i) => !dropped.has(i.key));
  if (!live.length) {
    return empty(snapshot, [{
      kind: 'not_enough_slots', itemKey: null, stepKey: null, day: null,
      messageAr: 'لا يوجد محتوى مطلوب في هذه الحملة.', messageEn: 'The campaign requires no content.',
    }]);
  }

  // ----------------------------------------------------------- distribution
  const placements = new Map<string, PlannedPlacement[]>();
  const batches: PlanBatch[] = [];

  if (input.kind === 'organic') {
    const platformPlans: PlatformPlan[] = input.platforms.map((platform) => {
      const freq = input.frequency.find((f) => f.platform === platform)
        ?? { platform, perDay: 1, weekdays: null };
      return {
        platform,
        executionKey: `exec:${platform}`,
        rules: platformRulesFor(platform, rules.platformOverrides?.[platform]),
        frequency: freq,
      };
    });
    const dist = distribute(
      live.map<DistItem>((i) => ({ key: i.key, projectId: i.projectId, bucket: i.bucket })),
      platformPlans, input.rangeStart, input.rangeEnd, cal, input.crossPost, Math.min(budget, 200_000),
    );
    conflicts.push(...dist.conflicts);
    for (const [k, v] of dist.placements) placements.set(k, v);
    applyLockedPlacements(placements, input, platformPlans, cal);

    if (!dist.ok) {
      const res = empty(snapshot, conflicts);
      res.searchIncomplete = conflicts.some((c) => c.kind === 'search_incomplete');
      res.totals = totalsOf(live, placements, batches, cycles, input);
      if (withAlternatives) res.alternatives = alternativesFor(input, snapshot, rules, dist.placedCount);
      return res;
    }
  } else {
    for (const it of live) {
      if (!it.fixedNeedDay) continue;
      const child = (input.paid ?? []).find((c) => c.executionKey === it.slot?.executionKey);
      const platform = child?.platform ?? 'meta';
      placements.set(it.key, [{
        platform,
        executionKey: it.slot!.executionKey,
        day: it.fixedNeedDay,
        plannedAt: `${it.fixedNeedDay}T09:00:00.000Z`,
        batchKey: `${it.slot!.executionKey}|c${it.slot!.cycleRound}`,
        slotIndex: it.slot!.slotIndex,
        gridRow: null,
        gridCol: null,
      }]);
    }
  }

  // batches (one per execution × day for organic, per cycle for paid)
  const batchMap = new Map<string, PlanBatch>();
  for (const [itemKey, list] of placements) {
    for (const pl of list) {
      let b = batchMap.get(pl.batchKey);
      if (!b) {
        b = { key: pl.batchKey, executionKey: pl.executionKey, platform: pl.platform, day: pl.day, sequence: 0, itemKeys: [] };
        batchMap.set(pl.batchKey, b);
      }
      if (!b.itemKeys.includes(itemKey)) b.itemKeys.push(itemKey);
    }
  }
  const sortedBatches = Array.from(batchMap.values()).sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0);
  sortedBatches.forEach((b, i) => { b.sequence = i + 1; b.itemKeys.sort(); });
  batches.push(...sortedBatches);
  const batchSeq = new Map(sortedBatches.map((b) => [b.key, b.sequence] as const));

  // ------------------------------------------------------------- scheduling
  const scheduleInput: ScheduleItem[] = [];
  const needDayOf = new Map<string, string>();
  for (const it of live) {
    const pls = placements.get(it.key) ?? [];
    if (!pls.length) continue;
    const needDay = pls.map((p) => dayOfInstant(p.plannedAt, cal)).sort()[0] ?? input.rangeStart;
    needDayOf.set(it.key, needDay);
    const firstBatch = Math.min(...pls.map((p) => batchSeq.get(p.batchKey) ?? 9999));
    const minSlot = Math.min(...pls.map((p) => p.slotIndex));
    const wf = rules.workflows[it.workflowKey] ?? DEFAULT_WORKFLOWS.post_std;
    if (!wf) continue;
    scheduleInput.push({
      key: it.key,
      priority: firstBatch * 1000 + minSlot,
      workflow: wf,
      needDay,
      publishBufferDays: input.publishBufferDays ?? DEFAULTS.publishBufferDays,
      lockedAssignees: pickLocks(input, it.key),
    });
  }

  const sched = scheduleProduction(scheduleInput, book, cal, snapshot.today, budget);
  conflicts.push(...sched.conflicts);

  // --------------------------------------------------------------- assemble
  const plannedItems: PlannedItem[] = [];
  const reservations: PlannedReservation[] = [];
  for (const it of live) {
    const st = sched.items.get(it.key);
    const pls = placements.get(it.key) ?? [];
    const needDay = needDayOf.get(it.key) ?? input.rangeStart;
    const si = scheduleInput.find((x) => x.key === it.key);
    plannedItems.push({
      key: it.key,
      title: it.title,
      contentTypeKey: it.contentTypeKey,
      bucket: it.bucket,
      projectId: it.projectId,
      projectName: it.projectName,
      workflowKey: it.workflowKey,
      needAt: pls.map((p) => p.plannedAt).sort()[0] ?? `${needDay}T09:00:00.000Z`,
      requiredReadyAt: st?.requiredReadyAt ?? '',
      productionStart: st?.productionStart ?? '',
      priority: si?.priority ?? 9_999_000,
      stages: st?.stages ?? [],
      placements: pls,
      slot: it.slot,
    });
    for (const s of st?.stages ?? []) {
      const w = effortWeights(s.workingDays);
      reservations.push({
        itemKey: it.key,
        stepKey: s.stepKey,
        roleKey: s.roleKey,
        bucket: s.bucket,
        assigneeUserId: s.assigneeUserId,
        plannedStart: s.start,
        plannedEnd: s.end,
        weight: w.reduce((a, b) => a + b, 0),
      });
    }
  }
  plannedItems.sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));

  // Releases are planned AFTER production, from the placements, and booked
  // against their own `publishing` bucket. They are never allowed to make a
  // campaign infeasible: the creative is finished either way, and a post that
  // goes out late is a late post, not an impossible plan.
  const rel = buildReleases(
    plannedItems, input.kind, rules.publishing ?? DEFAULT_PUBLISHING, book, cal,
  );
  conflicts.push(...rel.conflicts);

  const load = buildLoadCells(book, snapshot, [...sched.touched, ...rel.touched]);
  const feasible = sched.ok && conflicts.every((c) => c.kind !== 'not_enough_slots' && c.kind !== 'platform_rule');

  const starts = plannedItems.map((i) => i.productionStart).filter(Boolean).sort();
  const ends = plannedItems.flatMap((i) => i.stages.map((s) => s.end)).filter(Boolean).sort();

  const result: PlanResult = {
    feasible,
    infeasibleProof: sched.infeasibleProof,
    searchIncomplete: sched.searchIncomplete || conflicts.some((c) => c.kind === 'search_incomplete'),
    searchStats: sched.stats,
    items: plannedItems,
    batches,
    releases: rel.releases,
    reservations,
    cycles: cycles.map(({ slotKinds, ...c }) => ({ ...c, produced: slotKinds.length })),
    load,
    conflicts,
    totals: { ...totalsOf(live, placements, batches, cycles, input), releases: releaseTotals(rel.releases) },
    alternatives: { earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: null },
    productionWindow: { start: starts[0] ?? null, end: ends[ends.length - 1] ?? null },
    snapshotHash: snapshot.hash,
    engineVersion: ENGINE_VERSION,
  };

  if (!feasible && withAlternatives) {
    result.alternatives = alternativesFor(input, snapshot, rules, live.length);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* alternatives                                                        */
/* ------------------------------------------------------------------ */

/**
 * When the requested range does not work, offer two honest options:
 *   • the smallest forward shift of the whole window that plans cleanly, and
 *   • the largest item count that fits the dates as requested.
 * Both are computed by re-running the SAME engine (with alternatives off, so
 * the recursion is one level deep).
 */
function alternativesFor(
  input: PlanInput, snapshot: WorkloadSnapshot, rules: RuleSet, placedHint: number,
): PlanResult['alternatives'] {
  let earliestStart: string | null = null;
  let earliestEnd: string | null = null;
  const span = daysBetween(input.rangeStart, input.rangeEnd);
  for (const shift of [1, 2, 3, 4, 5, 7, 10, 14, 21, 28, 35, 45, 60]) {
    const start = addDays(input.rangeStart, shift);
    const end = addDays(start, span);
    const probe = planCampaign(
      { ...input, rangeStart: start, rangeEnd: end }, snapshot, rules, { withAlternatives: false },
    );
    if (probe.feasible) { earliestStart = start; earliestEnd = end; break; }
  }

  let maxItems: number | null = null;
  const total = countRequested(input);
  if (total > 1) {
    let lo = 0;
    let hi = Math.min(total - 1, Math.max(0, placedHint));
    // Binary search on "keep the first N items in priority order".
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const probe = planCampaign(
        withItemCap(input, mid), snapshot, rules, { withAlternatives: false },
      );
      if (probe.feasible) lo = mid; else hi = mid - 1;
    }
    maxItems = lo > 0 ? lo : null;
  }
  return { earliestFeasibleStart: earliestStart, earliestFeasibleEnd: earliestEnd, maxItemsInRange: maxItems };
}

function countRequested(input: PlanInput): number {
  if (input.kind === 'organic') {
    return input.projects.reduce((a, p) => a + Math.max(0, p.posts) + Math.max(0, p.videos), 0);
  }
  return (input.paid ?? []).length * 5;
}

/** Trim the requirement to `n` items, dropping from the LAST projects/counts. */
function withItemCap(input: PlanInput, n: number): PlanInput {
  if (input.kind !== 'organic') return input;
  let left = n;
  const projects = input.projects.map((p) => {
    const posts = Math.min(Math.max(0, p.posts), Math.max(0, left));
    left -= posts;
    const videos = Math.min(Math.max(0, p.videos), Math.max(0, left));
    left -= videos;
    return { ...p, posts, videos };
  });
  return { ...input, projects };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function mkItem(
  rules: RuleSet, key: string, kind: 'post' | 'video',
  p: PlanInput['projects'][number], n: number,
): BuildItem {
  const typeKey = kind;
  return {
    key,
    title: `${p.projectName ?? ''} ${kind === 'post' ? 'منشور' : 'فيديو'} ${n}`.trim(),
    contentTypeKey: typeKey,
    bucket: rules.contentTypeBucket[typeKey] ?? kind,
    projectId: p.projectId,
    projectName: p.projectName,
    workflowKey: rules.contentTypeWorkflow[typeKey] ?? (kind === 'video' ? 'video_std' : 'post_std'),
  };
}

function pickLocks(input: PlanInput, itemKey: string): Record<string, string> | undefined {
  const all = input.overrides?.lockedAssignees;
  if (!all) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    const [ik, step] = k.split(':');
    if (ik === itemKey && step) out[step] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Honour a drag-and-drop reorder: the locked item takes the given slot verbatim. */
function applyLockedPlacements(
  placements: Map<string, PlannedPlacement[]>,
  input: PlanInput,
  platformPlans: PlatformPlan[],
  cal: WorkCalendar,
): void {
  const locks = input.overrides?.lockedPlacements ?? [];
  for (const lock of locks) {
    const plan = platformPlans.find((p) => p.platform === lock.platform);
    if (!plan) continue;
    const existing = placements.get(lock.itemKey) ?? [];
    const rest = existing.filter((p) => p.platform !== lock.platform);
    const cols = plan.rules.gridColumns;
    rest.push({
      platform: lock.platform,
      executionKey: plan.executionKey,
      day: lock.day,
      plannedAt: `${lock.day}T${String(12 + lock.index).padStart(2, '0')}:00:00.000Z`,
      batchKey: `${plan.executionKey}|${lock.day}`,
      slotIndex: lock.index,
      gridRow: cols ? Math.floor(lock.index / cols) : null,
      gridCol: cols ? lock.index % cols : null,
    });
    placements.set(lock.itemKey, rest);
  }
  void cal;
}

function totalsOf(
  items: BuildItem[],
  placements: Map<string, PlannedPlacement[]>,
  batches: PlanBatch[],
  cycles: CycleForecast[],
  input: PlanInput,
): PlanResult['totals'] {
  const perProject = new Map<string, { projectId: string; projectName?: string; items: number }>();
  for (const i of items) {
    const cur = perProject.get(i.projectId) ?? { projectId: i.projectId, projectName: i.projectName, items: 0 };
    cur.items += 1;
    perProject.set(i.projectId, cur);
  }
  const perPlatform = new Map<string, number>();
  let placementCount = 0;
  for (const list of placements.values()) {
    for (const p of list) {
      perPlatform.set(p.platform, (perPlatform.get(p.platform) ?? 0) + 1);
      placementCount += 1;
    }
  }
  const slotDays: Record<string, number> = {};
  for (const i of items) {
    const wf = DEFAULT_WORKFLOWS[i.workflowKey];
    if (!wf) continue;
    for (const st of wf.steps) {
      const b: LoadBucket = st.isApproval ? 'approvals' : i.bucket;
      slotDays[b] = (slotDays[b] ?? 0) + st.workingDays;
    }
  }
  return {
    items: items.length,
    posts: items.filter((i) => i.bucket === 'post').length,
    videos: items.filter((i) => i.bucket === 'video').length,
    placements: placementCount,
    batches: batches.length,
    slotDaysByBucket: slotDays,
    perProject: Array.from(perProject.values()),
    perPlatform: Array.from(perPlatform.entries()).map(([platform, n]) => ({ platform, placements: n })),
    // Overwritten by the caller once releases exist; zeroed here so an early
    // return still carries the field rather than an undefined the UI must guard.
    releases: { total: 0, automatic: 0, manual: 0 },
    creatives: input.kind === 'paid' ? creativeTotals(cycles) : undefined,
  };
}

function empty(snapshot: WorkloadSnapshot, conflicts: PlanConflict[]): PlanResult {
  return {
    feasible: false,
    infeasibleProof: null,
    searchIncomplete: false,
    searchStats: { expansions: 0, backtracks: 0, budget: 0 },
    items: [], batches: [], releases: [], reservations: [], cycles: [], load: [],
    conflicts,
    totals: {
      items: 0, posts: 0, videos: 0, placements: 0, batches: 0,
      slotDaysByBucket: {}, perProject: [], perPlatform: [],
      releases: { total: 0, automatic: 0, manual: 0 },
    },
    alternatives: { earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: null },
    productionWindow: { start: null, end: null },
    snapshotHash: snapshot.hash,
    engineVersion: ENGINE_VERSION,
  };
}

export { addWorkingDays };
export { slotCapacity } from './distribute';
