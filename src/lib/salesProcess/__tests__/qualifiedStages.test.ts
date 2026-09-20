/**
 * The qualified-lead set is DERIVED, and this test is what makes that claim
 * checkable (decision D5 of the monthly operating model).
 *
 * Two failures it exists to catch:
 *
 *  1. Someone re-writes the exclusion as a literal list and a fourth terminal
 *     stage added by the Sales OS quietly inflates every cost-per-qualified-lead
 *     on the month page. The first test fails the moment the derived set stops
 *     matching the config's own terminal stages.
 *  2. Someone reaches for an ordinal rule (`order >= 10`). `salesStudio/analytics.ts`
 *     already implements `stageOrderOf(c) >= 7` semantics, under which the three
 *     terminal-lost stages read as having reached every funnel stage — an
 *     ordinal rule here would inherit that silently. The second test pins the
 *     one terminal stage that must stay IN.
 */
import { describe, it, expect } from 'vitest';
import { terminalLostStages, isQualifiedStage, CLOSED_WON_STAGE } from '../qualifiedStages';
import { getSalesProcessConfig } from '../config';

describe('qualifiedStages', () => {
  it('derives exactly the terminal stages that are not a win', () => {
    const config = getSalesProcessConfig();
    // A stage with no follow-up types is terminal UNLESS it is flagged
    // suspended — see the third test below for why that distinction exists.
    const terminal = config.stages
      .filter((s) => (s.followup_types?.length ?? 0) === 0 && !s.is_suspended)
      .map((s) => s.value);

    // Today: «مغلق ناجح», «غير مؤهل», «خاسر», «يريد إيجار».
    expect(terminal).toContain(CLOSED_WON_STAGE);
    expect(terminalLostStages().sort()).toEqual(
      terminal.filter((v) => v !== CLOSED_WON_STAGE).sort(),
    );
  });

  it('does NOT count a suspended stage as lost', () => {
    // «طلب غير مجاب» has no follow-up types because its work lives in
    // `sales_tasks`, not `followups` — the client is live demand we failed to
    // match, not a lost lead. Counting it as terminal-lost would drop those
    // clients from the qualified measure, making cost-per-qualified-lead look
    // BETTER the worse our inventory fits the market. Caught for real on
    // 2026-09-20 when the stage was added and this suite went red.
    const config = getSalesProcessConfig();
    const suspended = config.stages.filter((s) => s.is_suspended).map((s) => s.value);
    expect(suspended.length).toBeGreaterThan(0);
    for (const stage of suspended) {
      expect(terminalLostStages(), `${stage} must not be terminal-lost`).not.toContain(stage);
      expect(isQualifiedStage(stage), `${stage} must count as qualified`).toBe(true);
    }
  });

  it('is the three D5 named it, and nothing else', () => {
    expect(terminalLostStages()).toEqual(['خاسر', 'غير مؤهل', 'يريد إيجار']);
  });

  it('counts a closed-won client as qualified and a lost one as not', () => {
    expect(isQualifiedStage('مغلق ناجح')).toBe(true);
    expect(isQualifiedStage('جديد')).toBe(true);
    expect(isQualifiedStage('خاسر')).toBe(false);
    expect(isQualifiedStage('يريد إيجار')).toBe(false);
  });

  it('treats an absent or unknown stage as NOT qualified', () => {
    // The month report counts these separately as `ungraded_clients` rather
    // than folding them into either side.
    expect(isQualifiedStage(null)).toBe(false);
    expect(isQualifiedStage('')).toBe(false);
  });

  it('never returns an empty set — the RPC raises on one', () => {
    // `mos_month_metrics` refuses an empty `p_excluded_stages` precisely so an
    // empty derivation cannot mean "everyone is qualified".
    expect(terminalLostStages().length).toBeGreaterThan(0);
  });
});
