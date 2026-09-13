import { describe, it, expect } from 'vitest';
import { planCampaign, DEFAULT_RULES } from '../plan';
import { computeDeadlines } from '../schedule';
import { POST_WORKFLOW } from '../defaults';
import { daysBetween } from '../calendar';
import type { PlanInput, PlannedItem } from '../types';
import {
  CAL, LEDGER_221, LEDGER_221_TIGHT, M1, M2, W, MM,
  PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D, PROJECT_E, snapshot,
} from './fixtures';

const IG = (perDay: number) => [{ platform: 'instagram', perDay, weekdays: null }];

const organic = (over: Partial<PlanInput> = {}): PlanInput => ({
  campaignId: 'camp-1',
  kind: 'organic',
  projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
  platforms: ['instagram'],
  rangeStart: '2026-10-11',
  rangeEnd: '2026-10-12',
  frequency: IG(3),
  crossPost: false,
  publishBufferDays: 1,
  ...over,
});

const stageOf = (item: PlannedItem, step: string) => item.stages.find((s) => s.stepKey === step)!;
const byKey = (items: PlannedItem[], k: string) => items.find((i) => i.key === k)!;

/* ------------------------------------------------------------------ */

describe('backward deadlines', () => {
  it('walks the post path back from the required-ready day, skipping Friday', () => {
    const prod = POST_WORKFLOW.steps.filter((s) => !s.afterReady);
    const dl = computeDeadlines(prod, '2026-10-10', CAL);
    expect(Object.fromEntries(prod.map((s, i) => [s.key, dl[i]]))).toEqual({
      writing: '2026-10-04',
      writing_review: '2026-10-05',
      design: '2026-10-07',
      design_writer_review: '2026-10-08', // Oct 9 is Friday
      design_review: '2026-10-10',
    });
  });
});

describe('organic distribution — the operator\'s own example', () => {
  it('5 projects × 3 posts, 3/day → A1 B1 C1 · D1 E1 A2 · B2 C2 D2 · …', () => {
    const res = planCampaign(organic({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D, PROJECT_E].map((p) => ({ ...p, posts: 3, videos: 0 })),
      rangeStart: '2026-11-01',
      rangeEnd: '2026-11-05',
    }), snapshot('2026-10-01'), DEFAULT_RULES);

    expect(res.feasible).toBe(true);
    const byDay = new Map<string, string[]>();
    for (const it of res.items) {
      const p = it.placements[0];
      const arr = byDay.get(p.day) ?? [];
      arr[p.slotIndex] = it.projectName!;
      byDay.set(p.day, arr);
    }
    expect(byDay.get('2026-11-01')).toEqual(['A', 'B', 'C']);
    expect(byDay.get('2026-11-02')).toEqual(['D', 'E', 'A']);
    expect(byDay.get('2026-11-03')).toEqual(['B', 'C', 'D']);
    expect(byDay.get('2026-11-04')).toEqual(['E', 'A', 'B']);
    expect(byDay.get('2026-11-05')).toEqual(['C', 'D', 'E']);
  });

  it('never puts the same project twice in a day, back to back, or twice in a grid row', () => {
    const res = planCampaign(organic({
      projects: [
        { ...PROJECT_A, posts: 5, videos: 0 },
        { ...PROJECT_B, posts: 3, videos: 0 },
        { ...PROJECT_C, posts: 1, videos: 0 },
      ],
      rangeStart: '2026-11-01',
      rangeEnd: '2026-11-09',
    }), snapshot('2026-10-01'), DEFAULT_RULES);

    const seq = res.items
      .flatMap((i) => i.placements.map((p) => ({ p, project: i.projectId })))
      .sort((a, b) => (a.p.day < b.p.day ? -1 : a.p.day > b.p.day ? 1 : a.p.slotIndex - b.p.slotIndex));

    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i].project).not.toBe(seq[i - 1].project); // no consecutive
    }
    const perDay = new Map<string, Set<string>>();
    for (const s of seq) {
      const set = perDay.get(s.p.day) ?? new Set();
      expect(set.has(s.project)).toBe(false); // not twice a day
      set.add(s.project);
      perDay.set(s.p.day, set);
    }
    const rows = new Map<number, Set<string>>();
    for (const s of seq) {
      const r = s.p.gridRow!;
      const set = rows.get(r) ?? new Set();
      expect(set.has(s.project)).toBe(false); // distinct per grid row
      set.add(s.project);
      rows.set(r, set);
    }
  });
});

describe('§22.1 — publishing batches drive production', () => {
  const input = organic({
    projects: [PROJECT_A, PROJECT_B, PROJECT_C].map((p) => ({ ...p, posts: 2, videos: 0 })),
    rangeStart: '2026-10-11',
    rangeEnd: '2026-10-12',
    frequency: IG(3),
  });

  it('places batch 1 on Oct 11 and batch 2 on Oct 12, every stage inside its deadline', () => {
    const res = planCampaign(input, snapshot('2026-10-01', LEDGER_221), DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    expect(res.batches.map((b) => b.day)).toEqual(['2026-10-11', '2026-10-12']);

    for (const it of res.items) {
      for (const st of it.stages) {
        if (st.deadline && !['scheduling', 'publish_check'].includes(st.stepKey)) {
          expect(daysBetween(st.end, st.deadline)).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // Batch 1's whole chain finishes by its required-ready day.
    const b1 = res.batches[0].itemKeys.map((k) => byKey(res.items, k));
    for (const it of b1) {
      expect(it.requiredReadyAt).toBe('2026-10-10');
      expect(daysBetween(stageOf(it, 'design_review').end, '2026-10-10')).toBeGreaterThanOrEqual(0);
    }
  });

  it('VARIANT: with M2 also busy on Oct 7, all six still fit without moving a publish date', () => {
    const res = planCampaign(input, snapshot('2026-10-01', LEDGER_221_TIGHT), DEFAULT_RULES);

    expect(res.feasible).toBe(true);
    expect(res.infeasibleProof).toBeNull();
    expect(res.searchIncomplete).toBe(false);
    // Nothing moved: both batches still publish on the requested days.
    expect(res.batches.map((b) => b.day)).toEqual(['2026-10-11', '2026-10-12']);
    expect(res.items).toHaveLength(6);

    // Every design lands on a montage person inside its deadline.
    for (const it of res.items) {
      const d = stageOf(it, 'design');
      expect([M1, M2]).toContain(d.assigneeUserId);
      expect(daysBetween(d.end, d.deadline)).toBeGreaterThanOrEqual(0);
    }
    // Batch 2 was pulled EARLIER into its slack, never later.
    const batch2 = res.batches[1].itemKeys.map((k) => byKey(res.items, k));
    for (const it of batch2) {
      expect(daysBetween(stageOf(it, 'design').end, '2026-10-08')).toBeGreaterThanOrEqual(0);
    }
    // Capacity was respected everywhere.
    for (const cell of res.load) {
      expect(cell.existing + cell.proposed).toBeLessThanOrEqual(cell.capacity + 1e-9);
    }
  });
});

describe('proving infeasibility vs failing to find a schedule', () => {
  it('proves a time bound when the range is shorter than production itself', () => {
    const res = planCampaign(organic({
      projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
      rangeStart: '2026-10-02',
      rangeEnd: '2026-10-02',
    }), snapshot('2026-10-01'), DEFAULT_RULES);
    expect(res.feasible).toBe(false);
    expect(res.infeasibleProof).toBe('time_bound');
    expect(res.searchIncomplete).toBe(false);
  });

  it('proves a capacity bound when no rearrangement could ever fit', () => {
    // 30 posts needing 2 design-days each = 60 designer slot-days, against two
    // designers × 4/day over ~9 working days = 72 … but the writer's approvals
    // and the manager's 20/day are ample, so squeeze the designers instead.
    const thin = [
      { userId: M1, roles: ['montage' as const], caps: { post: 1 }, leaves: [] },
      { userId: W, roles: ['writer' as const], caps: { post: 10, approvals: 20 }, leaves: [] },
      { userId: MM, roles: ['marketing_manager' as const], caps: { approvals: 20 }, leaves: [] },
    ];
    const res = planCampaign(organic({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C].map((p) => ({ ...p, posts: 10, videos: 0 })),
      rangeStart: '2026-10-11',
      rangeEnd: '2026-10-20',
      frequency: IG(3),
    }), snapshot('2026-10-01', [], thin), DEFAULT_RULES);
    expect(res.feasible).toBe(false);
    expect(res.infeasibleProof).toBe('capacity_bound');
    expect(res.conflicts.some((c) => /provably impossible/.test(c.messageEn))).toBe(true);
  });

  it('never claims impossibility when the search merely ran out of budget', () => {
    const res = planCampaign(organic({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D].map((p) => ({ ...p, posts: 6, videos: 0 })),
      rangeStart: '2026-10-11',
      rangeEnd: '2026-10-18',
      frequency: IG(3),
    }), snapshot('2026-10-01'), { ...DEFAULT_RULES, searchBudget: 5 });
    if (!res.feasible) {
      expect(res.infeasibleProof).toBeNull();
      expect(res.searchIncomplete).toBe(true);
      expect(res.conflicts.some((c) => /NOT proof/.test(c.messageEn))).toBe(true);
    }
  });

  it('offers the earliest feasible range instead of a bare refusal', () => {
    const res = planCampaign(organic({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C].map((p) => ({ ...p, posts: 2, videos: 0 })),
      rangeStart: '2026-10-03',
      rangeEnd: '2026-10-04',
      frequency: IG(3),
    }), snapshot('2026-10-01'), DEFAULT_RULES);
    expect(res.feasible).toBe(false);
    expect(res.alternatives.earliestFeasibleStart).toBeTruthy();
    expect(daysBetween('2026-10-03', res.alternatives.earliestFeasibleStart!)).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('same input + snapshot → byte-identical plan', () => {
    const input = organic({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C].map((p) => ({ ...p, posts: 2, videos: 0 })),
      rangeStart: '2026-10-11', rangeEnd: '2026-10-12',
    });
    const snap = snapshot('2026-10-01', LEDGER_221);
    const a = planCampaign(input, snap, DEFAULT_RULES);
    const b = planCampaign(input, snap, DEFAULT_RULES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('reservations mirror the plan exactly', () => {
  it('one reservation per stage, with the same person, window and weight', () => {
    const res = planCampaign(organic({
      projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
      rangeStart: '2026-10-20', rangeEnd: '2026-10-20',
    }), snapshot('2026-10-01'), DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    const stages = res.items[0].stages;
    expect(res.reservations).toHaveLength(stages.length);
    for (const st of stages) {
      const r = res.reservations.find((x) => x.stepKey === st.stepKey)!;
      expect(r.assigneeUserId).toBe(st.assigneeUserId);
      expect(r.plannedStart).toBe(st.start);
      expect(r.plannedEnd).toBe(st.end);
    }
  });
});
