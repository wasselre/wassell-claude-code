/**
 * The month tells the truth about capacity — 2026-09-20.
 *
 * On 20 September the page reported September–October as `feasible: true`,
 * `capacityOk: true`, zero conflicts, while TWO of the three paid campaigns
 * had no production plan at all and 60 ad creatives carried no stages. The
 * operator found it by asking "are we actually able to do this?" — nothing in
 * the system said so.
 *
 * Two defects made it possible, and both are asserted here:
 *   1. `ads_live_when_ready` deleted `no_capacity` conflicts, so "nobody is
 *      free to make this" was treated as "this ad will be late";
 *   2. the load table is summed from BOOKINGS, so an item that could not be
 *      placed charged nothing to it — the more of the month that failed to
 *      fit, the healthier the month looked.
 */
import { describe, expect, it } from 'vitest';
import {
  compileMonth, parseMonthTemplate, creativesFor, slateOverridesFor, paidPlanInput,
  monthGeometry, MONTH_TEMPLATE_DEFAULTS, type MonthTemplate,
} from '../../../../../api/_lib/marketing/planning/monthCompiler';
import { DEFAULT_RULES, DEFAULT_PUBLISHING, type RuleSet, type PersonCapacity } from '../index';
import { CAL, PROJECT_A, PROJECT_B, PROJECT_C, snapshot } from './fixtures';

const RULES: RuleSet = {
  ...DEFAULT_RULES,
  publishing: { ...DEFAULT_PUBLISHING, automatable: { instagram: true } },
};
const PROJECTS = [PROJECT_A, PROJECT_B, PROJECT_C];

/** The live shape on 2026-09-20: ONE designer, one writer, one approver. */
const oneDesigner = (designCap: number): PersonCapacity[] => ([
  { userId: 'writer', roles: ['writer'], caps: { post: 10, video: 4, approvals: 20, publishing: 8 }, leaves: [] },
  { userId: 'designer', roles: ['montage'], caps: { post: designCap, video: 4, approvals: 20, publishing: 8 }, leaves: [] },
  { userId: 'manager', roles: ['marketing_manager'], caps: { post: 0, video: 0, approvals: 999, publishing: 8 }, leaves: [] },
]);

const september = (overrides: unknown[] = []): MonthTemplate => parseMonthTemplate({
  posting_weekdays: [0, 2, 4, 6], posts_per_row: 3, projects_per_month: 3,
  creatives_per_project_week: 5, campaign_length_days: 30, budget_per_project: 2000,
  lead_time_working_days: 10, safety_margin_days: 2, publish_time: '18:00:00',
  intra_row_gap_minutes: 5, general_topic_bank: [],
  month_starts: {
    '2026-09': {
      organic_from: '2026-09-22',
      paid_from: '2026-09-22',
      ads_live_when_ready: true,
      through: '2026-10',
      creative_overrides: overrides,
    },
  },
});

const compile = (template: MonthTemplate, designCap: number) => compileMonth({
  month: '2026-09', template, projects: PROJECTS, rules: RULES, startFrom: '2026-09-20',
  snapshot: snapshot('2026-09-20', [], oneDesigner(designCap)),
});

describe('a month never reports work it cannot place', () => {
  it('REGRESSION: the exact 20 Sep plan is refused, not called feasible', () => {
    const out = compile(september(), 5);
    expect(out.summary.unscheduled.length).toBeGreaterThan(0);
    expect(out.summary.feasible).toBe(false);
    // Every unplaced item is NAMED, with the date it was needed by.
    for (const u of out.summary.unscheduled) {
      expect(u.requiredBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['no_capacity', 'unreachable']).toContain(u.reason);
      expect(u.kind).toBe('creative');
    }
  });

  it('counts every requested unit whether or not it was placed', () => {
    const out = compile(september(), 5);
    const design = out.summary.demand.find((d) => d.capacityKey === 'design');
    expect(design).toBeDefined();
    // 23 rows x 3 posts + 6 batches x 5 creatives x 3 projects.
    expect(design!.required).toBe(23 * 3 + 90);
    expect(design!.scheduled + design!.unscheduled).toBe(design!.required);
    expect(design!.unscheduled).toBeGreaterThan(0);
    expect(design!.unitsPerDay).toBe(5);
    expect(design!.workingDays).toBe(36);
    expect(design!.capacity).toBe(180);
    // The load table STRUCTURALLY cannot see this: it is summed from bookings,
    // so the unplaced 60 charge it nothing and it reports no overload.
    const booked = out.summary.load.find((l) => l.userId === 'designer');
    expect(booked!.totalSlots).toBeLessThan(design!.required);
    expect(booked!.over).toBe(false);
  });

  it('a shortage of hands is NEVER forgiven by ads-live-when-ready', () => {
    // One designer at 1/day staffs almost nothing. That is `no_capacity`, and
    // "the ad goes live when it is ready" does not conjure a person.
    const out = compile(september(), 1);
    expect(out.summary.feasible).toBe(false);
    expect(out.summary.unscheduled.length).toBeGreaterThan(0);
  });
});

describe('the operator sizes a batch instead of losing it', () => {
  it('two per project on 22 September resolves the month at five a day', () => {
    const out = compile(september([{ batch_day: '2026-09-22', creatives: 2 }]), 5);
    expect(out.summary.unscheduled).toEqual([]);
    expect(out.summary.feasible).toBe(true);
    // 3 projects x 2 on the 22nd, then 5 on each of the other five batches.
    expect(out.summary.paidCreatives).toBe(3 * 2 + 3 * 5 * 5);
    expect(out.geometry.paidBatchDays).toHaveLength(6);
    expect(out.geometry.paidBatchDays[0]).toBe('2026-09-22');
    const design = out.summary.demand.find((d) => d.capacityKey === 'design')!;
    expect(design.unscheduled).toBe(0);
    expect(design.required).toBe(design.scheduled);
    expect(design.over).toBe(false);
  });

  it('resolves the most specific rule: project+day, then day, then project', () => {
    const t = september([
      { creatives: 4, project_id: PROJECT_B.projectId },
      { batch_day: '2026-09-22', creatives: 2 },
      { batch_day: '2026-09-22', project_id: PROJECT_C.projectId, creatives: 1 },
    ]);
    expect(creativesFor(t, '2026-09', PROJECT_A.projectId, '2026-09-22')).toBe(2);
    expect(creativesFor(t, '2026-09', PROJECT_C.projectId, '2026-09-22')).toBe(1);
    expect(creativesFor(t, '2026-09', PROJECT_B.projectId, '2026-09-29')).toBe(4);
    // Unmatched keeps the template.
    expect(creativesFor(t, '2026-09', PROJECT_A.projectId, '2026-09-29')).toBe(5);
  });

  it('carries the sizing into the engine, and only for the dates it names', () => {
    const t = september([{ batch_day: '2026-09-22', creatives: 2 }]);
    const geo = monthGeometry('2026-09', t, CAL, '2026-09-20');
    expect(slateOverridesFor(t, '2026-09', PROJECT_A.projectId, geo.paidBatchDays))
      .toEqual({ '2026-09-22': 2 });
    expect(paidPlanInput(geo, t, PROJECT_A).paid[0]!.policy.slateOn)
      .toEqual({ '2026-09-22': 2 });
  });

  it('drops a malformed or zero rule rather than resizing a month by accident', () => {
    const t = september([
      { batch_day: '2026-09-22', creatives: 0 },
      { batch_day: '2026-09-22', creatives: 'two' },
      { creatives: -3 },
      'nonsense',
    ]);
    expect(t.monthStarts['2026-09']!.creativeOverrides).toEqual([]);
    expect(creativesFor(t, '2026-09', PROJECT_A.projectId, '2026-09-22')).toBe(5);
  });
});

describe('an ordinary month is untouched by any of this', () => {
  it('October on the standing template still plans 108 items, all placed', () => {
    const out = compileMonth({
      month: '2026-10', template: MONTH_TEMPLATE_DEFAULTS, projects: PROJECTS, rules: RULES,
      snapshot: snapshot('2026-09-20'), startFrom: null,
    });
    expect(out.summary.items).toBe(108);
    expect(out.summary.unscheduled).toEqual([]);
    expect(out.summary.feasible).toBe(true);
    const design = out.summary.demand.find((d) => d.capacityKey === 'design')!;
    expect(design.required).toBe(108);
    expect(design.unscheduled).toBe(0);
  });
});
