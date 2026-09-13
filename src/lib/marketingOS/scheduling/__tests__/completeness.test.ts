/**
 * The property the second review demanded: **a search limit must never be
 * presented as proof of infeasibility.**
 *
 * We check the stronger form — on small instances the engine must find a
 * schedule whenever an exhaustive brute force can. If it ever cannot, the
 * result must at least be honest (`infeasibleProof: null`).
 */
import { describe, it, expect } from 'vitest';
import { planCampaign, type RuleSet } from '../plan';
import { computeDeadlines } from '../schedule';
import { effortWeights } from '../ledger';
import { addWorkingDays, daysBetween, isWorkingDay, workingWindowEndingAt, DEFAULT_CALENDAR } from '../calendar';
import type { PlanInput, PersonCapacity, StepSpec, WorkflowSpec } from '../types';
import { snapshot } from './fixtures';

const CAL = DEFAULT_CALENDAR;

/** A two-stage workflow keeps the brute-force space enumerable. */
const MINI: WorkflowSpec = {
  workflowKey: 'mini',
  bucket: 'post',
  steps: [
    { key: 'writing', roleKey: 'writer', isApproval: false, workingDays: 1, afterReady: false, labelAr: 'كتابة', labelEn: 'Writing' },
    { key: 'design', roleKey: 'montage', isApproval: false, workingDays: 1, afterReady: false, labelAr: 'تصميم', labelEn: 'Design' },
  ],
};

const RULES: RuleSet = {
  workflows: { mini: MINI },
  contentTypeWorkflow: { post: 'mini' },
  contentTypeBucket: { post: 'post' },
};

/** Exhaustive search over (person, end-day) for every stage of every item. */
function bruteForceFeasible(
  items: Array<{ key: string; needDay: string }>,
  people: PersonCapacity[],
  caps: Map<string, number>,
  today: string,
): boolean {
  const stages: Array<{ item: string; step: StepSpec; deadline: string }> = [];
  for (const it of items) {
    const ready = addWorkingDays(it.needDay, -1, CAL);
    const dl = computeDeadlines(MINI.steps, ready, CAL);
    MINI.steps.forEach((s, i) => stages.push({ item: it.key, step: s, deadline: dl[i] }));
  }
  const used = new Map<string, number>();
  const key = (u: string, d: string) => `${u}|${d}`;

  const rec = (i: number, ends: Map<string, string>): boolean => {
    if (i >= stages.length) return true;
    const st = stages[i];
    const stepIdx = MINI.steps.findIndex((s) => s.key === st.step.key);
    const prevEnd = stepIdx > 0 ? ends.get(`${st.item}|${MINI.steps[stepIdx - 1].key}`) : undefined;
    const eligible = people.filter((p) => p.roles.includes(st.step.roleKey) && (p.caps.post ?? 0) > 0);
    for (const p of eligible) {
      let end = st.deadline;
      for (let g = 0; g < 60; g += 1) {
        if (daysBetween(today, end) < 0) break;
        if (isWorkingDay(end, CAL)) {
          const win = workingWindowEndingAt(end, effortWeights(st.step.workingDays).length, CAL);
          const afterPrev = !prevEnd || daysBetween(prevEnd, win[0]) > 0;
          const cap = caps.get(p.userId) ?? 0;
          const fits = win.every((d) => (used.get(key(p.userId, d)) ?? 0) + 1 <= cap);
          if (afterPrev && fits) {
            for (const d of win) used.set(key(p.userId, d), (used.get(key(p.userId, d)) ?? 0) + 1);
            ends.set(`${st.item}|${st.step.key}`, win[win.length - 1]);
            if (rec(i + 1, ends)) return true;
            ends.delete(`${st.item}|${st.step.key}`);
            for (const d of win) used.set(key(p.userId, d), (used.get(key(p.userId, d)) ?? 0) - 1);
          }
        }
        end = addWorkingDays(end, -1, CAL);
      }
    }
    return false;
  };
  return rec(0, new Map());
}

/** Deterministic pseudo-random so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('placement completeness', () => {
  it('finds a schedule on every small instance a brute force can solve', () => {
    let checked = 0;
    let agreed = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = rng(seed);
      const writerCap = 1 + Math.floor(r() * 2);   // 1..2
      const montageCap = 1 + Math.floor(r() * 2);  // 1..2
      const itemCount = 1 + Math.floor(r() * 4);   // 1..4
      const spanDays = 1 + Math.floor(r() * 3);    // 1..3 publishing days

      const people: PersonCapacity[] = [
        { userId: 'w', roles: ['writer'], caps: { post: writerCap }, leaves: [] },
        { userId: 'm', roles: ['montage'], caps: { post: montageCap }, leaves: [] },
      ];
      const caps = new Map([['w', writerCap], ['m', montageCap]]);

      const rangeStart = '2026-10-11';
      const rangeEnd = addWorkingDays(rangeStart, spanDays - 1, CAL);
      const input: PlanInput = {
        campaignId: null,
        kind: 'organic',
        projects: [{ projectId: 'p1', projectName: 'P1', posts: itemCount, videos: 0 }],
        platforms: ['x'], // permissive platform: no same-project rules in the way
        rangeStart,
        rangeEnd,
        frequency: [{ platform: 'x', perDay: Math.max(1, Math.ceil(itemCount / spanDays)), weekdays: null }],
        crossPost: false,
        publishBufferDays: 1,
      };

      const res = planCampaign(input, snapshot('2026-10-01', [], people), RULES, { withAlternatives: false });

      // Rebuild the same item→day mapping the engine used, for the brute force.
      const items = res.items.map((i) => ({ key: i.key, needDay: i.placements[0]?.day ?? rangeStart }));
      if (!items.length) continue;
      const brute = bruteForceFeasible(items, people, caps, '2026-10-01');
      checked += 1;
      if (brute) {
        expect(
          res.feasible,
          `seed ${seed}: brute force found a schedule but the engine did not (proof=${res.infeasibleProof})`,
        ).toBe(true);
        agreed += 1;
      } else if (!res.feasible) {
        // Never claim proof when we merely failed to find one.
        expect(['capacity_bound', 'time_bound', null]).toContain(res.infeasibleProof);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(agreed).toBeGreaterThan(0);
  });

  it('a proved capacity bound is always genuinely unsatisfiable', () => {
    // One designer at 1/day cannot do 4 designs due the same day.
    const people: PersonCapacity[] = [
      { userId: 'w', roles: ['writer'], caps: { post: 10 }, leaves: [] },
      { userId: 'm', roles: ['montage'], caps: { post: 1 }, leaves: [] },
    ];
    const input: PlanInput = {
      campaignId: null,
      kind: 'organic',
      projects: [{ projectId: 'p1', projectName: 'P1', posts: 8, videos: 0 }],
      platforms: ['x'],
      rangeStart: '2026-10-05',
      rangeEnd: '2026-10-05',
      frequency: [{ platform: 'x', perDay: 8, weekdays: null }],
      crossPost: false,
      publishBufferDays: 1,
    };
    const res = planCampaign(input, snapshot('2026-10-01', [], people), RULES, { withAlternatives: false });
    expect(res.feasible).toBe(false);
    expect(res.infeasibleProof).not.toBeNull();
    const items = res.items.map((i) => ({ key: i.key, needDay: '2026-10-05' }));
    expect(bruteForceFeasible(items, people, new Map([['w', 10], ['m', 1]]), '2026-10-01')).toBe(false);
  });
});
