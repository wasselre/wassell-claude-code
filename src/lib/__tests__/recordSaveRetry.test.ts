import { describe, it, expect } from 'vitest';
import {
  classifySaveError,
  retryRecordSave,
  recordSaveWithRetry,
  type SaveError,
} from '../../../api/_lib/recordSaveRetry';

const noSleep = async (): Promise<void> => {};
const fixedRandom = (): number => 0; // full-jitter delay → 0 in tests

describe('classifySaveError', () => {
  it('null/undefined → success', () => {
    expect(classifySaveError(null)).toBe('success');
    expect(classifySaveError(undefined)).toBe('success');
  });

  it('conflict_storm_blocked → terminal (even though it carries SQLSTATE 40001)', () => {
    expect(
      classifySaveError({ code: '40001', message: 'conflict_storm_blocked: this session is rate-limited' }),
    ).toBe('terminal');
  });

  it('version_mismatch / 40001 / serialization_failure → retry_version', () => {
    expect(classifySaveError({ code: '40001', message: 'version_mismatch: loaded v1 current v2' })).toBe('retry_version');
    expect(classifySaveError({ code: '40001', message: 'whatever' })).toBe('retry_version');
    expect(classifySaveError({ message: 'serialization_failure' })).toBe('retry_version');
  });

  it('network/gateway → retry_transient', () => {
    expect(classifySaveError({ message: 'fetch failed' })).toBe('retry_transient');
    expect(classifySaveError({ message: 'request timeout' })).toBe('retry_transient');
    expect(classifySaveError({ message: 'Service Unavailable (503)' })).toBe('retry_transient');
  });

  it('auth/validation → terminal', () => {
    expect(classifySaveError({ code: '42501', message: 'permission denied' })).toBe('terminal');
    expect(classifySaveError({ message: 'invalid input' })).toBe('terminal');
  });
});

describe('retryRecordSave — loop mechanics', () => {
  it('stops after maxAttempts on a persistent version_mismatch', async () => {
    let calls = 0;
    const out = await retryRecordSave(
      async () => { calls++; return { code: '40001', message: 'version_mismatch' }; },
      { sleep: noSleep, random: fixedRandom },
    );
    expect(calls).toBe(3);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(3);
  });

  it('conflict_storm_blocked is terminal — exactly ONE attempt, no retry', async () => {
    let calls = 0;
    const out = await retryRecordSave(
      async () => { calls++; return { code: '40001', message: 'conflict_storm_blocked' }; },
      { sleep: noSleep, random: fixedRandom },
    );
    expect(calls).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(1);
  });

  it('succeeds on the 2nd attempt after one version_mismatch', async () => {
    const scripted: (SaveError | null)[] = [{ code: '40001', message: 'version_mismatch' }, null];
    let i = 0;
    const out = await retryRecordSave(async () => scripted[i++] ?? null, { sleep: noSleep, random: fixedRandom });
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(2);
  });

  it('stops early when the time budget would be exceeded', async () => {
    let calls = 0;
    let clock = 0;
    const out = await retryRecordSave(
      async () => { calls++; return { code: '40001', message: 'version_mismatch' }; },
      {
        sleep: noSleep,
        random: () => 1, // max jitter → delay near cap
        now: () => { const t = clock; clock += 4000; return t; }, // jump 4s per read → budget(5s) blown after attempt 1
        budgetMs: 5000,
      },
    );
    expect(out.ok).toBe(false);
    expect(calls).toBeLessThan(3); // budget stopped it before exhausting attempts
  });

  it('respects the backoff cap (delay never exceeds capMs)', async () => {
    const delays: number[] = [];
    await retryRecordSave(
      async () => ({ code: '40001', message: 'version_mismatch' }),
      {
        sleep: async (ms) => { delays.push(ms); },
        random: () => 0.999999,
        baseMs: 100,
        capMs: 2000,
      },
    );
    for (const d of delays) expect(d).toBeLessThanOrEqual(2000);
  });
});

// Minimal duck-typed Supabase client: supports .from().select().eq().single() and .rpc().
function makeFakeClient(
  reads: { data: unknown; error: unknown }[],
  saves: { error: SaveError | null }[],
) {
  let readIdx = 0;
  const rpcCalls: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => reads[Math.min(readIdx++, reads.length - 1)],
        }),
      }),
    }),
    rpc: async (_name: string, params: Record<string, unknown>) => {
      rpcCalls.push(params);
      return saves[Math.min(rpcCalls.length - 1, saves.length - 1)];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { client, rpcCalls, getReadCount: () => readIdx };
}

describe('recordSaveWithRetry — fresh read + re-merge (no stale resend)', () => {
  it('re-reads the FRESH row before retrying a version_mismatch and sends the new version', async () => {
    const { client, rpcCalls, getReadCount } = makeFakeClient(
      [
        { data: { model_id: 'm', data: { x: 0 }, version: 1, created_by_user_id: 'u' }, error: null },
        { data: { model_id: 'm', data: { x: 0 }, version: 2, created_by_user_id: 'u' }, error: null },
      ],
      [{ error: { code: '40001', message: 'version_mismatch' } }, { error: null }],
    );
    let buildCalls = 0;
    await recordSaveWithRetry(
      client,
      { recordId: 'r', build: (d) => { buildCalls++; return { ...d, y: 1 }; } },
      { sleep: noSleep, random: fixedRandom },
    );
    expect(getReadCount()).toBe(2); // re-read fresh before the retry
    expect(buildCalls).toBe(2); // re-merged each attempt
    expect(rpcCalls[0]?.p_expected_version).toBe(1);
    expect(rpcCalls[1]?.p_expected_version).toBe(2); // retry used the FRESH version, not v1
  });

  it('conflict_storm_blocked → throws immediately, no retry (1 read, 1 save)', async () => {
    const { client, rpcCalls, getReadCount } = makeFakeClient(
      [{ data: { model_id: 'm', data: {}, version: 1, created_by_user_id: null }, error: null }],
      [{ error: { code: '40001', message: 'conflict_storm_blocked: rate-limited' } }],
    );
    await expect(
      recordSaveWithRetry(client, { recordId: 'r', build: (d) => ({ ...d, y: 1 }) }, { sleep: noSleep, random: fixedRandom }),
    ).rejects.toThrow();
    expect(getReadCount()).toBe(1);
    expect(rpcCalls.length).toBe(1);
  });

  it('build returning null skips the save (treated as success)', async () => {
    const { client, rpcCalls } = makeFakeClient(
      [{ data: { model_id: 'm', data: {}, version: 1, created_by_user_id: null }, error: null }],
      [{ error: null }],
    );
    await recordSaveWithRetry(client, { recordId: 'r', build: () => null }, { sleep: noSleep, random: fixedRandom });
    expect(rpcCalls.length).toBe(0); // no record_save call
  });
});
