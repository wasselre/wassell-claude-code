import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitRunnerJob, callViaRunner, enqueueRunnerRead, type RunnerClient } from '../runnerProvider';

interface JobRow {
  id: string;
  status: string;
  result?: unknown;
  error?: string | null;
}

/**
 * Fake claude_jobs table: `insert(...).select('id').single()` for enqueue and
 * `select(...).eq('id', ...).maybeSingle()` for polling. `rows` is mutated by
 * the test between polls to simulate the runner finishing.
 */
function fakeRunnerSb(opts: { inserted?: { id: string }; insertError?: { message: string }; rows: JobRow[] }): {
  sb: RunnerClient;
  inserts: Record<string, unknown>[];
} {
  const inserts: Record<string, unknown>[] = [];
  const sb = {
    from: (table: string) => {
      if (table !== 'claude_jobs') throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return {
            select: () => ({
              single: async () =>
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : { data: opts.inserted ?? { id: 'job-1' }, error: null },
            }),
          };
        },
        select: () => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => ({ data: opts.rows.find((r) => r.id === id) ?? null, error: null }),
          }),
        }),
      };
    },
  } as unknown as RunnerClient;
  return { sb, inserts };
}

const noSleep = async (_ms: number) => {};

afterEach(() => vi.restoreAllMocks());

describe('enqueueRunnerRead', () => {
  it('inserts a pending claude_jobs row with manifest_items in the payload', async () => {
    const { sb, inserts } = fakeRunnerSb({ rows: [] });
    const id = await enqueueRunnerRead(sb, 'mkt_visual_design_slide', [{ media_id: 'm1', stored_url: 'https://x/1.jpg' }], { tier: 1 });
    expect(id).toBe('job-1');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].kind).toBe('mkt_visual_design_slide');
    expect(inserts[0].status).toBe('pending');
    const payload = inserts[0].payload as { manifest_items: unknown[]; tier: number };
    expect(payload.manifest_items).toEqual([{ media_id: 'm1', stored_url: 'https://x/1.jpg' }]);
    expect(payload.tier).toBe(1);
  });
  it('rejects an unknown kind', async () => {
    const { sb } = fakeRunnerSb({ rows: [] });
    await expect(enqueueRunnerRead(sb, 'mkt_visual_ocr' as never, [])).rejects.toThrow(/^provider:runner .*not one of/);
  });
  it('surfaces insert errors as provider:runner', async () => {
    const { sb } = fakeRunnerSb({ rows: [], insertError: { message: 'check violation' } });
    await expect(enqueueRunnerRead(sb, 'mkt_visual_design_post', [])).rejects.toThrow(
      /^provider:runner claude_jobs insert .*check violation/,
    );
  });
});

describe('awaitRunnerJob', () => {
  it('resolves on ready with the result', async () => {
    const { sb } = fakeRunnerSb({ rows: [{ id: 'j1', status: 'ready', result: { processed: 3 } }] });
    const out = await awaitRunnerJob(sb, 'j1', { sleep: noSleep });
    expect(out.status).toBe('ready');
    expect(out.result).toEqual({ processed: 3 });
  });
  it('polls through pending/running until ready', async () => {
    const row: JobRow = { id: 'j1', status: 'pending' };
    const { sb } = fakeRunnerSb({ rows: [row] });
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) row.status = 'running';
      else row.status = 'ready';
      row.result = { ok: true };
    };
    const out = await awaitRunnerJob(sb, 'j1', { sleep, pollMs: 1 });
    expect(out.status).toBe('ready');
    expect(polls).toBeGreaterThanOrEqual(2);
  });
  it('failed → provider:runner throw with the recorded error', async () => {
    const { sb } = fakeRunnerSb({ rows: [{ id: 'j1', status: 'failed', error: 'skill validation produced 0 valid rows' }] });
    await expect(awaitRunnerJob(sb, 'j1', { sleep: noSleep })).rejects.toThrow(
      /^provider:runner job j1 failed: skill validation produced 0 valid rows/,
    );
  });
  it('cancelled and blocked are terminal failures too', async () => {
    const { sb: s1 } = fakeRunnerSb({ rows: [{ id: 'j1', status: 'cancelled', error: null }] });
    await expect(awaitRunnerJob(s1, 'j1', { sleep: noSleep })).rejects.toThrow(/^provider:runner job j1 cancelled/);
    const { sb: s2 } = fakeRunnerSb({ rows: [{ id: 'j1', status: 'blocked', error: 'rights' }] });
    await expect(awaitRunnerJob(s2, 'j1', { sleep: noSleep })).rejects.toThrow(/^provider:runner job j1 blocked: rights/);
  });
  it('a missing row is an error, not an infinite poll', async () => {
    const { sb } = fakeRunnerSb({ rows: [] });
    await expect(awaitRunnerJob(sb, 'ghost', { sleep: noSleep })).rejects.toThrow(/^provider:runner claude_jobs row ghost not found/);
  });
  it('times out loudly when the job never finishes', async () => {
    const { sb } = fakeRunnerSb({ rows: [{ id: 'j1', status: 'running' }] });
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    await expect(awaitRunnerJob(sb, 'j1', { timeoutMs: 10_000, pollMs: 4_000, sleep, now })).rejects.toThrow(
      /^provider:runner job j1 did not finish within 10000ms/,
    );
  });
});

describe('callViaRunner — callRole-shaped', () => {
  it('packages images + prompt as a manifest and returns the job result', async () => {
    const row: JobRow = { id: 'job-1', status: 'pending' };
    const { sb, inserts } = fakeRunnerSb({ rows: [row] });
    const sleep = async () => {
      row.status = 'ready';
      row.result = { reads: [{ slide_role: 'cover' }] };
    };
    const res = await callViaRunner<{ reads: { slide_role: string }[] }>(
      'mkt_visual_design_slide',
      {
        system: 'you read slides',
        user: 'read these',
        schema: { type: 'object' },
        images: [{ url: 'https://x/1.jpg' }, { base64: 'AAAA', mime: 'image/jpeg' }],
      },
      { sb, sleep, pollMs: 1 },
    );
    expect(res.output).toEqual({ reads: [{ slide_role: 'cover' }] });
    expect(res.provider).toBe('runner');
    expect(res.cost_usd).toBe(0); // subscription — known-zero, not null
    expect(res.model).toBe('claude-runner:mkt_visual_design_slide');
    expect(res.usage).toEqual({ in: 0, out: 0 });
    const payload = inserts[0].payload as { manifest_items: Record<string, unknown>[]; prompt: string; system: string };
    expect(payload.manifest_items).toEqual([
      { stored_url: 'https://x/1.jpg', carousel_index: 0 },
      { base64: 'AAAA', mime: 'image/jpeg', carousel_index: 1 },
    ]);
    expect(payload.prompt).toBe('read these');
    expect(payload.system).toBe('you read slides');
  });
  it('requires opts.sb', async () => {
    await expect(
      callViaRunner('mkt_visual_design_post', { system: 's', user: 'u', schema: {} }),
    ).rejects.toThrow(/^provider:runner callViaRunner\(mkt_visual_design_post\): no Supabase client/);
  });
});
