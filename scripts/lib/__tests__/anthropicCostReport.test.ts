/**
 * Tests for the Anthropic cost-report parser.
 *
 * The fixture below is the example response from Anthropic's API reference,
 * copied verbatim — so these tests fail if the real shape stops matching what
 * the code was written against, rather than only if my own logic drifts.
 *
 * The case that matters most is the unit conversion. `amount` is a decimal
 * string in CENTS; reading it as dollars inflates every figure by 100x, and an
 * error that large in a cost report gets believed.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs module, no type declarations by design
import { normalizeCostItem, parseCostReportPage, sumDays, buildCostReportUrl, CENTS_PER_DOLLAR } from '../anthropicCostReport.mjs';

/** Verbatim from platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve */
const REFERENCE_RESPONSE = {
  data: [
    {
      ending_at: '2025-08-02T00:00:00Z',
      results: [
        {
          amount: '123.78912',
          context_window: '0-200k',
          cost_type: 'tokens',
          currency: 'USD',
          description: 'Claude Opus 5 Usage - Input Tokens',
          inference_geo: 'global',
          model: 'claude-opus-5',
          service_tier: 'standard',
          token_type: 'uncached_input_tokens',
          workspace_id: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ',
        },
      ],
      starting_at: '2025-08-01T00:00:00Z',
    },
  ],
  has_more: true,
  next_page: 'page_MjAyNS0wNS0xNFQwMDowMDowMFo=',
};

describe('unit conversion', () => {
  it('reads `amount` as CENTS, not dollars', () => {
    // The reference doc states "123.45" in USD represents $1.23.
    expect(normalizeCostItem({ amount: '123.45', currency: 'USD' })!.amount_usd).toBeCloseTo(1.2345, 10);
    expect(CENTS_PER_DOLLAR).toBe(100);
  });

  it('keeps sub-cent precision rather than rounding to cents', () => {
    // Anthropic returns five decimal places; truncating here would lose real
    // money across thousands of line items.
    expect(normalizeCostItem({ amount: '123.78912' })!.amount_usd).toBeCloseTo(1.2378912, 10);
  });

  it('accepts a numeric amount as well as a string', () => {
    expect(normalizeCostItem({ amount: 250 })!.amount_usd).toBeCloseTo(2.5, 10);
  });

  it('returns null for an unreadable amount instead of contributing zero', () => {
    // A silent zero would understate a total somebody acts on; null lets the
    // caller count and report the gap.
    expect(normalizeCostItem({ amount: 'not-a-number' })).toBeNull();
    expect(normalizeCostItem({ amount: null })).toBeNull();
    expect(normalizeCostItem({})).toBeNull();
    expect(normalizeCostItem(null)).toBeNull();
  });

  it('carries the vendor item through untouched for auditing', () => {
    const item = { amount: '100', model: 'claude-opus-5', cost_type: 'tokens' };
    expect(normalizeCostItem(item)!.raw).toBe(item);
  });
});

describe('parseCostReportPage', () => {
  it('parses the reference response', () => {
    const page = parseCostReportPage(REFERENCE_RESPONSE);
    expect(page.days).toHaveLength(1);
    expect(page.days[0]!.day).toBe('2025-08-01');
    expect(page.days[0]!.rows).toHaveLength(1);
    expect(page.days[0]!.rows[0]).toMatchObject({
      model: 'claude-opus-5',
      cost_type: 'tokens',
      token_type: 'uncached_input_tokens',
      service_tier: 'standard',
      currency: 'USD',
    });
    expect(page.days[0]!.rows[0]!.amount_usd).toBeCloseTo(1.2378912, 10);
  });

  it('takes the day from starting_at, not ending_at', () => {
    // The bucket spans Aug 1 → Aug 2; it is Aug 1's cost. Using ending_at
    // would shift every row one day forward and quietly misalign the whole
    // reconciliation.
    expect(parseCostReportPage(REFERENCE_RESPONSE).days[0]!.day).toBe('2025-08-01');
  });

  it('surfaces pagination', () => {
    const page = parseCostReportPage(REFERENCE_RESPONSE);
    expect(page.hasMore).toBe(true);
    expect(page.nextPage).toBe('page_MjAyNS0wNS0xNFQwMDowMDowMFo=');

    const last = parseCostReportPage({ data: [], has_more: false, next_page: null });
    expect(last.hasMore).toBe(false);
    expect(last.nextPage).toBeNull();
  });

  it('keeps an empty bucket as a real day with zero rows', () => {
    // "the vendor charged nothing" and "we never asked" are different facts;
    // the empty day must still replace whatever was stored for it.
    const page = parseCostReportPage({
      data: [{ starting_at: '2026-09-10T00:00:00Z', ending_at: '2026-09-11T00:00:00Z', results: [] }],
      has_more: false,
    });
    expect(page.days).toHaveLength(1);
    expect(page.days[0]!.rows).toEqual([]);
  });

  it('counts unreadable items instead of dropping them silently', () => {
    const page = parseCostReportPage({
      data: [{
        starting_at: '2026-09-10T00:00:00Z',
        results: [{ amount: '100' }, { amount: 'broken' }, { amount: '50' }],
      }],
      has_more: false,
    });
    expect(page.days[0]!.rows).toHaveLength(2);
    expect(page.days[0]!.skipped).toBe(1);
  });

  it('throws on a response that is not a cost report', () => {
    expect(() => parseCostReportPage({})).toThrow(/no `data` array/);
    expect(() => parseCostReportPage({ data: [{ results: [] }] })).toThrow(/starting_at/);
  });

  it('sums a page in dollars', () => {
    const page = parseCostReportPage({
      data: [{ starting_at: '2026-09-10T00:00:00Z', results: [{ amount: '1000' }, { amount: '500' }] }],
      has_more: false,
    });
    expect(sumDays(page.days)).toBeCloseTo(15, 10); // 1500 cents
  });
});

describe('buildCostReportUrl', () => {
  it('requests daily buckets grouped by description', () => {
    const url = buildCostReportUrl({ startingAt: '2026-09-01T00:00:00Z', endingAt: '2026-09-15T00:00:00Z' });
    expect(url).toContain('https://api.anthropic.com/v1/organizations/cost_report?');
    expect(url).toContain('starting_at=2026-09-01T00%3A00%3A00Z');
    expect(url).toContain('bucket_width=1d');
    // Without group_by=description there is no model / cost_type breakdown,
    // and reconciliation collapses to one opaque number per day.
    expect(url).toContain('group_by%5B%5D=description');
  });

  it('carries the page cursor when continuing', () => {
    expect(buildCostReportUrl({ startingAt: '2026-09-01T00:00:00Z', page: 'page_abc' })).toContain('page=page_abc');
    expect(buildCostReportUrl({ startingAt: '2026-09-01T00:00:00Z' })).not.toContain('page=');
  });
});
