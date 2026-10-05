import { describe, it, expect } from 'vitest';
import { quoteFragments, messagesMatching, messagesBefore, type ReviewMessage } from '../reviewHighlight';

const msgs: ReviewMessage[] = [
  { id: 'a', flow: 'in', date: '2026-10-05T12:00:00Z', body: 'متوفر ادوار بنفس مساحة التاون هاوس لكن بوسط الرياض' },
  { id: 'b', flow: 'out', date: '2026-10-05T12:01:00Z', body: 'أقرب شي عندنا جزيل في السليمانية' },
  { id: 'c', flow: 'in', date: '2026-10-05T12:30:00Z', body: 'ابغى يلي بالسليمانية امس كلمتني عنه' },
  { id: 'd', flow: 'in', date: '2026-10-05T12:40:00Z', body: null, transcript: 'ميزانيتي ثلاثة ملايين' },
];

describe('quoteFragments', () => {
  it('splits a joined quote and drops tiny pieces', () => {
    expect(quoteFragments('ابغى ادوار... ابغى يلي بالسليمانية')).toEqual(['ابغي ادوار', 'ابغي يلي بالسليمانيه']);
    expect(quoteFragments('«لا» «بوسط الرياض»')).toEqual(['بوسط الرياض']);
    expect(quoteFragments(null)).toEqual([]);
  });
});

describe('messagesMatching', () => {
  it('finds the customer message a quote came from (folding ة/ه)', () => {
    expect([...messagesMatching(msgs, quoteFragments('بنفس مساحة التاون هاوس'))]).toEqual(['a']);
  });
  it('reads voice-note transcripts', () => {
    expect([...messagesMatching(msgs, ['ثلاثة ملايين'])]).toEqual(['d']);
  });
  it('prefers the customer’s own mention of a place', () => {
    expect([...messagesMatching(msgs, ['السليمانية'], true)]).toEqual(['c']);
    expect([...messagesMatching(msgs, ['السليمانية'])].sort()).toEqual(['b', 'c']);
  });
  it('falls back to the whole chat when the customer never said it', () => {
    expect([...messagesMatching(msgs, ['جزيل'], true)]).toEqual(['b']);
  });
  it('matches nothing for empty needles', () => {
    expect(messagesMatching(msgs, ['', 'ab']).size).toBe(0);
  });
});

describe('messagesBefore', () => {
  it('takes the messages leading up to a booking', () => {
    expect([...messagesBefore(msgs, '2026-10-05T12:41:00Z')].sort()).toEqual(['c', 'd']);
  });
});
