/**
 * A re-plan freezes the ad batches that are already underway — 2026-09-27.
 *
 * Re-planning September on the 27th was refused: the 29 Sep batch had all
 * fifteen creatives written and in design, but its day was still ahead, so the
 * planner produced it a SECOND time from scratch, found no designer time before
 * the 28th for work already on the designer's desk, and refused every ad
 * creative of the month. Until then only a batch whose DAY had passed was
 * frozen. Now a batch whose every creative is started is frozen too, and a
 * partly-started one deliberately is not (freezing it would strip its
 * unstarted creatives of their bookings).
 */
import { describe, expect, it } from 'vitest';
import {
  keptBookingIds, namedSubjectKeys, underwayPaidBatchDays, type OwnBooking,
} from '../../../../../api/_lib/marketing/planning/monthActions';
import {
  compileMonth, MONTH_TEMPLATE_DEFAULTS, type MonthTemplate,
} from '../../../../../api/_lib/marketing/planning/monthCompiler';
import { DEFAULT_RULES, type RuleSet } from '../plan';
import { DEFAULT_PUBLISHING } from '../releases';
import { PROJECT_A, PROJECT_B, PROJECT_C, snapshot } from './fixtures';

const START = '2026-09-27';
const EXEC_A = 'exec-a';
const EXEC_B = 'exec-b';
const projectByExec = new Map<string, string | null>([[EXEC_A, 'proj-a'], [EXEC_B, 'proj-b']]);

const cycle = (id: string, exec: string, day: string | null) => ({ id, execution_id: exec, refresh_on: day });
const slots = (cycleId: string, contents: Array<string | null>) =>
  contents.map((c) => ({ cycle_id: cycleId, content_id: c }));

describe('which ad batches a re-plan freezes', () => {
  it('freezes a batch whose day has passed, started or not', () => {
    const out = underwayPaidBatchDays({
      startFrom: START,
      cycles: [cycle('c0', EXEC_A, '2026-09-22'), cycle('c1', EXEC_A, START)],
      projectByExec,
      slots: [],
      startedContentIds: new Set(),
    });
    expect(out).toEqual({ 'proj-a': ['2026-09-22', START] });
  });

  it('freezes a batch still ahead when EVERY creative of it is started — the 29 Sep case', () => {
    const out = underwayPaidBatchDays({
      startFrom: START,
      cycles: [cycle('c1', EXEC_A, '2026-09-29')],
      projectByExec,
      slots: slots('c1', ['k1', 'k2', 'k3', 'k4', 'k5']),
      startedContentIds: new Set(['k1', 'k2', 'k3', 'k4', 'k5']),
    });
    expect(out).toEqual({ 'proj-a': ['2026-09-29'] });
  });

  it('does NOT freeze a batch only partly started — its unstarted creatives would lose their plan', () => {
    const out = underwayPaidBatchDays({
      startFrom: START,
      cycles: [cycle('c1', EXEC_A, '2026-09-29')],
      projectByExec,
      slots: slots('c1', ['k1', 'k2', 'k3', 'k4', 'k5']),
      startedContentIds: new Set(['k1', 'k2']),
    });
    expect(out).toEqual({});
  });

  it('does NOT freeze a batch whose slots are not all materialised yet', () => {
    const out = underwayPaidBatchDays({
      startFrom: START,
      cycles: [cycle('c1', EXEC_A, '2026-09-29')],
      projectByExec,
      slots: slots('c1', ['k1', null]),
      startedContentIds: new Set(['k1']),
    });
    expect(out).toEqual({});
  });

  it('does NOT freeze a future batch with no slots at all', () => {
    const out = underwayPaidBatchDays({
      startFrom: START,
      cycles: [cycle('c3', EXEC_A, '2026-10-13')],
      projectByExec,
      slots: [],
      startedContentIds: new Set(),
    });
    expect(out).toEqual({});
  });

  it('keeps projects apart, ignores unknown executions and undated cycles, and never repeats a day', () => {
    const out = underwayPaidBatchDays({
      startFrom: START,
      cycles: [
        cycle('a0', EXEC_A, '2026-09-22'),
        cycle('a0-dup', EXEC_A, '2026-09-22'),
        cycle('b1', EXEC_B, '2026-09-29'),
        cycle('x1', 'exec-unknown', '2026-09-22'),
        cycle('a9', EXEC_A, null),
      ],
      projectByExec,
      slots: slots('b1', ['b-k1']),
      startedContentIds: new Set(['b-k1']),
    });
    expect(out).toEqual({ 'proj-a': ['2026-09-22'], 'proj-b': ['2026-09-29'] });
  });
});

/* ------------------------------------------------------------------ */

const RULES: RuleSet = {
  ...DEFAULT_RULES,
  publishing: { ...DEFAULT_PUBLISHING, automatable: { instagram: true } },
};
const PROJECTS = [PROJECT_A, PROJECT_B, PROJECT_C];
/** September from the 22nd through October, ads live when ready — the live month. */
const STRETCH: MonthTemplate = {
  ...MONTH_TEMPLATE_DEFAULTS,
  monthStarts: {
    '2026-09': {
      organicFrom: '2026-09-22',
      paidFrom: '2026-09-22',
      adsLiveWhenReady: true,
      through: '2026-10',
    },
  },
};

const compileOn27 = (frozen: string[]) => compileMonth({
  month: '2026-09', template: STRETCH, projects: PROJECTS, rules: RULES, startFrom: START,
  snapshot: snapshot(START),
  frozenPaidBatchDays: Object.fromEntries(PROJECTS.map((p) => [p.projectId, frozen])),
});

describe('re-planning September on the 27th', () => {
  it('REGRESSION: with only the passed batch frozen, the 29 Sep batch is planned twice and the month is refused', () => {
    const out = compileOn27(['2026-09-22']);
    expect(out.summary.feasible).toBe(false);
    expect(out.summary.unscheduled.some((u) => u.requiredBy === '2026-09-29')).toBe(true);
  });

  it('with the started 29 Sep batch frozen too, the month is confirmable and that batch produces nothing new', () => {
    const out = compileOn27(['2026-09-22', '2026-09-29']);
    expect(out.summary.unscheduled).toEqual([]);
    expect(out.summary.feasible).toBe(true);
    // The round is kept (numbering stays stable for the commit) and makes nothing.
    for (const p of out.paid) {
      const r1 = p.plan.cycles.find((c) => c.refreshOn === '2026-09-29');
      expect(r1?.round).toBe(1);
      expect(r1?.produced).toBe(0);
      expect(p.plan.items.every((it) => it.slot?.cycleRound !== 1)).toBe(true);
    }
    // Every later batch is still produced in full: rounds 2–5, five each, three projects.
    expect(out.summary.paidCreatives).toBe(4 * 5 * PROJECTS.length);
  });
});

/* ------------------------------------------------------------------ */

describe('the bookings a re-plan keeps are counted, not dropped', () => {
  const b = (id: string, over: Partial<OwnBooking>): OwnBooking => ({
    id, content_id: null, row_id: null, content_key: null, ...over,
  });
  const own: OwnBooking[] = [
    // a creative of the frozen 29 Sep batch: started, not named → KEPT where it is
    b('r1-check', { content_id: 'k1', content_key: 'exec:meta:a:c1:s1' }),
    // a creative of the 6 Oct batch: not started, named → re-dated by the commit
    b('r2-write', { content_id: 'k2', content_key: 'exec:meta:a:c2:s1' }),
    // a started creative the new plan still names → re-dated by the carry
    b('r2-started', { content_id: 'k3', content_key: 'exec:meta:a:c2:s2' }),
    // a started row whose posting day has passed: not named → KEPT
    b('row-past', { row_id: 'row-1', content_key: '2026-09:w3:2026-09-24:c' }),
    // a started subject with no key at all can never be named → KEPT
    b('legacy', { content_id: 'k4' }),
    // not started and not named → retired by the commit, never counted
    b('orphan', { content_id: 'k5', content_key: 'gone' }),
  ];
  const started = new Set(['k1', 'k3', 'row-1', 'k4']);
  const named = new Set(['exec:meta:a:c2:s1', 'exec:meta:a:c2:s2', '2026-09:w4:2026-09-29:b']);

  it('keeps a started subject the new plan does not name, and nothing else', () => {
    expect(Array.from(keptBookingIds(own, started, named)).sort()).toEqual(['legacy', 'r1-check', 'row-past']);
  });

  it('names rows by their row key and creatives by their item key, never a row member', () => {
    const out = compileOn27(['2026-09-22', '2026-09-29']);
    const named27 = namedSubjectKeys(out);
    const rowKeys = out.organic.plan.rows.map((r) => r.rowKey);
    expect(rowKeys.length).toBeGreaterThan(0);
    for (const k of rowKeys) expect(named27.has(k)).toBe(true);
    // Row members are booked through their row, so their own keys are not subjects.
    for (const it of out.organic.plan.items) expect(named27.has(it.key)).toBe(false);
    // Every planned creative is named; the frozen batch's are not.
    for (const p of out.paid) for (const it of p.plan.items) expect(named27.has(it.key)).toBe(true);
    expect(Array.from(named27).some((k) => /:c1:s\d+$/.test(k))).toBe(false);
  });
});
