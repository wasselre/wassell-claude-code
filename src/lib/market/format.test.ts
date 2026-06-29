import { describe, it, expect } from 'vitest';
import { budgetBucket, formatPpm2, formatPct } from './format';

describe('budgetBucket — mirrors SQL wassell_budget_bucket', () => {
  it('buckets by max budget', () => {
    expect(budgetBucket(null)).toBe('all');
    expect(budgetBucket(0)).toBe('all');
    expect(budgetBucket(800_000)).toBe('<1M');
    expect(budgetBucket(1_000_000)).toBe('1-2M');
    expect(budgetBucket(1_999_999)).toBe('1-2M');
    expect(budgetBucket(2_500_000)).toBe('2-3M');
    expect(budgetBucket(4_000_000)).toBe('3-5M');
    expect(budgetBucket(9_000_000)).toBe('5M+');
  });
});

describe('formatting', () => {
  it('ppm2 carries the /m² unit', () => {
    expect(formatPpm2(10200, true)).toContain('م²');
    expect(formatPpm2(10200, false)).toContain('/m²');
    expect(formatPpm2(null, true)).toBe('—');
  });
  it('signed percentages', () => {
    expect(formatPct(8.4)).toBe('+8%');
    expect(formatPct(-12.6)).toBe('−13%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(null)).toBe('—');
  });
});
