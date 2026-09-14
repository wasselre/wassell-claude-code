/**
 * Tests for the AI Usage page's arithmetic.
 *
 * The figures on this page drive a spending decision, so the cases that matter
 * are the ones where a plausible-looking number would be WRONG: an account
 * nobody has entered a balance for, and spend that could not be priced.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeAccounts, summarizeSpend, usd, usdPrecise, formatTokens, areaLabel,
  type AiAccountBalance, type AiSpendRow,
} from '../client';

function account(over: Partial<AiAccountBalance> = {}): AiAccountBalance {
  return {
    id: 'a1', provider: 'anthropic', label: 'Anthropic', currency: 'USD',
    is_active: true, low_balance_threshold: null, notes: null,
    credited_usd: 100, tracking_since: '2026-09-01T00:00:00Z', last_topup_at: null,
    entry_count: 1, spent_usd: 10, remaining_usd: 90, pct_used: 10,
    unpriced_calls: 0, total_calls: 5, remaining_is_upper_bound: false, is_low: false,
    ...over,
  };
}

function row(over: Partial<AiSpendRow> = {}): AiSpendRow {
  return {
    day: '2026-09-14', area: 'sales', call_site: 'api/client-summary',
    provider: 'deepseek', model: 'deepseek-chat', calls: 1, errors: 0,
    fallback_calls: 0, input_tokens: 100, output_tokens: 10,
    unpriced_calls: 0, cost_usd: 1, ...over,
  };
}

describe('summarizeAccounts', () => {
  it('adds up the tracked accounts', () => {
    const t = summarizeAccounts([
      account({ id: 'a', credited_usd: 100, spent_usd: 10, remaining_usd: 90 }),
      account({ id: 'b', provider: 'fal', credited_usd: 50, spent_usd: 5, remaining_usd: 45 }),
    ]);
    expect(t).toMatchObject({ credited: 150, spent: 15, remaining: 135, trackedCount: 2, untrackedCount: 0 });
  });

  it('EXCLUDES accounts with no credit entries from every total', () => {
    // An untracked account has no balance. Counting its zero would report
    // "$0 left" for an account nobody has entered a number for yet.
    const t = summarizeAccounts([
      account({ id: 'a', credited_usd: 100, spent_usd: 10, remaining_usd: 90 }),
      account({ id: 'b', provider: 'modal', entry_count: 0, credited_usd: 0, spent_usd: 0, remaining_usd: 0 }),
    ]);
    expect(t.remaining).toBe(90);
    expect(t.trackedCount).toBe(1);
    expect(t.untrackedCount).toBe(1);
  });

  it('flags the whole total as an upper bound when ANY account has unpriced usage', () => {
    const t = summarizeAccounts([
      account({ id: 'a' }),
      account({ id: 'b', provider: 'deepseek', unpriced_calls: 400, remaining_is_upper_bound: true }),
    ]);
    expect(t.anyUpperBound).toBe(true);
  });

  it('does not flag an upper bound from an UNTRACKED account', () => {
    // Its usage is not being subtracted from anything, so it cannot make a
    // balance optimistic.
    const t = summarizeAccounts([
      account({ id: 'a' }),
      account({ id: 'b', entry_count: 0, unpriced_calls: 99, remaining_is_upper_bound: true }),
    ]);
    expect(t.anyUpperBound).toBe(false);
  });

  it('counts low-balance accounts', () => {
    expect(summarizeAccounts([account({ is_low: true }), account({ id: 'b' })]).lowCount).toBe(1);
  });

  it('returns zeros for no accounts at all', () => {
    expect(summarizeAccounts([])).toMatchObject({ remaining: 0, trackedCount: 0, anyUpperBound: false });
  });
});

describe('summarizeSpend', () => {
  it('groups by area and by call site, biggest spend first', () => {
    const s = summarizeSpend([
      row({ area: 'sales', call_site: 'api/match', cost_usd: 5, calls: 2 }),
      row({ area: 'translation', call_site: 'worker/translateProvider', cost_usd: 1, calls: 40 }),
      row({ area: 'sales', call_site: 'api/match', cost_usd: 3, calls: 1 }),
    ]);
    expect(s.cost).toBe(9);
    expect(s.calls).toBe(43);
    expect(s.areas[0]).toEqual(['sales', { cost: 8, calls: 3, unpriced: 0 }]);
    expect(s.areas[1]![0]).toBe('translation');
    expect(s.sites[0]![0]).toBe('api/match');
  });

  it('keeps unpriced calls visible in a bucket that costs nothing', () => {
    // The dangerous shape: a bucket that reads $0.00 but represents real spend
    // we simply cannot price. The count has to survive so the UI can say so.
    const s = summarizeSpend([
      row({ area: 'translation', cost_usd: null, calls: 400, unpriced_calls: 400 }),
    ]);
    expect(s.cost).toBe(0);
    expect(s.unpricedCalls).toBe(400);
    expect(s.areas[0]![1]).toEqual({ cost: 0, calls: 400, unpriced: 400 });
  });

  it('breaks a cost tie on call volume', () => {
    const s = summarizeSpend([
      row({ call_site: 'quiet', cost_usd: 0, calls: 1, unpriced_calls: 1 }),
      row({ call_site: 'busy', cost_usd: 0, calls: 900, unpriced_calls: 900 }),
    ]);
    expect(s.sites[0]![0]).toBe('busy');
  });

  it('caps the call-site list', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ call_site: `site-${i}`, cost_usd: i }));
    expect(summarizeSpend(rows, 12).sites).toHaveLength(12);
  });

  it('handles an empty ledger', () => {
    expect(summarizeSpend([])).toMatchObject({ cost: 0, calls: 0, areas: [], sites: [] });
  });
});

describe('formatting', () => {
  it('shows money to the cent', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(0)).toBe('$0.00');
  });

  it('shows an em dash rather than $0.00 for a missing figure', () => {
    // "$0.00" reads as "free"; "—" reads as "we don't know". They are different.
    expect(usd(null)).toBe('—');
    expect(usdPrecise(undefined)).toBe('—');
  });

  it('keeps sub-cent per-call costs legible', () => {
    expect(usdPrecise(0.0017)).toBe('$0.0017');
    expect(usdPrecise(12.5)).toBe('$12.50');
  });

  it('abbreviates token counts', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(2_400)).toBe('2K');
    expect(formatTokens(300)).toBe('300');
  });

  it('falls back to the raw slug for an area added later', () => {
    expect(areaLabel('sales', false)).toBe('Sales');
    expect(areaLabel('sales', true)).toBe('المبيعات');
    expect(areaLabel('brand-new-area', false)).toBe('brand-new-area');
  });
});
