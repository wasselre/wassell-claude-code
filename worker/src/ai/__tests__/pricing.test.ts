import { describe, it, expect } from 'vitest';
import { PRICING, priceFor, computeCostUsd, sumCosts } from '../pricing';

describe('pricing table', () => {
  it('has the contract default models', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
      expect(priceFor(m), m).not.toBeNull();
    }
  });
  it('alias and dated snapshot share one row', () => {
    expect(priceFor('claude-haiku-4-5')).toEqual(priceFor('claude-haiku-4-5-20251001'));
  });
  it('unknown model → null, never a number', () => {
    expect(priceFor('gpt-5')).toBeNull();
    expect(priceFor('claude-opus-4-5')).toBeNull(); // documented but unpriced in the skill → deliberately absent
    expect(computeCostUsd('claude-mystery-9', { input: 1000, output: 1000 })).toBeNull();
  });
  it('cache rates derive from input price (0.1× read, 1.25× / 2× write)', () => {
    const p = PRICING['claude-opus-5'];
    expect(p.cache_read_per_m).toBe(0.5);
    expect(p.cache_write_5m_per_m).toBe(6.25);
    expect(p.cache_write_1h_per_m).toBe(10);
    // Fable 5.1 cache reads are 0.025× ($0.25/MTok)
    expect(PRICING['claude-fable-5-1'].cache_read_per_m).toBe(0.25);
  });
});

describe('computeCostUsd', () => {
  it('1M in + 1M out on opus-5 = $30', () => {
    expect(computeCostUsd('claude-opus-5', { input: 1_000_000, output: 1_000_000 })).toBe(30);
  });
  it('sonnet-5 small call rounds to 6 decimals', () => {
    // 1234 in × $2/M + 567 out × $10/M = 0.002468 + 0.00567 = 0.008138
    expect(computeCostUsd('claude-sonnet-5', { input: 1234, output: 567 })).toBe(0.008138);
  });
  it('includes cache read + write tokens at their own rates', () => {
    // haiku: 100k read × $0.1/M = 0.01 ; 100k write5m × $1.25/M = 0.125 ; 0 in/out
    expect(computeCostUsd('claude-haiku-4-5', { input: 0, output: 0, cache_read: 100_000, cache_write_5m: 100_000 })).toBe(0.135);
    expect(computeCostUsd('claude-haiku-4-5', { input: 0, output: 0, cache_write_1h: 1_000_000 })).toBe(2);
  });
  it('ignores negative / NaN token counts', () => {
    expect(computeCostUsd('claude-opus-5', { input: -5, output: Number.NaN })).toBe(0);
  });
});

describe('sumCosts', () => {
  it('sums known costs', () => {
    expect(sumCosts([0.1, 0.2, 0.3])).toBe(0.6);
  });
  it('is null when any part is unknown', () => {
    expect(sumCosts([0.1, null, 0.3])).toBeNull();
    expect(sumCosts([undefined])).toBeNull();
  });
  it('empty list is 0', () => {
    expect(sumCosts([])).toBe(0);
  });
});
