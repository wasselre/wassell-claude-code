import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { gatherCallConversation, buildCallConversation } from '../backfillPorts.js';

const CALL = '22222222-2222-4222-8222-222222222222';

type Tables = {
  models?: { id: string } | null;
  unified_records?: { id: string; data: Record<string, unknown> } | null;
  call_logs?: { id: string; direction: string | null; transcription: unknown; creation_time: string | null } | null;
  errorOn?: string;
};

/** A minimal chainable PostgREST fake: each table resolves to ONE row via maybeSingle(). */
function fakeSupabase(t: Tables): SupabaseClient {
  return {
    from: (table: keyof Tables) => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve(
          t.errorOn === table
            ? { data: null, error: { message: `${table} boom` } }
            : { data: t[table] ?? null, error: null },
        ),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

// Diarized words where the agent introduces the company (self_intro) — ch_1 is our side here.
const DIARIZED = {
  words: [
    { text: 'السلام', start: 0.1, speaker: 'ch_0' },
    { text: 'عليكم', start: 0.4, speaker: 'ch_0' },
    { text: 'معك', start: 1.0, speaker: 'ch_1' },
    { text: 'فهد', start: 1.2, speaker: 'ch_1' },
    { text: 'من', start: 1.4, speaker: 'ch_1' },
    { text: 'وصل', start: 1.6, speaker: 'ch_1' },
    { text: 'العقارية', start: 1.8, speaker: 'ch_1' },
    { text: 'أبي', start: 3.0, speaker: 'ch_0' },
    { text: 'فيلا', start: 3.2, speaker: 'ch_0' },
  ],
};

describe('gatherCallConversation', () => {
  it('builds speaker-labelled turns from the diarized call_logs words', async () => {
    const sb = fakeSupabase({
      models: { id: 'pc-model' },
      unified_records: { id: CALL, data: { call_time: '2026-09-20T10:00:00', transcription_text: 'flat', direction: 'inbound' } },
      call_logs: { id: CALL, direction: 'inbound', transcription: DIARIZED, creation_time: '2026-09-20T10:00:00Z' },
    });
    const c = await gatherCallConversation(sb, CALL);
    expect(c?.channel).toBe('call');
    expect(c?.id).toBe(CALL);
    expect(c?.speaker_labels).toBe('self_intro');
    expect(c?.turns.map((t) => t.speaker)).toEqual(['client', 'agent', 'client']);
    expect(c?.turns.every((t) => t.ref === CALL)).toBe(true);
  });

  it('no diarized words ⇒ the flattened text, UNLABELLED (speaker_labels none)', async () => {
    const sb = fakeSupabase({
      models: { id: 'pc-model' },
      unified_records: { id: CALL, data: { call_time: '2026-09-20T10:00:00', transcription_text: 'أبي فيلا' } },
      call_logs: null,
    });
    const c = await gatherCallConversation(sb, CALL);
    expect(c?.speaker_labels).toBe('none');
    expect(c?.turns).toHaveLength(1);
    expect(c?.turns[0]?.speaker).toBe('unknown');
    // call_time is UTC without a suffix — normalised, not read as local time.
    expect(c?.turns[0]?.timestamp).toBe('2026-09-20T10:00:00.000Z');
  });

  it('nothing to read ⇒ null', async () => {
    const sb = fakeSupabase({ models: { id: 'pc-model' }, unified_records: null, call_logs: null });
    expect(await gatherCallConversation(sb, CALL)).toBeNull();
  });

  it('a read error THROWS — never "this call is empty"', async () => {
    const sb = fakeSupabase({ models: { id: 'pc-model' }, errorOn: 'call_logs' });
    await expect(gatherCallConversation(sb, CALL)).rejects.toThrow(/call_logs read .* failed: call_logs boom/);
  });

  it('buildCallConversation is the same builder the per-client gather uses', () => {
    const c = buildCallConversation(
      { id: CALL, ts: '', text: '', direction: 'inbound' },
      { direction: 'inbound', transcription: DIARIZED, creation_time: '2026-09-20T10:00:00Z' },
    );
    expect(c?.speaker_labels).toBe('self_intro');
    expect(buildCallConversation({ id: CALL, ts: '', text: '', direction: null }, null)).toBeNull();
  });
});
