import { describe, it, expect } from 'vitest';
import { customerSaidIt } from '../quoteMatch.js';
import type { Conversation } from '../../geoPreference/extractor.js';

const conv: Conversation = {
  channel: 'chat', id: 'w',
  turns: [
    { speaker: 'client', text: 'ميزانيتي حدود مليون ونص' },
    { speaker: 'agent', text: 'تبيها جاهزة ولا على الخارطة؟' },
    { speaker: 'client', text: 'جاهز او على الخارطة ما يفرق، المهم ما تتعدى ٣ مليون' },
  ],
};

describe('customerSaidIt — a quote joined from two customer messages (live test 2026-10-05)', () => {
  it('accepts « / » or « | » between parts the customer really said', () => {
    expect(customerSaidIt(conv, 'ميزانيتي حدود مليون ونص / المهم ما تتعدى ٣ مليون')).toBe(true);
    expect(customerSaidIt(conv, 'ميزانيتي حدود مليون ونص | جاهز او على الخارطة ما يفرق')).toBe(true);
  });
  it('still refuses when any part is the salesperson’s words', () => {
    expect(customerSaidIt(conv, 'ميزانيتي حدود مليون ونص / تبيها جاهزة ولا على الخارطة')).toBe(false);
  });
});
