/**
 * Tests for the hourly balance-probe single-runner claim.
 *
 * This guard exists because the Fly app runs FIVE general machines and the
 * balance probe is a TIMED tick, not a queue poll. Without it, all five fire
 * every hour: ~5 Browserbase sessions per provider instead of 1, and 5
 * duplicate probe rows that make the drift history unreadable.
 *
 * The failure that matters is asymmetric, so the tests are too. A false
 * NEGATIVE costs one skipped hour — the next hour probes normally. A false
 * POSITIVE brings back the stampede this was written to stop. So every path
 * that is not an unambiguous win must return false, and that is what is
 * pinned here: a lost race, an RPC error, and every shape of "not exactly
 * true" the RPC could hand back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tryClaimBalanceProbeHour } from '../balanceProbeClaim.js';

type RpcResult = { data: unknown; error: unknown };

function fakeSb(result: RpcResult) {
  const rpc = vi.fn(async () => result);
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tryClaimBalanceProbeHour', () => {
  it('returns true only when this machine inserted the hour row', async () => {
    const { sb, rpc } = fakeSb({ data: true, error: null });
    await expect(tryClaimBalanceProbeHour(sb, 'machine-a')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('ai_balance_probe_try_claim', { p_worker: 'machine-a' });
  });

  it('returns false when another machine already claimed the hour', async () => {
    const { sb } = fakeSb({ data: false, error: null });
    await expect(tryClaimBalanceProbeHour(sb, 'machine-b')).resolves.toBe(false);
  });

  it('does not warn when it loses the race — four machines skipping hourly is noise, not a fault', async () => {
    const { sb } = fakeSb({ data: false, error: null });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tryClaimBalanceProbeHour(sb, 'machine-b');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it('returns false AND logs loudly when the claim RPC errors', async () => {
    // An unknown claim state is a LOST claim. Treating an error as "probe
    // anyway" would restore the exact stampede this guard prevents — and it
    // would do so precisely when the database is already unhappy.
    const { sb } = fakeSb({ data: null, error: { message: 'connection reset' } });
    await expect(tryClaimBalanceProbeHour(sb, 'machine-c')).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('treats every non-true response as a loss, never as a win', async () => {
    // PostgREST can hand back null/undefined/[] depending on how a function
    // result is shaped. Only an exact `true` may open a Browserbase session.
    for (const data of [null, undefined, 0, '', 'true', [], {}, [true]]) {
      const { sb } = fakeSb({ data, error: null });
      await expect(
        tryClaimBalanceProbeHour(sb, 'machine-d'),
        `data=${JSON.stringify(data) ?? String(data)} must not win the claim`,
      ).resolves.toBe(false);
    }
  });

  it('passes the worker id through so a claimed hour is attributable', async () => {
    // claimed_by is how you tell which machine ran an hour when a probe row
    // looks wrong; a hardcoded or empty id would make that untraceable.
    const { sb, rpc } = fakeSb({ data: true, error: null });
    await tryClaimBalanceProbeHour(sb, 'fly-machine-2862624fe34778');
    expect(rpc).toHaveBeenCalledWith('ai_balance_probe_try_claim', {
      p_worker: 'fly-machine-2862624fe34778',
    });
  });

  it('PROPAGATES a thrown rpc — the caller must hold the try/catch', async () => {
    // This helper only inspects the RPC's `error` field. supabase.rpc can also
    // throw outright (socket reset, DNS, a 5xx from PostgREST), and this pins
    // that it does NOT swallow that — so the containment has to live at the
    // call site.
    //
    // It does: runBalanceProbeTick in worker/src/index.ts calls this INSIDE its
    // try. That placement is load-bearing, not cosmetic. balanceProbeLoop does
    // not catch, and its promise sits in the worker's `loops` array, so a throw
    // escaping the tick would reject that array and kill the worker on all five
    // machines over a transient network blip. If anyone ever moves the claim
    // above the try again, this comment is the reason not to.
    const rpc = vi.fn(async () => { throw new Error('network down'); });
    const sb = { rpc } as unknown as SupabaseClient;
    await expect(tryClaimBalanceProbeHour(sb, 'machine-e')).rejects.toThrow('network down');
  });
});
