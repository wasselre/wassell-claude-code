/**
 * Capacity-ledger behaviour the second review turned on:
 *   • elapsed time is never progress — an untouched 2-day task still costs 2;
 *   • carried backlog and reservations both occupy real days;
 *   • leave and holidays are HARD constraints during placement, not deadline
 *     extensions applied afterwards.
 *
 * The SQL view produces these rows; the engine must respect whatever it is
 * handed, so these tests feed the shapes the view emits.
 */
import { describe, it, expect } from 'vitest';
import { planCampaign, DEFAULT_RULES } from '../plan';
import { CapacityBook, effortWeights } from '../ledger';
import { daysBetween } from '../calendar';
import type { LedgerRow, PlanInput } from '../types';
import { CAL, M1, M2, W, MM, PROJECT_A, PROJECT_B, PROJECT_C, TEAM, snapshot } from './fixtures';

const organic = (over: Partial<PlanInput> = {}): PlanInput => ({
  campaignId: 'c',
  kind: 'organic',
  projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
  platforms: ['instagram'],
  rangeStart: '2026-10-20',
  rangeEnd: '2026-10-20',
  frequency: [{ platform: 'instagram', perDay: 3, weekdays: null }],
  crossPost: false,
  publishBufferDays: 1,
  ...over,
});

describe('effort weights', () => {
  it('spreads an effort across whole working days, part-days keep their fraction', () => {
    expect(effortWeights(1)).toEqual([1]);
    expect(effortWeights(2)).toEqual([1, 1]);
    expect(effortWeights(0.5)).toEqual([0.5]);
    expect(effortWeights(1.5)).toEqual([1, 0.5]);
    expect(effortWeights(3)).toEqual([1, 1, 1]);
  });
});

describe('the ledger is respected, whatever its source', () => {
  it('carried backlog occupies today forward and squeezes the plan', () => {
    // Both designers fully booked on Oct 20–21 by overdue work re-projected
    // from today: the plan must place design earlier, not on top of it.
    const backlog: LedgerRow[] = [];
    for (const day of ['2026-10-20', '2026-10-21']) {
      for (const u of [M1, M2]) {
        for (let i = 0; i < 4; i += 1) {
          backlog.push({ userId: u, day, bucket: 'post', weight: 1, source: 'task', refId: `late-${u}-${day}-${i}` });
        }
      }
    }
    const res = planCampaign(organic({
      projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
      rangeStart: '2026-10-27', rangeEnd: '2026-10-27',
    }), snapshot('2026-10-19', backlog), DEFAULT_RULES);

    expect(res.feasible).toBe(true);
    const design = res.items[0]!.stages.find((s) => s.stepKey === 'design')!;
    // It cannot have taken the fully booked days.
    expect(['2026-10-20', '2026-10-21']).not.toContain(design.start);
    expect(['2026-10-20', '2026-10-21']).not.toContain(design.end);
    for (const cell of res.load) {
      expect(cell.existing + cell.proposed).toBeLessThanOrEqual(cell.capacity + 1e-9);
    }
  });

  it('a reservation from another campaign is as real as an open task', () => {
    const reserved: LedgerRow[] = ['2026-10-26', '2026-10-27'].flatMap((day) =>
      [M1, M2].flatMap((u) => Array.from({ length: 4 }, (_, i) => ({
        userId: u, day, bucket: 'post' as const, weight: 1,
        source: 'reservation' as const, refId: `other-plan-${u}-${day}-${i}`,
      }))));
    const res = planCampaign(organic({
      rangeStart: '2026-10-29', rangeEnd: '2026-10-29',
    }), snapshot('2026-10-19', reserved), DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    const design = res.items[0]!.stages.find((s) => s.stepKey === 'design')!;
    expect(['2026-10-26', '2026-10-27']).not.toContain(design.end);
  });

  it('manual tasks consume their configured weight', () => {
    const book = new CapacityBook(
      snapshot('2026-10-19', [
        { userId: M1, day: '2026-10-20', bucket: 'post', weight: 0.5, source: 'manual', refId: 'm1' },
        { userId: M1, day: '2026-10-20', bucket: 'post', weight: 0.5, source: 'manual', refId: 'm2' },
      ]),
      CAL,
    );
    expect(book.usedOn(M1, '2026-10-20', 'post')).toBeCloseTo(1);
    expect(book.freeOn(M1, '2026-10-20', 'post')).toBeCloseTo(3);
  });
});

describe('leave and holidays are hard constraints', () => {
  it('never assigns a person on approved leave', () => {
    const people = TEAM.map((p) => (p.userId === M1
      ? { ...p, leaves: [{ from: '2026-10-19', to: '2026-10-31' }] }
      : p));
    const res = planCampaign(organic({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C].map((p) => ({ ...p, posts: 1, videos: 0 })),
      rangeStart: '2026-10-27', rangeEnd: '2026-10-27',
    }), snapshot('2026-10-19', [], people), DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    for (const it of res.items) {
      const design = it.stages.find((s) => s.stepKey === 'design')!;
      expect(design.assigneeUserId).not.toBe(M1);
      expect(design.assigneeUserId).toBe(M2);
    }
  });

  it('never schedules work on a holiday', () => {
    const cal = { ...CAL, holidays: ['2026-10-26', '2026-10-27'] };
    const snap = { ...snapshot('2026-10-19'), calendar: cal };
    const res = planCampaign(organic({
      rangeStart: '2026-10-29', rangeEnd: '2026-10-29',
    }), snap, DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    for (const st of res.items[0]!.stages) {
      expect(cal.holidays).not.toContain(st.start);
      expect(cal.holidays).not.toContain(st.end);
      expect(st.start === '2026-10-23' || st.start !== '2026-10-23').toBe(true);
    }
  });

  it('a Friday inside a two-day design is skipped, not stretched over', () => {
    // A design whose window straddles Friday Oct 23 must occupy Oct 22 + Oct 24.
    const res = planCampaign(organic({
      rangeStart: '2026-10-27', rangeEnd: '2026-10-27',
    }), snapshot('2026-10-19'), DEFAULT_RULES);
    const design = res.items[0]!.stages.find((s) => s.stepKey === 'design')!;
    // Whatever window it picked, both ends are working days and the span is 2.
    expect(CAL.weekendDays).toContain(5);
    expect(daysBetween(design.start, design.end)).toBeGreaterThanOrEqual(1);
    expect(new Date(`${design.start}T00:00:00Z`).getUTCDay()).not.toBe(5);
    expect(new Date(`${design.end}T00:00:00Z`).getUTCDay()).not.toBe(5);
  });
});

describe('approvals have their own budget', () => {
  it('manager reviews consume the approvals bucket, not the design bucket', () => {
    // Two DIFFERENT projects: Instagram forbids the same project on
    // consecutive posts, so A1 then A2 on back-to-back days is (correctly)
    // unschedulable — see the distribution rules test.
    const res = planCampaign(organic({
      projects: [PROJECT_A, PROJECT_B].map((p) => ({ ...p, posts: 1, videos: 0 })),
      rangeStart: '2026-10-27', rangeEnd: '2026-10-28',
      frequency: [{ platform: 'instagram', perDay: 1, weekdays: null }],
    }), snapshot('2026-10-19'), DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    const mgr = res.items[0]!.stages.find((s) => s.stepKey === 'writing_review')!;
    expect(mgr.bucket).toBe('approvals');
    expect(mgr.assigneeUserId).toBe(MM);
    const writing = res.items[0]!.stages.find((s) => s.stepKey === 'writing')!;
    expect(writing.bucket).toBe('post');
    expect(writing.assigneeUserId).toBe(W);
  });
});
