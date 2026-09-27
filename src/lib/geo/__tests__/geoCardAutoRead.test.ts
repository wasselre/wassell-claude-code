import { describe, it, expect } from 'vitest';
import { shouldAutoRead, type AutoReadInput } from '../geoCardAutoRead';

const base: AutoReadInput = { graded: false, can_reanalyze: true, unread_customer_messages: 0 };

describe('shouldAutoRead', () => {
  it('reads as soon as the customer has written something unread — even one message', () => {
    expect(shouldAutoRead({ ...base, unread_customer_messages: 1 })).toBe(true);
    expect(shouldAutoRead({ ...base, unread_customer_messages: 12 })).toBe(true);
  });
  it('does nothing when nothing new was said', () => {
    expect(shouldAutoRead(base)).toBe(false);
  });
  it('never on graded evidence or inside the server cool-down', () => {
    expect(shouldAutoRead({ ...base, unread_customer_messages: 5, graded: true })).toBe(false);
    expect(shouldAutoRead({ ...base, unread_customer_messages: 5, can_reanalyze: false })).toBe(false);
  });
});
