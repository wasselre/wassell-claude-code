/**
 * The paid lane's pure pieces: the creative key that sums a feed ad with its
 * story (E2), the seven-day judging window (E4), and the lead counting that
 * turns attributed WhatsApp messages into "our leads" (E3).
 *
 * These are small functions that decide money, which is exactly the shape of
 * thing that gets refactored by someone who does not know why the `?? id`
 * fallback is there.
 */
import { describe, expect, it } from 'vitest';
import { addDays, auditionWindow, creativeKeyOf } from '../../runRefreshCycleJob.js';
import { leadsByAd, leadsInWindow, riyadhDay, type OurLead } from '../ourLeads.js';

describe('creativeKeyOf — one creative, two Meta ads (E2)', () => {
  it('gives a feed ad and its story shadow the SAME key', () => {
    // Live shape, C-042 ربوة الرمز: the feed row is self-paired and the story
    // row carries the feed row's id.
    const feed = { id: 'feed-1', pair_id: 'feed-1' };
    const story = { id: 'story-1', pair_id: 'feed-1' };
    expect(creativeKeyOf(feed)).toBe('feed-1');
    expect(creativeKeyOf(story)).toBe('feed-1');
  });

  it('falls back to the row id for pre-2026-09-07 ads that have no pair', () => {
    // Every ad on the أكنان and تل الربوة executions is this shape. Without the
    // fallback they would all collapse onto a single null key and be summed
    // together — one creative with the whole campaign's spend.
    expect(creativeKeyOf({ id: 'legacy-1', pair_id: null })).toBe('legacy-1');
    expect(creativeKeyOf({ id: 'legacy-2', pair_id: null })).toBe('legacy-2');
  });
});

describe('auditionWindow — its own first seven days (E4)', () => {
  const cycle = { since: '2026-10-01', until: '2026-10-21' };

  it('is the seven days from activation, not the calendar week', () => {
    expect(auditionWindow('2026-10-04T09:00:00Z', cycle)).toEqual({ since: '2026-10-04', until: '2026-10-10' });
    expect(auditionWindow('2026-10-11T23:59:00Z', cycle)).toEqual({ since: '2026-10-11', until: '2026-10-17' });
  });

  it('is clipped at the decision date, so a young ad is judged on what exists', () => {
    // Activated three days before the decision: three days of data, which keeps
    // it under the spend gate, which makes it unranked — neither winner nor
    // loser. That is the intended outcome, not a gap.
    expect(auditionWindow('2026-10-19T00:00:00Z', cycle)).toEqual({ since: '2026-10-19', until: '2026-10-21' });
  });

  it('falls back to the cycle window when there is no activation stamp', () => {
    expect(auditionWindow(null, cycle)).toEqual(cycle);
    expect(auditionWindow('not-a-date', cycle)).toEqual(cycle);
  });

  it('falls back rather than invent a backwards range', () => {
    expect(auditionWindow('2026-11-01T00:00:00Z', cycle)).toEqual(cycle);
  });
});

describe('addDays', () => {
  it('crosses a month and a year boundary', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-09-06', 6)).toBe('2026-09-12');
  });
});

describe('leadsInWindow — one conversation is one lead (E3)', () => {
  const lead = (adRowId: string, conversationKey: string, day: string): OurLead =>
    ({ adRowId, conversationKey, day, at: `${day}T12:00:00Z`, platformAdId: null });

  it('counts conversations inside the window, inclusive at both ends', () => {
    const leads = [
      lead('a', 'chat-1', '2026-09-06'),
      lead('a', 'chat-2', '2026-09-12'),
      lead('a', 'chat-3', '2026-09-13'),   // one day late
      lead('a', 'chat-4', '2026-09-05'),   // one day early
    ];
    expect(leadsInWindow(leads, '2026-09-06', '2026-09-12')).toBe(2);
  });

  it('counts one person once across a feed ad and its story', () => {
    // The whole point of summing on the creative key: the same conversation
    // arriving through both halves of one creative is one lead, not two.
    const leads = [
      lead('feed-1', 'chat-1', '2026-09-08'),
      lead('story-1', 'chat-1', '2026-09-08'),
      lead('story-1', 'chat-2', '2026-09-09'),
    ];
    expect(leadsInWindow(leads, '2026-09-06', '2026-09-12')).toBe(2);
  });

  it('is zero, not an error, when nothing arrived', () => {
    expect(leadsInWindow([], '2026-09-06', '2026-09-12')).toBe(0);
  });
});

describe('leadsByAd', () => {
  it('groups without losing anything', () => {
    const leads: OurLead[] = [
      { adRowId: 'a', conversationKey: 'c1', day: '2026-09-06', at: '2026-09-06T00:00:00Z', platformAdId: null },
      { adRowId: 'b', conversationKey: 'c2', day: '2026-09-06', at: '2026-09-06T00:00:00Z', platformAdId: null },
      { adRowId: 'a', conversationKey: 'c3', day: '2026-09-07', at: '2026-09-07T00:00:00Z', platformAdId: null },
    ];
    const grouped = leadsByAd(leads);
    expect(grouped.get('a')).toHaveLength(2);
    expect(grouped.get('b')).toHaveLength(1);
    expect([...grouped.keys()].sort()).toEqual(['a', 'b']);
  });
});

describe('riyadhDay — the calendar the spend is dated in', () => {
  it('moves a late-evening UTC message into the next Riyadh day', () => {
    // Riyadh is UTC+3 and does not observe DST. 22:00 UTC is 01:00 the next
    // morning locally, which is the day Meta will have billed it under.
    expect(riyadhDay('2026-09-06T22:00:00Z')).toBe('2026-09-07');
    expect(riyadhDay('2026-09-06T20:59:59Z')).toBe('2026-09-06');
  });

  it('degrades to the date part rather than throwing on a bad timestamp', () => {
    expect(riyadhDay('2026-09-06')).toBe('2026-09-06');
  });
});
