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
import { CapacityBook, buildLoadCells } from './ledger';
import { distribute, type DistItem, type PlatformPlan } from './distribute';
import { platformRulesFor } from './platforms';
import { forecastCycles, creativeTotals, type CycleForecast } from './refresh';
import { scheduleProduction, type ScheduleItem } from './schedule';
import {
  DEFAULTS, ENGINE_VERSION,
  type PlanBatch, type PlanConflict, type PlanInput, type PlanResult, type PlannedItem,
  type PlannedPlacement, type PlannedReservation, type PlannedRow, type PlannedStage,
  type RowRequirement, type WorkflowSpec, type WorkloadSnapshot, type PlatformRules,
  type LoadBucket,
  conflictBlocksPlan,
} from './types';
import { CONTENT_TYPE_BUCKET, CONTENT_TYPE_WORKFLOW, DEFAULT_WORKFLOWS } from './defaults';
import {
  DEFAULT_PUBLISHING, DEFAULT_ROW_PUBLISHING, buildReleases, checkRowPublishing, releaseTotals,
  rowReleaseInstant, type PublishingRules,
} from './releases';

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
  /** `null` only for a member of the general row (A8b). */
  projectId: string | null;
  projectName?: string;
  workflowKey: string;
  slot?: PlannedItem['slot'];
  /**
   * The day this item is needed, known UP-FRONT: paid creatives get it from the
   * refresh forecast, row members from the month template. Only the wizard's
   * loose organic items learn it from `distribute()` — a search.
   */
  fixedNeedDay?: string;
  /** Row members only. */
  rowKey?: string;
  rowOrder?: number;
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
  /**
   * A budget of ZERO means "do not SEARCH" — the month model fixes every
   * publishing day from the template, so distribution has nothing to look for
   * and `monthCompiler` passes 0 deliberately.
   *
   * It must NOT mean "place nothing". `scheduleProduction`'s very first
   * expansion would exceed a zero budget, so the whole month would come back
   * infeasible at expansion 1 with `searchIncomplete: true` — a refusal to
   * assign people, not a refusal to search for a calendar. Production placement
   * therefore falls back to the engine default. Every non-zero budget behaves
   * exactly as before.
   */
  const placementBudget = budget > 0 ? budget : DEFAULTS.searchBudget;

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
  const rowSpecs: RowRequirement[] = input.kind === 'organic' ? (input.rows ?? []) : [];
  const rowMode = rowSpecs.length > 0;
  const rowByKey = new Map(rowSpecs.map((r) => [r.rowKey, r] as const));
  const pub = (rules.publishing ?? DEFAULT_PUBLISHING).rowPublishing ?? DEFAULT_ROW_PUBLISHING;

  if (rowMode) {
    // ROW-AWARE path. Every member's day is already decided by the template, so
    // Instagram's "never the same project twice in a row" holds BY
    // CONSTRUCTION — Sun أ · Tue ب · Thu ج · Sat general — and `distribute()`,
    // a backtracking search, is never run.
    for (const row of rowSpecs) {
      const typeKey = row.contentTypeKey ?? 'post';
      const label = row.projectName ?? row.labelAr ?? (row.projectId ? '' : 'عام');
      for (let i = 0; i < Math.max(0, Math.floor(row.posts)); i += 1) {
        items.push({
          key: `${row.rowKey}:post:${i + 1}`,
          title: `${label} منشور ${i + 1}`.trim(),
          contentTypeKey: typeKey,
          bucket: rules.contentTypeBucket[typeKey] ?? 'post',
          projectId: row.projectId,
          projectName: row.projectName,
          workflowKey: rules.contentTypeWorkflow[typeKey] ?? 'post_std',
          fixedNeedDay: row.day,
          rowKey: row.rowKey,
          rowOrder: i,
        });
      }
    }
  } else if (input.kind === 'organic') {
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
  /** Live members of each row, in the writer's order. */
  const rowMembers = new Map<string, BuildItem[]>();
  if (rowMode) {
    for (const it of live) {
      if (!it.rowKey) continue;
      const arr = rowMembers.get(it.rowKey) ?? [];
      arr.push(it);
      rowMembers.set(it.rowKey, arr);
    }
    for (const arr of rowMembers.values()) arr.sort((a, b) => (a.rowOrder ?? 0) - (b.rowOrder ?? 0));
  }

  if (rowMode) {
    // Placement without a search: the row names the day, and the member's
    // position inside the day is the REVERSE of the writer's order, so the
    // post placed first publishes last and the reader meets it first.
    const liveRows = rowSpecs
      .filter((r) => (rowMembers.get(r.rowKey) ?? []).length > 0)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.rowKey < b.rowKey ? -1 : 1));
    const gridRowOf = new Map<string, number>();
    const perPlatformRow = new Map<string, number>();
    for (const r of liveRows) {
      const n = perPlatformRow.get(r.platform) ?? 0;
      gridRowOf.set(r.rowKey, n);
      perPlatformRow.set(r.platform, n + 1);
    }
    // The publishing moment is OPERATOR DATA, checked ONCE against the widest
    // row that will use it — only the widest can push past midnight. Both
    // failures used to be swallowed inside `rowSlotTime`: an unparseable time
    // became 18:00 with no signal, and an overflowing row had its members
    // clamped onto 23:59, collapsing the very publish order the reverse rule
    // exists to produce. Neither may reach the database.
    const widest = Math.max(1, ...liveRows.map((r) => (rowMembers.get(r.rowKey) ?? []).length));
    const pubCheck = checkRowPublishing(rules.publishing?.rowPublishing, widest);
    if (pubCheck.invalidTime) {
      conflicts.push({
        kind: 'publish_time', itemKey: null, stepKey: null, day: null,
        messageAr: `وقت النشر «${rules.publishing?.rowPublishing?.publishTime ?? ''}» غير صالح — المتوقع صيغة HH:MM بين 00:00 و23:59. صحّح publish_time في قالب الشهر.`,
        messageEn: `The publishing time "${rules.publishing?.rowPublishing?.publishTime ?? ''}" is not a valid HH:MM between 00:00 and 23:59. Fix publish_time on the month template.`,
        detail: { publishTime: rules.publishing?.rowPublishing?.publishTime ?? null, usedInstead: pubCheck.publishTime },
      });
    }
    if (pubCheck.clamped) {
      conflicts.push({
        kind: 'publish_time', itemKey: null, stepKey: null, day: null,
        messageAr: `دفعة من ${widest} منشورات يبدأ ${pubCheck.publishTime} بفاصل ${pubCheck.gap} دقيقة ينتهي ${pubCheck.wouldEndAt} — بعد منتصف الليل، فيتكدّس منشوران على 23:59 ويضيع ترتيب النشر. قلّل الفاصل أو قدّم وقت النشر.`,
        messageEn: `A batch of ${widest} posts starting at ${pubCheck.publishTime} with a ${pubCheck.gap}-minute gap ends at ${pubCheck.wouldEndAt} — past midnight, so two posts collide on 23:59 and the publish order is lost. Reduce the gap or move the publishing time earlier.`,
        detail: {
          rowSize: widest, publishTime: pubCheck.publishTime,
          intraRowGapMinutes: pubCheck.gap, wouldEndAt: pubCheck.wouldEndAt,
        },
      });
    }

    for (const r of liveRows) {
      const members = rowMembers.get(r.rowKey) ?? [];
      const size = members.length;
      const executionKey = `exec:${r.platform}`;
      members.forEach((it, order) => {
        placements.set(it.key, [{
          platform: r.platform,
          executionKey,
          day: r.day,
          plannedAt: rowReleaseInstant(r.day, order, size, pub, cal),
          batchKey: `${executionKey}|${r.day}`,
          // Publish order inside the day — the reverse of `row_order`.
          slotIndex: size - 1 - order,
          // Profile-grid coordinates, NOT publish order (A9): one row of the
          // Instagram grid per posting day, read left-to-right in the writer's
          // order, which is how the grid itself reads.
          gridRow: gridRowOf.get(r.rowKey) ?? 0,
          gridCol: order,
        }]);
      });
    }
  } else if (input.kind === 'organic') {
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
      // Only the loose-item path reaches `distribute`, and every loose item has
      // a project — a null one can only come from the general row, which is
      // placed by its template day and never distributed.
      live.map<DistItem>((i) => ({ key: i.key, projectId: i.projectId ?? '', bucket: i.bucket })),
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
  const priorityOf = new Map<string, number>();
  for (const it of live) {
    const pls = placements.get(it.key) ?? [];
    if (!pls.length) continue;
    const needDay = pls.map((p) => dayOfInstant(p.plannedAt, cal)).sort()[0] ?? input.rangeStart;
    needDayOf.set(it.key, needDay);
    const firstBatch = Math.min(...pls.map((p) => batchSeq.get(p.batchKey) ?? 9999));
    const minSlot = Math.min(...pls.map((p) => p.slotIndex));
    priorityOf.set(it.key, firstBatch * 1000 + minSlot);
    const wf = rules.workflows[it.workflowKey] ?? DEFAULT_WORKFLOWS.post_std;
    if (!wf) continue;
    // In row mode the SUBJECT is the row, not the post: one task to work, one
    // to approve, and the three members ride its chain. Scheduling them
    // individually would let one row's posts land on three different days and
    // charge one slot each — the very thing a row is not.
    if (rowMode) continue;
    scheduleInput.push({
      key: it.key,
      priority: firstBatch * 1000 + minSlot,
      workflow: wf,
      needDay,
      publishBufferDays: input.publishBufferDays ?? DEFAULTS.publishBufferDays,
      lockedAssignees: pickLocks(input, it.key),
    });
  }

  if (rowMode) {
    for (const [rowKey, members] of Array.from(rowMembers.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const first = members[0];
      const row = rowByKey.get(rowKey);
      if (!first || !row || !members.length) continue;
      const wf = rules.workflows[first.workflowKey] ?? DEFAULT_WORKFLOWS.post_std;
      if (!wf) continue;
      scheduleInput.push({
        key: rowKey,
        priority: Math.min(...members.map((m) => priorityOf.get(m.key) ?? 9_999_000)),
        workflow: wf,
        needDay: row.day,
        publishBufferDays: input.publishBufferDays ?? DEFAULTS.publishBufferDays,
        lockedAssignees: pickLocks(input, rowKey),
        // THREE slots on ONE day — `effortWeightsSameDay`, whose SQL twin is
        // `mos_spread_effort_same_day`. The two must stay in exact agreement:
        // the preview computes this load in JS and the commit's conflict test
        // recomputes it in SQL.
        sameDaySlots: members.length,
      });
    }
  }

  const sched = scheduleProduction(scheduleInput, book, cal, snapshot.today, placementBudget);
  conflicts.push(...sched.conflicts);

  // --------------------------------------------------------------- assemble
  const plannedItems: PlannedItem[] = [];
  const plannedRows: PlannedRow[] = [];
  const reservations: PlannedReservation[] = [];
  for (const it of live) {
    // A row member reads its chain off the ROW; a loose item off itself.
    const st = sched.items.get(it.rowKey ?? it.key);
    const pls = placements.get(it.key) ?? [];
    const needDay = needDayOf.get(it.key) ?? input.rangeStart;
    plannedItems.push({
      key: it.key,
      title: it.title,
      contentTypeKey: it.contentTypeKey,
      bucket: it.bucket,
      projectId: it.projectId,
      projectName: it.projectName,
      workflowKey: it.workflowKey,
      rowKey: it.rowKey,
      rowOrder: it.rowOrder,
      needAt: pls.map((p) => p.plannedAt).sort()[0] ?? `${needDay}T09:00:00.000Z`,
      requiredReadyAt: st?.requiredReadyAt ?? '',
      productionStart: st?.productionStart ?? '',
      priority: priorityOf.get(it.key) ?? 9_999_000,
      // Shared with the row's other members: one sitting, one window, one owner.
      stages: st?.stages ?? [],
      placements: pls,
      slot: it.slot,
    });
    // Reservations in row mode belong to the ROW, written once below. Writing
    // one per member would book the same day three times over.
    if (rowMode) continue;
    // A paid item names the refresh cycle it belongs to. The commit turns this
    // composite key into `mos_task_reservations.cycle_id`, which is the ONLY
    // thing `mos_plan_start_due` can bind a deferred reservation by — see
    // `PlannedReservation.cycleKey`. Emitted for EVERY slot item, round 0
    // included: which of them is deferred is the commit's rule
    // (`cycle_round > 0`), and duplicating that rule here is how the two come
    // apart. A round-0 reservation is bound to its content at commit, and the
    // sweep's `content_id IS NULL` clause skips it anyway.
    const cycleKey = it.slot ? `${it.slot.executionKey}#${it.slot.cycleRound}` : null;
    for (const s of st?.stages ?? []) reservations.push(reservationOf(it.key, null, s, cycleKey));
  }
  plannedItems.sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));

  if (rowMode) {
    for (const row of rowSpecs) {
      const members = rowMembers.get(row.rowKey) ?? [];
      if (!members.length) continue;
      const st = sched.items.get(row.rowKey);
      const slots = members.length;
      const executionKey = `exec:${row.platform}`;
      plannedRows.push({
        rowKey: row.rowKey,
        kind: row.projectId ? 'organic_row' : 'general_row',
        projectId: row.projectId,
        projectName: row.projectName,
        platform: row.platform,
        executionKey,
        batchDay: row.day,
        batchKey: `${executionKey}|${row.day}`,
        itemKeys: members.map((m) => m.key),
        stages: st?.stages ?? [],
        requiredReadyAt: st?.requiredReadyAt ?? '',
        productionStart: st?.productionStart ?? '',
        slotsPerStage: slots,
      });
      // ONE reservation per step for the whole row: one day, every member's
      // slot on it. Built from the stage's own `slotWeights` — which
      // `scheduleProduction` produced with `effortWeightsSameDay(members)` and
      // then actually BOOKED — rather than recomputing the spread here. The two
      // used to be independent derivations of the same number, and independent
      // derivations are how a preview and a commit come to disagree.
      for (const s of st?.stages ?? []) {
        reservations.push(reservationOf(row.rowKey, row.rowKey, s, null));
      }
    }
    plannedRows.sort((a, b) => (a.batchDay < b.batchDay ? -1
      : a.batchDay > b.batchDay ? 1 : a.rowKey < b.rowKey ? -1 : 1));
  }

  // Releases are planned AFTER production, from the placements, and booked
  // against their own `publishing` bucket. They are never allowed to make a
  // campaign infeasible: the creative is finished either way, and a post that
  // goes out late is a late post, not an impossible plan.
  const rel = buildReleases(
    plannedItems, input.kind, rules.publishing ?? DEFAULT_PUBLISHING, book, cal,
  );
  conflicts.push(...rel.conflicts);

  const load = buildLoadCells(book, snapshot, [...sched.touched, ...rel.touched]);
  // `publish_time` joins the refusing kinds deliberately. It is not a staffing
  // problem — the month is perfectly workable — but the plan it would produce
  // publishes two posts at the same second, or at a time the operator never
  // asked for. Committing that is worse than refusing until one number in the
  // month template is fixed.
  const feasible = sched.ok && !conflicts.some(conflictBlocksPlan);

  const starts = plannedItems.map((i) => i.productionStart).filter(Boolean).sort();
  const ends = plannedItems.flatMap((i) => i.stages.map((s) => s.end)).filter(Boolean).sort();

  const result: PlanResult = {
    feasible,
    infeasibleProof: sched.infeasibleProof,
    searchIncomplete: sched.searchIncomplete || conflicts.some((c) => c.kind === 'search_incomplete'),
    searchStats: sched.stats,
    items: plannedItems,
    rows: plannedRows,
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
  const rowMode = Boolean(input.rows?.length);
  // "Shift the whole window forward" is meaningless for a month of rows, and
  // not merely useless: each row carries its OWN day from the template, so
  // moving `rangeStart`/`rangeEnd` changes nothing the row path reads and every
  // probe returns the identical infeasible plan. Thirteen of them is thirteen
  // full re-plans of a 48-post month to learn nothing. The item-cap probe below
  // was already skipped for rows for the same reason; this one was missed.
  // Moving a month means moving a ROW to another slot — a Group F decision, not
  // an engine search.
  if (!rowMode) {
    for (const shift of [1, 2, 3, 4, 5, 7, 10, 14, 21, 28, 35, 45, 60]) {
      const start = addDays(input.rangeStart, shift);
      const end = addDays(start, span);
      const probe = planCampaign(
        { ...input, rangeStart: start, rangeEnd: end }, snapshot, rules, { withAlternatives: false },
      );
      if (probe.feasible) { earliestStart = start; earliestEnd = end; break; }
    }
  }

  let maxItems: number | null = null;
  const total = countRequested(input);
  // "Keep the first N items" is meaningless for a month of rows: a row goes out
  // whole or not at all, so the honest alternative is moving the row, never
  // shortening it. `withItemCap` only trims `projects[].posts`, which the row
  // path ignores — probing it would return the same plan every time.
  if (total > 1 && !rowMode) {
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
  if (input.rows?.length) {
    return input.rows.reduce((a, r) => a + Math.max(0, Math.floor(r.posts)), 0);
  }
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

/**
 * One reservation from one PLACED stage — the ONLY place a reservation is
 * built, for both the loose-item and the row path.
 *
 * Everything comes off `PlannedStage.slotWeights`, which is what
 * `scheduleProduction` actually charged to the capacity book. Nothing is
 * re-derived from `workingDays`: a row's stage reports the step's 2-day
 * estimate while occupying ONE day with three slots, so re-deriving there is
 * how the preview's load and the reservation's weight come apart.
 */
function reservationOf(
  subjectKey: string, rowKey: string | null, s: PlannedStage,
  cycleKey: string | null,
): PlannedReservation {
  const weights = s.slotWeights.length ? s.slotWeights : [0];
  return {
    itemKey: subjectKey,
    rowKey,
    cycleKey,
    stepKey: s.stepKey,
    roleKey: s.roleKey,
    bucket: s.bucket,
    assigneeUserId: s.assigneeUserId,
    plannedStart: s.start,
    plannedEnd: s.end,
    weight: weights.reduce((a, b) => a + b, 0),
    // Named, never inferred — see `PlannedReservation.spread`. A row is one
    // sitting on one day; everything else is one slot per working day.
    spread: rowKey ? 'same_day' : 'per_day',
    weights,
  };
}

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
  const perProject = new Map<string | null, { projectId: string | null; projectName?: string; items: number }>();
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
      // A row member costs ONE slot per step whatever the step's day-estimate
      // says — the row is worked in one sitting (see `ScheduleItem.sameDaySlots`).
      slotDays[b] = (slotDays[b] ?? 0) + (i.rowKey ? 1 : st.workingDays);
    }
  }

  const rowKeys = new Set<string>();
  const generalRowKeys = new Set<string>();
  let rowPosts = 0;
  for (const i of items) {
    if (!i.rowKey) continue;
    rowKeys.add(i.rowKey);
    if (i.projectId === null) generalRowKeys.add(i.rowKey);
    rowPosts += 1;
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
    releases: { total: 0, automatic: 0, manual: 0, feed: 0, story: 0 },
    rows: rowKeys.size
      ? { total: rowKeys.size, general: generalRowKeys.size, posts: rowPosts }
      : undefined,
    creatives: input.kind === 'paid' ? creativeTotals(cycles) : undefined,
  };
}

function empty(snapshot: WorkloadSnapshot, conflicts: PlanConflict[]): PlanResult {
  return {
    feasible: false,
    infeasibleProof: null,
    searchIncomplete: false,
    searchStats: { expansions: 0, backtracks: 0, budget: 0 },
    items: [], rows: [], batches: [], releases: [], reservations: [], cycles: [], load: [],
    conflicts,
    totals: {
      items: 0, posts: 0, videos: 0, placements: 0, batches: 0,
      slotDaysByBucket: {}, perProject: [], perPlatform: [],
      releases: { total: 0, automatic: 0, manual: 0, feed: 0, story: 0 },
    },
    alternatives: { earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: null },
    productionWindow: { start: null, end: null },
    snapshotHash: snapshot.hash,
    engineVersion: ENGINE_VERSION,
  };
}

export { addWorkingDays };
export { slotCapacity } from './distribute';
