import { describe, it, expect } from 'vitest';
import { computeDealBadge, type BenchmarkSlice, type DealBadgeInput } from './dealBadge';

const bench = (over: Partial<BenchmarkSlice> = {}): BenchmarkSlice => ({
  p25_price_per_sqm: 8000,
  p75_price_per_sqm: 12000,
  median_price_per_sqm: 10000,
  deduped_count: 200,
  duplicate_ratio: 0.1,
  confidence_grade: 'high',
  has_transaction: false,
  ...over,
});

const input = (over: Partial<DealBadgeInput> = {}): DealBadgeInput => ({
  source: 'market_listings',
  pricePerSqm: 7000,
  hasPrice: true,
  hasArea: true,
  geoVerified: true,
  typeMatchesBenchmark: true,
  benchmark: bench(),
  ...over,
});

describe('computeDealBadge — deterministic, honest', () => {
  it('strong_value only when ≤P25, confident, geo-verified, type matches', () => {
    const b = computeDealBadge(input({ pricePerSqm: 7000 }));
    expect(b.kind).toBe('strong_value');
    expect(b.verify_before_offering).toBe(true); // external listing
    expect(b.vs_median_pct).toBeCloseTo(-30, 0);
  });

  it('low-confidence benchmark NEVER yields strong_value → potential_value when cheap', () => {
    const b = computeDealBadge(input({ pricePerSqm: 7000, benchmark: bench({ confidence_grade: 'low' }) }));
    expect(b.kind).toBe('potential_value');
  });

  it('low-confidence + not cheap → thin_market', () => {
    const b = computeDealBadge(input({ pricePerSqm: 11000, benchmark: bench({ confidence_grade: 'low' }) }));
    expect(b.kind).toBe('thin_market');
  });

  it('geo not verified downgrades a would-be strong_value to potential_value', () => {
    const b = computeDealBadge(input({ pricePerSqm: 7000, geoVerified: false }));
    expect(b.kind).toBe('potential_value');
  });

  it('premium_price above P75', () => {
    expect(computeDealBadge(input({ pricePerSqm: 13000 })).kind).toBe('premium_price');
  });

  it('fair_market between P25 and P75', () => {
    expect(computeDealBadge(input({ pricePerSqm: 10000 })).kind).toBe('fair_market');
  });

  it('missing price/area produce the correct badges, never a value verdict', () => {
    expect(computeDealBadge(input({ hasPrice: false })).kind).toBe('missing_price');
    expect(computeDealBadge(input({ hasArea: false, pricePerSqm: null })).kind).toBe('missing_area');
  });

  it('no benchmark or type mismatch → no_benchmark', () => {
    expect(computeDealBadge(input({ benchmark: null })).kind).toBe('no_benchmark');
    expect(computeDealBadge(input({ typeMatchesBenchmark: false })).kind).toBe('no_benchmark');
  });

  it('our_projects source is exempt from verify_before_offering', () => {
    expect(computeDealBadge(input({ source: 'our_projects' })).verify_before_offering).toBe(false);
    expect(computeDealBadge(input({ source: 'all_projects' })).verify_before_offering).toBe(true);
  });

  it('flags duplicate risk and transaction support honestly', () => {
    const dup = computeDealBadge(input({ benchmark: bench({ duplicate_ratio: 0.6 }) }));
    expect(dup.possible_duplicate).toBe(true);
    const txn = computeDealBadge(input({ benchmark: bench({ has_transaction: true }) }));
    expect(txn.transaction_supported).toBe(true);
    expect(txn.asking_only).toBe(false);
  });
});
