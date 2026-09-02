import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runBackfillBatch, readBackfillConfig, type BackfillKindHandler } from '../backfill';

interface RpcCall { name: string; params: Record<string, unknown> }

/** Fake Supabase: one mos_settings row (creative_backfill) + the two run RPCs. */
function fakeSb(config: Record<string, unknown>): { sb: SupabaseClient; rpcs: RpcCall[] } {
  const rpcs: RpcCall[] = [];
  const sb = {
    from: (table: string) => {
      if (table !== 'mos_settings') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { value: config }, error: null }),
          }),
        }),
      };
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (name === 'creative_backfill_run_start') return { data: 'run-1', error: null };
      if (name === 'creative_backfill_run_finish') return { data: null, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  } as unknown as SupabaseClient;
  return { sb, rpcs };
}

function handler(overrides: Partial<BackfillKindHandler<string>> = {}): BackfillKindHandler<string> & { fetches: Array<{ tier: number; limit: number; pilotIds: string[] }> } {
  const fetches: Array<{ tier: number; limit: number; pilotIds: string[] }> = [];
  return {
    kind: 'design_reads',
    fetches,
    async fetchTargets(args) { fetches.push(args); return []; },
    async processBatch() { return { processed: 0, failed: 0, costUsd: 0 }; },
    ...overrides,
  };
}

const deps = (sb: SupabaseClient) => ({ sb, workerId: 'test-worker' });

afterEach(() => vi.restoreAllMocks());

describe('readBackfillConfig', () => {
  it('parses the kind config with defaults', async () => {
    const { sb } = fakeSb({ design_reads: { enabled: true, lane: 'runner', batch_size: 10, tiers: [1, 2] } });
    const cfg = await readBackfillConfig(sb, 'design_reads');
    expect(cfg.enabled).toBe(true);
    expect(cfg.lane).toBe('runner');
    expect(cfg.batch_size).toBe(10);
    expect(cfg.tiers).toEqual([1, 2]);
    expect(cfg.paused_at).toBeNull();
    expect(cfg.pilot_ids).toEqual([]);
  });

  it('treats a missing kind as disabled', async () => {
    const { sb } = fakeSb({});
    const cfg = await readBackfillConfig(sb, 'design_reads');
    expect(cfg.enabled).toBe(false);
  });
});

describe('runBackfillBatch', () => {
  it('skips when disabled', async () => {
    const { sb } = fakeSb({ design_reads: { enabled: false } });
    const h = handler();
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.skipped).toBe('disabled');
    expect(h.fetches).toHaveLength(0);
  });

  it('skips when paused (interruptible per batch)', async () => {
    const { sb } = fakeSb({ design_reads: { enabled: true, paused_at: '2026-09-02T00:00:00Z' } });
    const h = handler();
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.skipped).toBe('paused');
    expect(h.fetches).toHaveLength(0);
  });

  it('walks tiers in order and reports no_targets when every tier is empty', async () => {
    const { sb } = fakeSb({ design_reads: { enabled: true, tiers: [1, 2, 3] } });
    const h = handler();
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.skipped).toBe('no_targets');
    expect(h.fetches.map((f) => f.tier)).toEqual([1, 2, 3]);
  });

  it('stops the tier walk at the first non-empty tier and runs a run row', async () => {
    const { sb, rpcs } = fakeSb({ design_reads: { enabled: true, lane: 'runner', tiers: [1, 2, 3], batch_size: 5 } });
    const h = handler({
      async fetchTargets(args) { return args.tier === 2 ? ['a', 'b'] : []; },
      async processBatch(targets) { return { processed: targets.length, failed: 0, costUsd: 0 }; },
    });
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.skipped).toBeNull();
    expect(r.tier).toBe(2);
    expect(r.target_count).toBe(2);
    expect(r.processed).toBe(2);
    expect(r.run_id).toBe('run-1');
    const start = rpcs.find((c) => c.name === 'creative_backfill_run_start');
    const finish = rpcs.find((c) => c.name === 'creative_backfill_run_finish');
    expect(start?.params).toMatchObject({ p_kind: 'design_reads', p_tier: 2, p_worker_id: 'test-worker' });
    expect(finish?.params).toMatchObject({ p_run_id: 'run-1', p_status: 'completed', p_processed: 2, p_failed: 0 });
  });

  it('pilot mode: only pilot_ids, tier 0', async () => {
    const { sb } = fakeSb({ design_reads: { enabled: true, lane: 'runner', pilot_ids: ['p1', 'p2'] } });
    const fetches: Array<{ tier: number; limit: number; pilotIds: string[] }> = [];
    const h = handler({
      async fetchTargets(args) { fetches.push(args); return ['p1']; },
      async processBatch() { return { processed: 1, failed: 0, costUsd: 0 }; },
    });
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.pilot).toBe(true);
    expect(r.tier).toBe(0);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].pilotIds).toEqual(['p1', 'p2']);
  });

  it('cost gate: worker lane refuses loudly when approved < estimate', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sb, rpcs } = fakeSb({
      design_reads: { enabled: true, lane: 'worker', batch_size: 24, approved_cost_usd: 0.01, estimated_cost_per_item: 0.01 },
    });
    const h = handler({ async fetchTargets() { return ['a', 'b', 'c']; } });
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.skipped).toBe('cost_gate');
    expect(r.estimated_cost_usd).toBeCloseTo(0.03);
    expect(errSpy).toHaveBeenCalled();
    expect(rpcs.find((c) => c.name === 'creative_backfill_run_start')).toBeUndefined(); // no run opened
  });

  it('cost gate does not apply to the runner lane (no per-item meter)', async () => {
    const { sb } = fakeSb({
      design_reads: { enabled: true, lane: 'runner', approved_cost_usd: 0, estimated_cost_per_item: 0.01 },
    });
    const h = handler({
      async fetchTargets() { return ['a']; },
      async processBatch() { return { processed: 1, failed: 0, costUsd: 0 }; },
    });
    const r = await runBackfillBatch(h, deps(sb));
    expect(r.skipped).toBeNull();
    expect(r.processed).toBe(1);
  });

  it('marks the run failed and rethrows when processing throws', async () => {
    const { sb, rpcs } = fakeSb({ design_reads: { enabled: true, lane: 'runner' } });
    const h = handler({
      async fetchTargets() { return ['a']; },
      async processBatch() { throw new Error('provider:anthropic boom'); },
    });
    await expect(runBackfillBatch(h, deps(sb))).rejects.toThrow(/provider:anthropic boom/);
    const finish = rpcs.find((c) => c.name === 'creative_backfill_run_finish');
    expect(finish?.params).toMatchObject({ p_run_id: 'run-1', p_status: 'failed' });
  });

  it('is idempotent: a second batch with no missing targets is a no-op', async () => {
    const { sb } = fakeSb({ design_reads: { enabled: true, lane: 'runner', tiers: [1] } });
    let calls = 0;
    const h = handler({
      async fetchTargets() { calls += 1; return calls === 1 ? ['a'] : []; },
      async processBatch() { return { processed: 1, failed: 0, costUsd: 0 }; },
    });
    const first = await runBackfillBatch(h, deps(sb));
    const second = await runBackfillBatch(h, deps(sb));
    expect(first.processed).toBe(1);
    expect(second.skipped).toBe('no_targets');
    expect(second.processed).toBe(0);
  });
});
