import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readChatForClient, type ReadChatDeps, type FinishArgs } from '../readChat.js';
import type { InboundMsg, ReadStateRow } from '../readState.js';
import type { Conversation } from '../../geoPreference/extractor.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const CLIENT = '11111111-1111-4111-8111-111111111111';
const WID = '966500000000@c.us';
const sb = {} as unknown as SupabaseClient;
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

const msg = (id: string, minAgo: number, body: string | null, extra: Partial<InboundMsg> = {}): InboundMsg => ({
  id, kind: 'text', date: at(minAgo), body, transcript: null, transcript_status: null, media_saved: null, ...extra,
});

const conversation: Conversation = { channel: 'chat', id: WID, turns: [{ speaker: 'client', text: 'أبي فيلا', timestamp: at(3), ref: 'm1' }] };

function fakeDeps(opts: { state?: ReadStateRow | null; inbound: InboundMsg[]; claim?: boolean }) {
  const finishes: FinishArgs[] = [];
  const deps: ReadChatDeps = {
    isLinked: vi.fn(async () => true),
    loadState: vi.fn(async () => opts.state ?? null),
    loadInbound: vi.fn(async () => opts.inbound),
    claim: vi.fn(async () => opts.claim ?? true),
    finish: vi.fn(async (_w: string, _c: string, a: FinishArgs) => { finishes.push(a); return true; }),
    release: vi.fn(async () => {}),
    markGateSkipped: vi.fn(async () => {}),
    gather: vi.fn(async () => conversation),
    analyzeGeo: vi.fn(async () => ({ mode: 'extract' })),
    extractPrefs: vi.fn(async () => ({ proposalId: 'pp1', fieldCount: 2, model: 'deepseek-chat', isFallback: false })),
  };
  return { deps, finishes };
}

const run = (deps: ReadChatDeps, trigger: 'cron' | 'open' | 'manual' = 'cron') =>
  readChatForClient(sb, { clientId: CLIENT, chatWid: WID, trigger, owner: 'test-owner', now: () => NOW, deps });

describe('readChatForClient', () => {
  it('a batch of pleasantries is gate-skipped: both watermarks advance, no model runs, no lease', async () => {
    const { deps } = fakeDeps({ inbound: [msg('m1', 5, 'تمام'), msg('m2', 3, '👍')] });
    const r = await run(deps);
    expect(r.outcome).toBe('gate_skipped');
    expect(deps.markGateSkipped).toHaveBeenCalledWith(WID, CLIENT, at(3), 'cron');
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.analyzeGeo).not.toHaveBeenCalled();
    expect(deps.extractPrefs).not.toHaveBeenCalled();
  });

  it('a partial failure advances ONLY the agent that succeeded', async () => {
    const { deps, finishes } = fakeDeps({ inbound: [msg('m1', 3, 'أبي فيلا بالشمال')] });
    deps.analyzeGeo = vi.fn(async () => { throw new Error('resolver down'); });
    const r = await run(deps);
    expect(r.outcome).toBe('partial');
    expect(r.geo.error).toContain('resolver down');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ geoThrough: null, prefThrough: at(3), outcome: 'partial' });
    expect(finishes[0]!.error).toContain('geo: resolver down');
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('only the agent that is behind runs (after a partial failure)', async () => {
    const state = {
      chat_wid: WID, client_id: CLIENT, geo_read_through: at(10), pref_read_through: at(3), last_read_at: at(2),
      last_trigger: 'cron', last_outcome: 'partial', last_error: null, consecutive_failures: 1,
      lease_owner: null, lease_until: null, updated_at: at(2),
    } satisfies ReadStateRow;
    const { deps, finishes } = fakeDeps({ state, inbound: [msg('m1', 3, 'أبي فيلا بالشمال')] });
    const r = await run(deps);
    expect(r.outcome).toBe('read');
    expect(deps.analyzeGeo).toHaveBeenCalledTimes(1);
    expect(deps.extractPrefs).not.toHaveBeenCalled();
    expect(finishes[0]).toMatchObject({ geoThrough: at(3), prefThrough: null });
  });

  it('geo inside its cool-down (skipped_recent) does not advance the geo watermark', async () => {
    const { deps, finishes } = fakeDeps({ inbound: [msg('m1', 3, 'أبي فيلا')] });
    deps.analyzeGeo = vi.fn(async () => ({ mode: 'skipped_recent' }));
    await run(deps);
    expect(finishes[0]).toMatchObject({ geoThrough: null, prefThrough: at(3), outcome: 'read' });
  });

  it('someone else holds the lease ⇒ not_claimed, nothing runs', async () => {
    const { deps } = fakeDeps({ inbound: [msg('m1', 3, 'أبي فيلا')], claim: false });
    const r = await run(deps);
    expect(r.outcome).toBe('not_claimed');
    expect(deps.gather).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it('releases the lease when finish is never reached, and rethrows', async () => {
    const { deps } = fakeDeps({ inbound: [msg('m1', 3, 'أبي فيلا')] });
    deps.gather = vi.fn(async () => { throw new Error('chat_messages read failed'); });
    await expect(run(deps)).rejects.toThrow('chat_messages read failed');
    expect(deps.release).toHaveBeenCalledWith(WID, CLIENT, 'test-owner');
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it('a failing finish RPC also releases the lease', async () => {
    const { deps } = fakeDeps({ inbound: [msg('m1', 3, 'أبي فيلا')] });
    deps.finish = vi.fn(async () => { throw new Error('rpc down'); });
    await expect(run(deps)).rejects.toThrow('rpc down');
    expect(deps.release).toHaveBeenCalledTimes(1);
  });

  it('nothing unread ⇒ nothing_new (cron / open)', async () => {
    const { deps } = fakeDeps({ inbound: [] });
    expect((await run(deps)).outcome).toBe('nothing_new');
    expect((await run(deps, 'open')).outcome).toBe('nothing_new');
  });

  it('open waits for a voice note that is still being transcribed', async () => {
    const { deps } = fakeDeps({
      inbound: [msg('m1', 3, 'أبي فيلا'), msg('a1', 1, null, { kind: 'audio', transcript_status: 'pending' })],
    });
    expect((await run(deps, 'open')).outcome).toBe('waiting');
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('a transcribed voice note counts as customer text', async () => {
    const { deps, finishes } = fakeDeps({
      inbound: [msg('a1', 2, null, { kind: 'audio', transcript: 'ابي فلة في حي النرجس', transcript_status: 'done' })],
    });
    const r = await run(deps);
    expect(r.outcome).toBe('read');
    expect(finishes[0]).toMatchObject({ prefThrough: at(2) });
  });

  it('manual bypasses the gate and runs both agents', async () => {
    const { deps } = fakeDeps({ inbound: [msg('m1', 3, 'تمام')] });
    const r = await run(deps, 'manual');
    expect(r.outcome).toBe('read');
    expect(deps.markGateSkipped).not.toHaveBeenCalled();
    expect(deps.analyzeGeo).toHaveBeenCalled();
    expect(deps.extractPrefs).toHaveBeenCalled();
  });

  it('refuses a chat that is not linked to the client', async () => {
    const { deps } = fakeDeps({ inbound: [msg('m1', 3, 'أبي فيلا')] });
    deps.isLinked = vi.fn(async () => false);
    await expect(run(deps, 'manual')).rejects.toMatchObject({ status: 404 });
  });
});
