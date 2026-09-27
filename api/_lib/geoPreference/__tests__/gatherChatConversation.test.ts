import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { gatherChatConversation, VOICE_NOTE_PREFIX } from '../backfillPorts.js';

type Row = { id: string; flow: 'in' | 'out'; kind: string; body: string | null; transcript: string | null; date: string };

/** A minimal chainable PostgREST fake for chat_messages that honours order + limit. */
function fakeSupabase(rows: Row[]) {
  const calls: { order?: { col: string; ascending: boolean }; limit?: number } = {};
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: (col: string, o: { ascending: boolean }) => { calls.order = { col, ascending: o.ascending }; return builder; },
    limit: (n: number) => {
      calls.limit = n;
      const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
      if (calls.order && !calls.order.ascending) sorted.reverse();
      return Promise.resolve({ data: sorted.slice(0, n), error: null });
    },
  };
  return { sb: { from: () => builder } as unknown as SupabaseClient, calls };
}

const iso = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();

describe('gatherChatConversation', () => {
  it('reads the NEWEST 120 messages, returned oldest-first', async () => {
    const rows: Row[] = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`, flow: i % 2 ? 'in' : 'out', kind: 'text', body: `msg ${i}`, transcript: null, date: iso(i),
    }));
    const { sb, calls } = fakeSupabase(rows);
    const c = await gatherChatConversation(sb, 'w@c.us');
    expect(calls.order).toEqual({ col: 'date', ascending: false });
    expect(calls.limit).toBe(120);
    expect(c?.turns).toHaveLength(120);
    expect(c?.turns[0]?.ref).toBe('m80');
    expect(c?.turns[119]?.ref).toBe('m199'); // the newest customer message is read
  });

  it('renders a transcribed inbound voice note as a customer line', async () => {
    const { sb } = fakeSupabase([
      { id: 'a', flow: 'out', kind: 'text', body: 'هلا', transcript: null, date: iso(1) },
      { id: 'b', flow: 'in', kind: 'audio', body: null, transcript: 'ابي فيلا في الشمال', date: iso(2) },
      { id: 'c', flow: 'in', kind: 'audio', body: null, transcript: null, date: iso(3) },
    ]);
    const c = await gatherChatConversation(sb, 'w@c.us');
    expect(c?.turns.map((t) => [t.speaker, t.text])).toEqual([
      ['agent', 'هلا'],
      ['client', `${VOICE_NOTE_PREFIX} ابي فيلا في الشمال`],
    ]);
  });

  it('an agent-only thread is null (nothing to interpret)', async () => {
    const { sb } = fakeSupabase([{ id: 'a', flow: 'out', kind: 'text', body: 'عرض', transcript: null, date: iso(1) }]);
    expect(await gatherChatConversation(sb, 'w@c.us')).toBeNull();
  });
});
