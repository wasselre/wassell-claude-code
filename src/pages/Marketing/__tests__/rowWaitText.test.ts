/**
 * A queued row says why it waits and when it is produced — never «بلا موعد».
 *
 * Reported live on 2026-09-20 from the work queue: fourteen of September's
 * fifteen ad creatives read «بلا موعد» — "no date". Nothing was wrong with the
 * plan. A task waiting on capacity deliberately carries no `due_at`, because
 * its 24-hour allowance starts when it reaches a person and nothing should be
 * "late" for sitting in a queue. But the content-row table only ever read
 * `current_task_due_at`, so it reported a deliberate NULL as an absent plan —
 * when the row knew it is produced 27–28 Sep and goes live on the 29th.
 *
 * The rule these tests pin down: a row with no deadline must still say
 * everything it knows, and must only fall back to "no date" when it genuinely
 * knows nothing.
 */
import { describe, expect, it } from 'vitest';
import { rowWaitText } from '../WorkPage';

const row = (over: Partial<Parameters<typeof rowWaitText>[0]> = {}) => ({
  status_key: 'writing',
  current_task_waiting_reason: 'capacity' as string | null,
  current_task_scheduled_start: '2026-09-28' as string | null,
  ...over,
});

describe('rowWaitText', () => {
  it('says why it waits AND the day it is produced', () => {
    const ar = rowWaitText(row(), true);
    expect(ar).toContain('بانتظار سعة الكتابة');
    expect(ar).toContain('الإنتاج');
    // The Arabic-Indic 28 of September — the day the plan actually names.
    expect(ar).toContain('٢٨');
    expect(ar).toContain('سبتمبر');

    const en = rowWaitText(row(), false);
    expect(en).toBe('Waiting for writing capacity · produced Sep 28');
  });

  it('names the design queue separately from the writing queue', () => {
    expect(rowWaitText(row({ status_key: 'design' }), false))
      .toBe('Waiting for design capacity · produced Sep 28');
  });

  it('carries the non-capacity reasons through', () => {
    expect(rowWaitText(row({ current_task_waiting_reason: 'day_off' }), false))
      .toContain('Friday is off');
    expect(rowWaitText(row({ current_task_waiting_reason: 'no_holder' }), false))
      .toContain('Waiting for someone in this role');
  });

  it('still says why it waits when no production day is known', () => {
    expect(rowWaitText(row({ current_task_scheduled_start: null }), false))
      .toBe('Waiting for writing capacity');
  });

  it('returns null when the row is NOT waiting — the caller shows the deadline', () => {
    expect(rowWaitText(row({ current_task_waiting_reason: null }), false)).toBeNull();
    // Missing entirely (an older payload) is the same as not waiting.
    expect(rowWaitText({ status_key: 'writing' }, false)).toBeNull();
  });
});
