import { describe, it, expect } from 'vitest';
import {
  decideDue, selectDueChats, backoffMs, SETTLE_MS, MAX_WAIT_MS, MAX_CONSECUTIVE_FAILURES, type ReadCandidate,
} from '../dueSelection.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function cand(over: Partial<ReadCandidate> = {}): ReadCandidate {
  return {
    chat_wid: '966500000000@c.us', client_id: '11111111-1111-4111-8111-111111111111',
    newest_in_at: ago(120_000), oldest_unread_at: ago(180_000),
    unread_count: 1, unread_bodies: ['أبي فيلا في الشمال'],
    pending_transcripts: 0, unread_voice_untranscribed: 0,
    lease_until: null, consecutive_failures: 0, last_attempt_at: null,
    ...over,
  };
}

describe('decideDue — settle and cap', () => {
  it('a burst is read once it settles: due at 90 s, not at the median 42 s gap', () => {
    expect(decideDue(cand({ newest_in_at: ago(42_000), oldest_unread_at: ago(60_000) }), NOW))
      .toEqual({ due: false, reason: 'not_settled' });
    expect(decideDue(cand({ newest_in_at: ago(SETTLE_MS), oldest_unread_at: ago(SETTLE_MS) }), NOW))
      .toEqual({ due: true });
  });
  it('a customer who keeps typing is read anyway once the oldest unread is 10 min old', () => {
    expect(decideDue(cand({ newest_in_at: ago(5_000), oldest_unread_at: ago(MAX_WAIT_MS) }), NOW)).toEqual({ due: true });
    expect(decideDue(cand({ newest_in_at: ago(5_000), oldest_unread_at: ago(MAX_WAIT_MS - 1_000) }), NOW))
      .toEqual({ due: false, reason: 'not_settled' });
  });
});

describe('decideDue — voice notes, lease, gate, backoff', () => {
  it('holds while a voice note is being transcribed, until the cap', () => {
    expect(decideDue(cand({ pending_transcripts: 1 }), NOW)).toEqual({ due: false, reason: 'transcribing' });
    expect(decideDue(cand({ pending_transcripts: 1, oldest_unread_at: ago(MAX_WAIT_MS) }), NOW)).toEqual({ due: true });
  });
  it('only a capped voice note and no unread text ⇒ nothing to read (gate)', () => {
    expect(decideDue(cand({ unread_count: 0, unread_bodies: [], oldest_unread_at: null, newest_in_at: null, pending_transcripts: 1 }), NOW))
      .toEqual({ due: false, reason: 'transcribing' });
    expect(decideDue(cand({ unread_count: 0, unread_bodies: [], oldest_unread_at: null, newest_in_at: null, pending_transcripts: 0 }), NOW))
      .toEqual({ due: false, reason: 'gate' });
  });
  it('a live lease skips the chat; an expired one does not', () => {
    expect(decideDue(cand({ lease_until: new Date(NOW.getTime() + 60_000).toISOString() }), NOW)).toEqual({ due: false, reason: 'leased' });
    expect(decideDue(cand({ lease_until: ago(1_000) }), NOW)).toEqual({ due: true });
  });
  it('a settled batch of pleasantries is gated', () => {
    expect(decideDue(cand({ unread_bodies: ['تمام', 'شكرا'], unread_count: 2 }), NOW)).toEqual({ due: false, reason: 'gate' });
  });
  it('failures back off exponentially and stop after the ceiling', () => {
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(decideDue(cand({ consecutive_failures: 1, last_attempt_at: ago(60_000) }), NOW)).toEqual({ due: false, reason: 'backoff' });
    expect(decideDue(cand({ consecutive_failures: 1, last_attempt_at: ago(121_000) }), NOW)).toEqual({ due: true });
    expect(decideDue(cand({ consecutive_failures: MAX_CONSECUTIVE_FAILURES, last_attempt_at: ago(86_400_000) }), NOW))
      .toEqual({ due: false, reason: 'backoff' });
  });
});

describe('selectDueChats', () => {
  it('partitions and keeps input order in every bucket', () => {
    const a = cand({ chat_wid: 'a@c.us' });
    const b = cand({ chat_wid: 'b@c.us', newest_in_at: ago(10_000), oldest_unread_at: ago(10_000) });
    const c = cand({ chat_wid: 'c@c.us' });
    const d = cand({ chat_wid: 'd@c.us', unread_bodies: ['👍'] });
    const e = cand({ chat_wid: 'e@c.us', lease_until: new Date(NOW.getTime() + 1_000).toISOString() });
    const sel = selectDueChats([a, b, c, d, e], NOW);
    expect(sel.due.map((x) => x.chat_wid)).toEqual(['a@c.us', 'c@c.us']);
    expect(sel.waiting.map((x) => x.chat_wid)).toEqual(['b@c.us']);
    expect(sel.gated.map((x) => x.chat_wid)).toEqual(['d@c.us']);
    expect(sel.leased.map((x) => x.chat_wid)).toEqual(['e@c.us']);
    expect(sel.backoff).toEqual([]);
  });
});
