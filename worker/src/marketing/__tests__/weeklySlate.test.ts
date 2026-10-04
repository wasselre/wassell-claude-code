/**
 * The weekly ad rule (operator, 2026-10-04): five new a week; each week keep the
 * best one of last week's batch and stop the others. The fixtures are the three
 * September–October projects as they stood on 5 October 2026.
 */
import { describe, expect, it } from 'vitest';
import { planWeeklySlate, rankCreatives, type SlateCreative } from '../weeklySlate.js';

const DAYS = ['2026-09-22', '2026-09-29', '2026-10-06', '2026-10-13'];

function c(ref: string, batchDay: string | null, over: Partial<SlateCreative> = {}): SlateCreative {
  return {
    key: `row-${ref}`, ref, batchDay, onMeta: true, status: 'running',
    activatedAt: null, retiredAt: null, leads: 0, metaLeads: 0, spend: 0, clicks: 0,
    ...over,
  };
}

describe('ranking a batch', () => {
  it('most leads wins; a tie goes to the cheaper lead; then more clicks', () => {
    const ranked = rankCreatives([
      c('A', null, { leads: 2, spend: 100 }),
      c('B', null, { leads: 2, spend: 40 }),
      c('C', null, { leads: 3, spend: 400 }),
      c('D', null, { leads: 0, spend: 5, clicks: 9 }),
      c('E', null, { leads: 0, spend: 5, clicks: 2 }),
    ], 'ours');
    expect(ranked.map((r) => r.ref)).toEqual(['C', 'B', 'A', 'D', 'E']);
  });
});

describe('the weekly turnover', () => {
  it('before any batch has started, nothing moves', () => {
    const p = planWeeklySlate({ today: '2026-09-20', batchDays: DAYS, creatives: [c('X', '2026-09-22', { status: 'paused' })], minActive: 5 });
    expect(p.currentBatch).toBeNull();
    expect(p.activate).toEqual([]);
    expect(p.pause).toEqual([]);
  });

  it('a batch goes live on its day; a creative of next week waits', () => {
    const p = planWeeklySlate({
      today: '2026-10-06', batchDays: DAYS, minActive: 5,
      creatives: [
        c('NEW1', '2026-10-06', { status: 'paused' }),
        c('NEXT', '2026-10-13', { status: 'paused' }),
      ],
    });
    expect(p.activate).toEqual(['row-NEW1']);
  });

  it('never re-activates what a person or this rule paused', () => {
    const p = planWeeklySlate({
      today: '2026-10-06', batchDays: DAYS, minActive: 5,
      creatives: [
        c('BYHAND', '2026-10-06', { status: 'paused', activatedAt: '2026-10-06T08:00:00Z' }),
        c('RETIRED', '2026-10-06', { status: 'paused', retiredAt: '2026-10-06T09:00:00Z' }),
      ],
    });
    expect(p.activate).toEqual([]);
  });

  it('5 Oct, Riya Al-Nakheel: keeps the best of 22 Sep, stops the other (6 live → 5)', () => {
    const p = planWeeklySlate({
      today: '2026-10-05', batchDays: DAYS, minActive: 5,
      creatives: [
        c('P-471', '2026-09-22', { leads: 4, spend: 133 }),
        c('P-472', '2026-09-22', { leads: 2, spend: 74 }),
        c('P-477', '2026-09-29', { leads: 1 }), c('P-478', '2026-09-29', { leads: 2 }), c('P-479', '2026-09-29'),
        // approved early under the old setting — next week's, left running
        c('P-502', '2026-10-06', { leads: 3 }), c('P-503', '2026-10-06'),
      ],
    });
    expect(p.keep).toBe('row-P-471');
    expect(p.pause).toEqual(['row-P-472']);
    expect(p.holdForMinimum).toEqual([]);
    expect(p.liveAfter).toBe(6);
  });

  it('5 Oct, Yamam 17: the loser of 22 Sep is held — stopping it would leave 4 live', () => {
    const p = planWeeklySlate({
      today: '2026-10-05', batchDays: DAYS, minActive: 5,
      creatives: [
        c('P-473', '2026-09-22', { leads: 15, spend: 415 }),
        c('P-474', '2026-09-22', { leads: 9, spend: 163 }),
        c('P-484', '2026-09-29'), c('P-485', '2026-09-29', { leads: 9 }), c('P-486', '2026-09-29'),
      ],
    });
    expect(p.keep).toBe('row-P-473');
    expect(p.pause).toEqual([]);
    expect(p.holdForMinimum).toEqual(['row-P-474']);
  });

  it('6 Oct with the new designs late: only what exceeds the minimum stops, worst first', () => {
    const p = planWeeklySlate({
      today: '2026-10-06', batchDays: DAYS, minActive: 5, storedKeep: undefined,
      creatives: [
        c('P-476', '2026-09-22', { leads: 3, spend: 170 }),
        c('P-487', '2026-09-29', { spend: 26 }), c('P-488', '2026-09-29', { leads: 2, spend: 96 }),
        c('P-489', '2026-09-29', { leads: 1, spend: 232 }), c('P-490', '2026-09-29', { spend: 19 }),
        c('P-491', '2026-09-29', { spend: 11, clicks: 1 }),
        c('P-492', '2026-10-06', { onMeta: false }),
      ],
    });
    expect(p.currentBatch).toBe('2026-10-06');
    expect(p.previousBatch).toBe('2026-09-29');
    expect(p.keep).toBe('row-P-488');
    // 6 live, minimum 5 → one stops: the oldest batch's leftover goes before last week's
    expect(p.pause).toEqual(['row-P-476']);
    // best first: P-489 has a lead; of the no-lead ones P-491 has a click
    expect(p.holdForMinimum).toEqual(['row-P-489', 'row-P-491', 'row-P-487', 'row-P-490']);
  });

  it('once the new five are live, everything but the keeper stops', () => {
    const live = (ref: string): SlateCreative => c(ref, '2026-10-06');
    const p = planWeeklySlate({
      today: '2026-10-07', batchDays: DAYS, minActive: 5, storedKeep: 'row-P-488',
      creatives: [
        c('P-476', '2026-09-22', { leads: 3 }),
        c('P-487', '2026-09-29'), c('P-488', '2026-09-29', { leads: 2 }),
        c('P-489', '2026-09-29', { leads: 5 }), // overtook the keeper — the stored choice stands
        c('P-490', '2026-09-29'), c('P-491', '2026-09-29'),
        live('P-492'), live('P-493'), live('P-494'), live('P-495'), live('P-496'),
      ],
    });
    expect(p.keep).toBe('row-P-488');
    expect(p.keepWasStored).toBe(true);
    expect(new Set(p.pause)).toEqual(new Set(['row-P-476', 'row-P-487', 'row-P-489', 'row-P-490', 'row-P-491']));
    expect(p.liveAfter).toBe(6);
  });

  it('ranks on Meta leads only when no creative of the batch has one of ours', () => {
    const p = planWeeklySlate({
      today: '2026-10-06', batchDays: DAYS, minActive: 1,
      creatives: [
        c('A', '2026-09-29', { metaLeads: 1 }), c('B', '2026-09-29', { metaLeads: 4 }),
        c('N', '2026-10-06'),
      ],
    });
    expect(p.leadSource).toBe('meta');
    expect(p.keep).toBe('row-B');
    expect(p.pause).toEqual(['row-A']);
  });

  it('a creative no slot names counts as the oldest and stops first', () => {
    const p = planWeeklySlate({
      today: '2026-10-06', batchDays: DAYS, minActive: 2,
      creatives: [c('LOOSE', null, { leads: 50 }), c('K', '2026-09-29'), c('N', '2026-10-06')],
    });
    expect(p.pause).toEqual(['row-LOOSE']);
  });
});
