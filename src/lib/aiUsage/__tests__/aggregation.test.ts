/**
 * Tests for the AI Usage page's arithmetic.
 *
 * The figures on this page drive a spending decision, so the cases that matter
 * are the ones where a plausible-looking number would be WRONG: an account
 * nobody has entered a balance for, and spend that could not be priced.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeProviderSpend, summarizeSpend, usd, usdPrecise, formatTokens, areaLabel,
  type AiSpendRow,
} from '../client';

function row(over: Partial<AiSpendRow> = {}): AiSpendRow {
  return {
    day: '2026-09-14', area: 'sales', call_site: 'api/client-summary',
    provider: 'deepseek', model: 'deepseek-chat', calls: 1, errors: 0,
    fallback_calls: 0, input_tokens: 100, output_tokens: 10,
    unpriced_calls: 0, cost_usd: 1, ...over,
  };
}

describe('summarizeProviderSpend', () => {
  it('buckets cost, calls and unpriced calls per provider', () => {
    const p = summarizeProviderSpend([
      row({ provider: 'deepseek', cost_usd: 0.4, calls: 10 }),
      row({ provider: 'deepseek', cost_usd: 0.2, calls: 5 }),
      row({ provider: 'fal', cost_usd: 1, calls: 2 }),
    ], 30);
    expect(p.deepseek).toMatchObject({ cost: 0.6000000000000001, calls: 15, unpricedCalls: 0 });
    expect(p.fal.cost).toBe(1);
  });

  it('a null cost adds nothing to the money but the unpriced calls still land', () => {
    // The bucket must be able to say "$0.00 across 400 calls we cannot price"
    // rather than looking free.
    const p = summarizeProviderSpend([
      row({ provider: 'deepseek', cost_usd: null, calls: 400, unpriced_calls: 400 }),
    ], 30);
    expect(p.deepseek.cost).toBe(0);
    expect(p.deepseek.unpricedCalls).toBe(400);
  });

  it('averages over the WHOLE window, not over the days that had traffic', () => {
    // One busy day in thirty is not a $3/day burn rate; dividing by the days
    // that happened to have rows would make every runway wildly pessimistic.
    const p = summarizeProviderSpend([row({ provider: 'fal', cost_usd: 3, calls: 1 })], 30);
    expect(p.fal.perDay).toBeCloseTo(0.1, 10);
  });

  it('a window of zero days never divides by zero', () => {
    const p = summarizeProviderSpend([row({ provider: 'fal', cost_usd: 3 })], 0);
    expect(Number.isFinite(p.fal.perDay)).toBe(true);
    expect(p.fal.perDay).toBe(3);
  });

  it('returns an empty map for no rows', () => {
    expect(summarizeProviderSpend([], 30)).toEqual({});
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
