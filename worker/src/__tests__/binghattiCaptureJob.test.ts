import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectUpdateRun } from '../runProjectUpdateJob';
import { ensureBinghattiCapture } from '../projectUpdates/binghattiCapture';

const NOW = Date.parse('2026-10-05T09:00:00Z');
const PORTAL = 'portal-1';
const item = { id: '84934', projectId: '10101', code: 'BWRT-645', number: '645', actualPrice: 1336999,
  netArea: 603.86, totalArea: 663.27, bedroomsCount: 1, unitTypeId: '2', floorNumber: 6 };
const fresh = () => ({ saved_at: '2026-10-05T08:00:00Z', totalCount: 1, items: [item] });
const stale = () => ({ ...fresh(), saved_at: '2026-10-03T08:00:00Z' });
const run = (dry_run = false, params: Record<string, unknown> = {}): ProjectUpdateRun => ({
  id: 'run-1', source_type: 'binghatti_broker', trigger: 'schedule', dry_run, params, attempts: 1,
});

function harness(raw?: unknown, jobOverrides: Record<string, unknown> = {}) {
  let currentRaw = raw;
  let storageError: { message: string } | null = null;
  const stateError: { message: string } | null = null;
  const job = { status: 'running', parked_at: null, error_message: null, portal_record_id: PORTAL, ...jobOverrides };
  const download = vi.fn(async () => storageError ? { data: null, error: storageError }
    : currentRaw === undefined ? { data: null, error: { message: 'Object not found' } }
      : { data: { text: async () => JSON.stringify(currentRaw) }, error: null });
  const single = vi.fn(async () => ({ data: job, error: null }));
  const update = vi.fn();
  const query = {
    select: vi.fn(() => query), eq: vi.fn(() => query), single,
    update: vi.fn((value: unknown) => { update(value); return query; }),
    then: (onfulfilled: (value: { data: null; error: { message: string } | null }) => unknown) =>
      Promise.resolve({ data: null, error: stateError }).then(onfulfilled),
  };
  const from = vi.fn(() => query);
  const rpc = vi.fn(async (name: string) => ({ data: name === 'portal_status_check_enqueue' ? 'capture-job-1' : true, error: null }));
  const client = { storage: { from: vi.fn(() => ({ download })) }, from, rpc } as unknown as SupabaseClient;
  return { client, rpc, from, update, download, single, job,
    snapshot: (value: unknown) => { currentRaw = value; }, storageFailure: (message: string) => { storageError = { message }; } };
}

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());

describe('Binghatti inventory refresh job handshake', () => {
  it('bypasses Browserbase and all writes when a complete fresh snapshot exists', async () => {
    const h = harness(fresh());
    const snapshot = await ensureBinghattiCapture(h.client, run(), PORTAL);
    expect(snapshot).toMatchObject({ complete: true, fresh: true, totalCount: 1 });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('dry run reads a fresh snapshot without enqueueing or writing state', async () => {
    const h = harness(fresh());
    expect((await ensureBinghattiCapture(h.client, run(true), PORTAL))?.fresh).toBe(true);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([undefined, stale()])('dry run rejects unavailable/stale inventory without writes', async (raw) => {
    const h = harness(raw);
    await expect(ensureBinghattiCapture(h.client, run(true), PORTAL)).rejects.toThrow('dry run');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('enqueues one capture, persists its ID and reuses it across deferred attempts', async () => {
    const h = harness(stale());
    const activeRun = run();
    expect(await ensureBinghattiCapture(h.client, activeRun, PORTAL)).toBeNull();
    expect(activeRun.params).toMatchObject({ binghatti_capture_job_id: 'capture-job-1' });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({ params: { binghatti_capture_job_id: 'capture-job-1' } });
    expect(await ensureBinghattiCapture(h.client, activeRun, PORTAL)).toBeNull();
    expect(h.rpc.mock.calls.filter(([name]) => name === 'portal_status_check_enqueue')).toHaveLength(1);
    expect(h.rpc.mock.calls.filter(([name]) => name === 'project_update_defer')).toHaveLength(2);
    expect(h.update).toHaveBeenCalledTimes(1);
    // The actual complete upload wakes the next attempt without further RPCs.
    h.snapshot(fresh());
    const callCount = h.rpc.mock.calls.length;
    expect((await ensureBinghattiCapture(h.client, activeRun, PORTAL))?.fresh).toBe(true);
    expect(h.rpc).toHaveBeenCalledTimes(callCount);
  });

  it('a parked OTP job fails closed without waking it or starting another sign-in', async () => {
    const h = harness(stale(), { parked_at: '2026-10-05T08:59:00Z' });
    const activeRun = run(false, { binghatti_capture_job_id: 'capture-job-1', binghatti_capture_requested_at: '2026-10-05T08:58:00Z' });
    await expect(ensureBinghattiCapture(h.client, activeRun, PORTAL)).rejects.toThrow('waiting for the operator OTP');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a capture waiting more than 30 minutes fails without repeated enqueue/defer', async () => {
    const h = harness(undefined, { status: 'awaiting_input' });
    const activeRun = run(false, { binghatti_capture_job_id: 'capture-job-1', binghatti_capture_requested_at: '2026-10-05T08:29:00Z' });
    await expect(ensureBinghattiCapture(h.client, activeRun, PORTAL)).rejects.toThrow('30 minutes');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('a future request timestamp cannot disable the capture wait ceiling', async () => {
    const h = harness();
    const activeRun = run(false, { binghatti_capture_job_id: 'capture-job-1', binghatti_capture_requested_at: '2026-10-06T09:00:00Z' });
    await expect(ensureBinghattiCapture(h.client, activeRun, PORTAL)).rejects.toThrow('30 minutes');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled', 'succeeded'])('a terminal %s job without fresh inventory cannot be applied', async (status) => {
    const h = harness(stale(), { status, error_message: 'capture failed' });
    const activeRun = run(false, { binghatti_capture_job_id: 'capture-job-1', binghatti_capture_requested_at: '2026-10-05T08:59:00Z' });
    await expect(ensureBinghattiCapture(h.client, activeRun, PORTAL)).rejects.toThrow(`capture ${status}`);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { ...fresh(), totalCount: 2 },
    { ...fresh(), items: [item, item], totalCount: 2 },
    { ...fresh(), saved_at: 'invalid' },
  ])('malformed/truncated inventory fails before any job or CRM write', async (raw) => {
    const h = harness(raw);
    await expect(ensureBinghattiCapture(h.client, run(), PORTAL)).rejects.toThrow('binghatti snapshot');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('rejects a capture job from another portal', async () => {
    const h = harness(undefined, { portal_record_id: 'another-portal' });
    const activeRun = run(false, { binghatti_capture_job_id: 'capture-job-1', binghatti_capture_requested_at: '2026-10-05T08:59:00Z' });
    await expect(ensureBinghattiCapture(h.client, activeRun, PORTAL)).rejects.toThrow('another portal');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('surfaces storage access failures before starting a paid browser', async () => {
    const h = harness();
    h.storageFailure('permission denied');
    await expect(ensureBinghattiCapture(h.client, run(), PORTAL)).rejects.toThrow('permission denied');
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
