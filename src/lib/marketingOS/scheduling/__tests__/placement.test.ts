/**
 * Earliest-first placement — 2026-09-22, the operator's rule: «tasks should be
 * booked as early as possible, not as late as possible».
 *
 * Two things are pinned here.
 *
 *  1. It changes DATES, never feasibility. A month is still FOUND by the
 *     backward search; the forward pass only moves stages into capacity nobody
 *     is using. So every scenario is compiled under both placements and must
 *     agree on what fits, while every stage under `earliest` starts no later
 *     than under `latest` — and something actually starts earlier.
 *
 *  2. Inside a month the forward pass runs ACROSS the four plans (seeded), not
 *     inside each plan's own search. The first attempt did the latter, and the
 *     organic plan filled the early days before the paid plans were placed:
 *     the 16-Sep catch-up month lost its 20-Sep batch and six tests went red.
 *     The catch-up scenarios are therefore compiled here under both rules.
 */
import { describe, expect, it } from 'vitest';
import {
  compileMonth, MONTH_TEMPLATE_DEFAULTS, type CompiledMonth, type MonthTemplate,
} from '../../../../../api/_lib/marketing/planning/monthCompiler';
import { addWorkingDays, daysBetween, nextWorkingDay } from '../calendar';
import { planCampaign, planSeed, DEFAULT_RULES, type RuleSet } from '../plan';
import { DEFAULT_PUBLISHING } from '../releases';
import type { PlanInput, PlanResult, PlannedStage, WorkloadSnapshot } from '../types';
import { CAL, M2, MM, PROJECT_A, PROJECT_B, PROJECT_C, snapshot } from './fixtures';

const EARLIEST: RuleSet = {
  ...DEFAULT_RULES,
  publishing: { ...DEFAULT_PUBLISHING, automatable: { instagram: true } },
  placement: 'earliest',
};
const LATEST: RuleSet = { ...EARLIEST, placement: 'latest' };
const PROJECTS = [PROJECT_A, PROJECT_B, PROJECT_C];
const T = MONTH_TEMPLATE_DEFAULTS;

/** September planned from the 20th, carrying October — the shape of the live re-plan. */
const STRETCH: MonthTemplate = {
  ...T,
  monthStarts: {
    '2026-09': {
      organicFrom: '2026-09-22',
      paidFrom: '2026-09-22',
      adsLiveWhenReady: true,
      through: '2026-10',
    },
  },
};

interface Booked { subject: string; needDay: string; stage: PlannedStage }

/** Every booked stage of a plan, by subject — the ROW for row members, the item otherwise. */
function booked(plan: PlanResult): Map<string, Booked> {
  const out = new Map<string, Booked>();
  for (const row of plan.rows) {
    for (const s of row.stages) out.set(`${row.rowKey}|${s.stepKey}`, { subject: row.rowKey, needDay: row.batchDay, stage: s });
  }
  for (const it of plan.items) {
    if (it.rowKey) continue;
    for (const s of it.stages) out.set(`${it.key}|${s.stepKey}`, { subject: it.key, needDay: it.needAt.slice(0, 10), stage: s });
  }
  return out;
}

function bookedMonth(m: CompiledMonth): Map<string, Booked> {
  const out = new Map<string, Booked>();
  m.plans.forEach((p, i) => { for (const [k, v] of booked(p)) out.set(`${i}:${k}`, v); });
  return out;
}

/** The assertions every earliest-vs-latest pair must satisfy. Returns how many stages moved earlier. */
function expectEarlierNeverLooser(
  early: Map<string, Booked>, late: Map<string, Booked>, today: string, leadWorkingDays: number,
): number {
  expect(Array.from(early.keys()).sort()).toEqual(Array.from(late.keys()).sort());
  let earlier = 0;
  for (const [k, e] of early) {
    const l = late.get(k)!;
    // Never later than the backward placement, never past the deadline it was found under.
    expect(daysBetween(e.stage.start, l.stage.start), `${k} starts later under earliest-first`).toBeGreaterThanOrEqual(0);
    expect(e.stage.deadline).toBe(l.stage.deadline);
    expect(daysBetween(e.stage.end, e.stage.deadline), `${k} ends after its deadline`).toBeGreaterThanOrEqual(0);
    // Never before the production window: lead working days before the need day, never before today.
    const floorBase = addWorkingDays(e.needDay, -leadWorkingDays, CAL);
    const floor = nextWorkingDay(daysBetween(today, floorBase) > 0 ? floorBase : today, CAL);
    expect(daysBetween(floor, e.stage.start), `${k} starts before its window (${floor})`).toBeGreaterThanOrEqual(0);
    if (daysBetween(e.stage.start, l.stage.start) > 0) earlier += 1;
  }
  // Chains stay chains: a predecessor ends no later than its successor starts.
  const bySubject = new Map<string, PlannedStage[]>();
  for (const b of early.values()) {
    const arr = bySubject.get(b.subject) ?? [];
    arr.push(b.stage);
    bySubject.set(b.subject, arr);
  }
  for (const [subject, stages] of bySubject) {
    for (let i = 0; i + 1 < stages.length; i += 1) {
      expect(
        daysBetween(stages[i]!.end, stages[i + 1]!.start),
        `${subject}: ${stages[i]!.stepKey} ends after ${stages[i + 1]!.stepKey} starts`,
      ).toBeGreaterThanOrEqual(0);
    }
  }
  return earlier;
}

function expectSameFeasibility(a: CompiledMonth, b: CompiledMonth): void {
  expect(a.summary.feasible).toBe(b.summary.feasible);
  expect(a.summary.unscheduled).toEqual(b.summary.unscheduled);
  expect(a.plans.map((p) => p.feasible)).toEqual(b.plans.map((p) => p.feasible));
  expect(a.geometry.paidBatchDays).toEqual(b.geometry.paidBatchDays);
  expect(a.geometry.skippedPaidBatchDays).toEqual(b.geometry.skippedPaidBatchDays);
}

/* ------------------------------------------------------------------ */

describe('earliest-first placement across a month', () => {
  const TODAY = '2026-09-15';
  const compileOct = (rules: RuleSet) => compileMonth({
    month: '2026-10', template: T, projects: PROJECTS, snapshot: snapshot(TODAY), rules,
  });

  it('books every stage no later than latest-first would, and most of them earlier', () => {
    const early = compileOct(EARLIEST);
    const late = compileOct(LATEST);
    expect(early.summary.feasible).toBe(true);
    expectSameFeasibility(early, late);

    const moved = expectEarlierNeverLooser(bookedMonth(early), bookedMonth(late), TODAY, T.leadTimeWorkingDays);
    expect(moved).toBeGreaterThan(0);
    // Under latest-first the work hugs the deadlines; under earliest-first it
    // does not — a real change, not a tie on every stage.
    expect(moved / bookedMonth(early).size).toBeGreaterThan(0.5);
  });

  it('never books anyone over capacity while moving work earlier', () => {
    const early = compileOct(EARLIEST);
    expect(early.summary.load.some((l) => l.over)).toBe(false);
    for (const plan of early.plans) {
      for (const cell of plan.load) {
        expect(cell.existing + cell.proposed, `${cell.userId} ${cell.day} ${cell.bucket}`)
          .toBeLessThanOrEqual(cell.capacity + 1e-9);
      }
    }
    // The month's own load is the sum of what each plan proposed — no cell is
    // counted twice because a plan's ledger held the other plans' cells.
    const proposed = early.plans.reduce((a, p) => a + p.load.reduce((b, c) => b + c.proposed, 0), 0);
    const late = compileOct(LATEST);
    const proposedLate = late.plans.reduce((a, p) => a + p.load.reduce((b, c) => b + c.proposed, 0), 0);
    expect(proposed).toBeCloseTo(proposedLate, 6);
  });

  it('is deterministic — the compile the page shows is the compile the confirm commits', () => {
    const a = compileOct(EARLIEST);
    const b = compileOct(EARLIEST);
    expect(Array.from(bookedMonth(a).entries())).toEqual(Array.from(bookedMonth(b).entries()));
  });

  it('reports the search effort of the pass that searched, not the seeded re-placement', () => {
    const early = compileOct(EARLIEST);
    const late = compileOct(LATEST);
    expect(early.plans.map((p) => p.searchStats)).toEqual(late.plans.map((p) => p.searchStats));
    expect(early.plans.every((p) => p.searchStats.expansions > 0)).toBe(true);
  });
});

describe('the catch-up months that the first attempt broke', () => {
  const ONE_DESIGNER = (day: string): WorkloadSnapshot => {
    const base = snapshot(day);
    return { ...base, people: base.people.filter((p) => p.userId !== M2) };
  };

  it('September from the 20th, carrying October: two batches under both rules', () => {
    const args = { month: '2026-09', template: STRETCH, projects: PROJECTS, startFrom: '2026-09-20' as const };
    const early = compileMonth({ ...args, snapshot: snapshot('2026-09-20'), rules: EARLIEST });
    const late = compileMonth({ ...args, snapshot: snapshot('2026-09-20'), rules: LATEST });
    // Whatever the month says about itself — this one is refused under BOTH
    // rules (its 20-Sep batch cannot be made from the 20th) — it says the same
    // thing under both, and names the same unplaced work.
    expectSameFeasibility(early, late);
    expect(early.summary.paidBatchesRemaining).toBe(late.summary.paidBatchesRemaining);
    expectEarlierNeverLooser(bookedMonth(early), bookedMonth(late), '2026-09-20', STRETCH.leadTimeWorkingDays);
  });

  it('September from the 16th with one designer: the 20-Sep batch is skipped the same way', () => {
    const args = { month: '2026-09', template: T, projects: PROJECTS, startFrom: '2026-09-16' as const };
    const early = compileMonth({ ...args, snapshot: ONE_DESIGNER('2026-09-16'), rules: EARLIEST });
    const late = compileMonth({ ...args, snapshot: ONE_DESIGNER('2026-09-16'), rules: LATEST });
    expectSameFeasibility(early, late);
    expect(early.summary.feasible).toBe(true);
    expect(early.geometry.paidBatchDays).toEqual(['2026-09-27']);
    expectEarlierNeverLooser(bookedMonth(early), bookedMonth(late), '2026-09-16', T.leadTimeWorkingDays);
  });

  it('September from the 16th with two designers: both batches stay, and start earlier', () => {
    const args = { month: '2026-09', template: T, projects: PROJECTS, startFrom: '2026-09-16' as const };
    const early = compileMonth({ ...args, snapshot: snapshot('2026-09-16'), rules: EARLIEST });
    const late = compileMonth({ ...args, snapshot: snapshot('2026-09-16'), rules: LATEST });
    expectSameFeasibility(early, late);
    expect(early.summary.feasible).toBe(true);
    expect(early.geometry.paidBatchDays).toEqual(['2026-09-20', '2026-09-27']);
    const moved = expectEarlierNeverLooser(bookedMonth(early), bookedMonth(late), '2026-09-16', T.leadTimeWorkingDays);
    expect(moved).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */

const IG = (perDay: number) => [{ platform: 'instagram', perDay, weekdays: null }];

const organic = (over: Partial<PlanInput> = {}): PlanInput => ({
  campaignId: 'camp-place',
  kind: 'organic',
  projects: [PROJECT_A, PROJECT_B, PROJECT_C].map((p) => ({ ...p, posts: 2, videos: 0 })),
  platforms: ['instagram'],
  rangeStart: '2026-10-18',
  rangeEnd: '2026-10-21',
  frequency: IG(3),
  crossPost: false,
  publishBufferDays: 1,
  productionLeadWorkingDays: 10,
  ...over,
});

describe('a single plan (the wizard path)', () => {
  const TODAY = '2026-10-01';

  it('places forward from the production window under earliest-first', () => {
    const early = planCampaign(organic(), snapshot(TODAY), EARLIEST, { withAlternatives: false });
    const late = planCampaign(organic(), snapshot(TODAY), LATEST, { withAlternatives: false });
    expect(early.feasible).toBe(true);
    expect(late.feasible).toBe(true);
    const moved = expectEarlierNeverLooser(booked(early), booked(late), TODAY, 10);
    expect(moved).toBeGreaterThan(0);
    for (const cell of early.load) {
      expect(cell.existing + cell.proposed).toBeLessThanOrEqual(cell.capacity + 1e-9);
    }
  });

  it('a seeded re-placement from the backward plan lands exactly where the plain compile does', () => {
    const late = planCampaign(organic(), snapshot(TODAY), LATEST, { withAlternatives: false });
    const seeded = planCampaign(organic(), snapshot(TODAY), EARLIEST, {
      withAlternatives: false, seed: planSeed(late),
    });
    const plain = planCampaign(organic(), snapshot(TODAY), EARLIEST, { withAlternatives: false });
    expect(Array.from(booked(seeded).entries())).toEqual(Array.from(booked(plain).entries()));
    // The seed is booked, not searched.
    expect(seeded.searchStats.expansions).toBe(0);
    expect(plain.searchStats.expansions).toBeGreaterThan(0);
  });

  it('refuses a seed that is missing a stage — loudly, as an engine invariant', () => {
    const late = planCampaign(organic(), snapshot(TODAY), LATEST, { withAlternatives: false });
    const seed = planSeed(late);
    const first = Array.from(seed.keys())[0]!;
    seed.delete(first);
    expect(() => planCampaign(organic(), snapshot(TODAY), EARLIEST, { withAlternatives: false, seed }))
      .toThrow(/seed has no stage/);
  });

  it('refuses a seed that does not fit the person it names', () => {
    const late = planCampaign(organic(), snapshot(TODAY), LATEST, { withAlternatives: false });
    const seed = planSeed(late);
    const first = Array.from(seed.keys())[0]!;
    // The manager has no post capacity at all.
    seed.set(first, { ...seed.get(first)!, assigneeUserId: MM });
    expect(() => planCampaign(organic(), snapshot(TODAY), EARLIEST, { withAlternatives: false, seed }))
      .toThrow(/does not fit/);
  });
});
