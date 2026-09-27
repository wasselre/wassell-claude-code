import { describe, it, expect } from 'vitest';
import { shouldAutoRead, AUTO_READ_MIN_CUSTOMER_MESSAGES, AUTO_REREAD_MIN_GAP_MS, type AutoReadInput } from '../geoCardAutoRead';

const NOW = new Date('2026-09-27T12:00:00Z');
const base: AutoReadInput = {
  status: 'pending', stale: false, graded: false, can_reanalyze: true,
  analyzed_at: '2026-09-27T09:00:00Z', customer_messages: 10,
};

describe('shouldAutoRead', () => {
  it('reads a never-read chat once the customer has written enough', () => {
    expect(shouldAutoRead({ ...base, status: 'none', analyzed_at: null, customer_messages: AUTO_READ_MIN_CUSTOMER_MESSAGES }, NOW)).toBe(true);
    expect(shouldAutoRead({ ...base, status: 'none', analyzed_at: null, customer_messages: AUTO_READ_MIN_CUSTOMER_MESSAGES - 1 }, NOW)).toBe(false);
  });
  it('re-reads when the customer wrote since, but not more than once an hour', () => {
    expect(shouldAutoRead({ ...base, stale: true }, NOW)).toBe(true); // 3 h old
    const recent = new Date(NOW.getTime() - AUTO_REREAD_MIN_GAP_MS + 60_000).toISOString();
    expect(shouldAutoRead({ ...base, stale: true, analyzed_at: recent }, NOW)).toBe(false);
  });
  it('does nothing when nothing new was said', () => {
    expect(shouldAutoRead(base, NOW)).toBe(false);
  });
  it('never on graded evidence, inside the cool-down, or with an unknown reading time', () => {
    expect(shouldAutoRead({ ...base, stale: true, graded: true }, NOW)).toBe(false);
    expect(shouldAutoRead({ ...base, stale: true, can_reanalyze: false }, NOW)).toBe(false);
    expect(shouldAutoRead({ ...base, status: 'none', can_reanalyze: false, customer_messages: 50 }, NOW)).toBe(false);
    expect(shouldAutoRead({ ...base, stale: true, analyzed_at: null }, NOW)).toBe(false);
  });
});
