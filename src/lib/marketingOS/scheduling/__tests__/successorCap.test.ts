/**
 * A stage may never be placed AFTER the stage that follows it.
 *
 * Backward scheduling places the last step first. When a successor is pulled
 * EARLIER than its own deadline (its holder is saturated on the later days),
 * the predecessor's latest end must move with it: on a same-day chain it may
 * end on the day the successor starts, otherwise the working day before.
 *
 * Until 2026-09-22 `effectiveDeadline` returned the LATER of the two dates
 * (`max`) instead of the earlier (`min`), so a predecessor kept its own,
 * later deadline and could land after its successor. Measured on production
 * on 2026-09-22: 35 paid creatives with the design booked AFTER the writer's
 * check of that design. This test reproduces the shape on the default post
 * path and pins the rule.
 */
import { describe, it, expect } from 'vitest';
import { planCampaign, DEFAULT_RULES } from '../plan';
import { daysBetween } from '../calendar';
import type { LedgerRow, PlanInput, PlannedItem } from '../types';
import { PROJECT_A, W, snapshot } from './fixtures';

const IG = (perDay: number) => [{ platform: 'instagram', perDay, weekdays: null }];

const organic = (over: Partial<PlanInput> = {}): PlanInput => ({
  campaignId: 'camp-cap',
  kind: 'organic',
  projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
  platforms: ['instagram'],
  rangeStart: '2026-10-11',
  rangeEnd: '2026-10-11',
  frequency: IG(3),
  crossPost: false,
  publishBufferDays: 1,
  ...over,
});

const stageOf = (item: PlannedItem, step: string) => item.stages.find((s) => s.stepKey === step);

/** Production order of the default post path; publishing steps are not part of it. */
const PROD = ['writing', 'writing_review', 'design', 'design_writer_review', 'design_review'];

/** The writer's APPROVALS bucket full on the last two working days before the need day. */
const WRITER_SATURATED: LedgerRow[] = ['2026-10-10', '2026-10-08'].map((day) => ({
  userId: W, day, bucket: 'approvals' as const, weight: 20, source: 'task' as const, refId: `sat-${day}`,
}));

describe('a predecessor never lands after its successor', () => {
  it('caps the design at the writer check when the check was pulled earlier', () => {
    const res = planCampaign(organic(), snapshot('2026-10-01', WRITER_SATURATED), DEFAULT_RULES);
    expect(res.feasible).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);

    for (const it of res.items) {
      const chain = PROD.map((k) => stageOf(it, k)).filter((s): s is NonNullable<typeof s> => !!s);
      expect(chain.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i + 1 < chain.length; i += 1) {
        const pred = chain[i]!;
        const succ = chain[i + 1]!;
        // Same-day chain: the predecessor may END on the day the successor STARTS, never later.
        expect(
          daysBetween(pred.end, succ.start),
          `${it.key}: ${pred.stepKey} ends ${pred.end} after ${succ.stepKey} starts ${succ.start}`,
        ).toBeGreaterThanOrEqual(0);
      }
      // The writer's check was pushed off the saturated days …
      const check = stageOf(it, 'design_writer_review')!;
      expect(['2026-10-10', '2026-10-08']).not.toContain(check.start);
      // … and the design moved with it instead of staying on its own later deadline.
      const design = stageOf(it, 'design')!;
      expect(daysBetween(design.end, check.start)).toBeGreaterThanOrEqual(0);
    }

    // Capacity respected everywhere.
    for (const cell of res.load) {
      expect(cell.existing + cell.proposed).toBeLessThanOrEqual(cell.capacity + 1e-9);
    }
  });
});
