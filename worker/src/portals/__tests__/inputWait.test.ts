import { describe, expect, it, vi } from 'vitest';
import { RecipeCancelledError } from '../recipe';
import {
  waitForPortalInput,
  PortalInputTimeoutError,
  type PortalEmailOtpChannel,
  type PortalInputRow,
  type WaitForPortalInputOptions,
} from '../inputWait';

/**
 * All tests run on a fake clock: `sleep` advances `now`, so a 30 s wait
 * completes instantly while preserving the real cadence (manual poll 1.5 s,
 * mailbox poll 5 s, heartbeat every 4th poll, relay grace 20 s).
 */

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    at: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const awaiting = (key = 'otp', value: string | null = null, nonce?: string): PortalInputRow => ({
  status: 'awaiting_input',
  input_value: value,
  input_request: nonce === undefined ? { key } : { key, email_otp_nonce: nonce },
});

function emailChannel(over: Partial<PortalEmailOtpChannel> = {}): PortalEmailOtpChannel & {
  findCandidate: ReturnType<typeof vi.fn>;
  claimCandidate: ReturnType<typeof vi.fn>;
  discardCandidate: ReturnType<typeof vi.fn>;
} {
  return {
    nonce: 'n1',
    findCandidate: vi.fn(async () => null),
    claimCandidate: vi.fn(async () => true),
    discardCandidate: vi.fn(),
    ...over,
  } as PortalEmailOtpChannel & {
    findCandidate: ReturnType<typeof vi.fn>;
    claimCandidate: ReturnType<typeof vi.fn>;
    discardCandidate: ReturnType<typeof vi.fn>;
  };
}

function harness(rows: (PortalInputRow | null)[], overrides: Partial<WaitForPortalInputOptions> = {}) {
  const clock = makeClock();
  const email = overrides.email;
  // When the canned rows run out, keep answering "still awaiting, no input" so
  // the wait reaches its deadline (or the next interesting event) on its own.
  const fallback = (): PortalInputRow => awaiting('otp', null, email?.nonce);
  const readRow = vi.fn(async (): Promise<PortalInputRow | null> => (rows.length ? rows.shift()! : fallback()));
  const resumeManual = vi.fn(async () => true);
  const checkCancelled = vi.fn(async () => undefined);
  const heartbeat = vi.fn(async () => undefined);
  const notifyRelay = vi.fn(async () => undefined);
  const opts: WaitForPortalInputOptions = {
    key: 'otp',
    timeoutMs: 30_000,
    readRow,
    resumeManual,
    checkCancelled,
    heartbeat,
    notifyRelay,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
  return { opts, clock, readRow, resumeManual, checkCancelled, heartbeat, notifyRelay };
}

describe('manual path (unchanged behavior)', () => {
  it('notifies the relay immediately and returns the first manual answer', async () => {
    const h = harness([awaiting('otp', ' 123456 ')]);
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('123456');
    expect(h.notifyRelay).toHaveBeenCalledTimes(1);
    expect(h.resumeManual).toHaveBeenCalledTimes(1);
  });

  it('ignores whitespace-only input and keeps waiting', async () => {
    const h = harness([awaiting('otp', '   '), awaiting('otp', ' 654321 ')]);
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('654321');
  });

  it('a false resume cancels and never returns the value', async () => {
    const resumeManual = vi.fn(async () => false);
    const h = harness([awaiting('otp', '123456')], { resumeManual });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
    expect(resumeManual).toHaveBeenCalledTimes(1);
  });

  it('preserves the ~6s heartbeat cadence and times out with PortalInputTimeoutError', async () => {
    const h = harness([]);
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(PortalInputTimeoutError);
    // 30 s at 1.5 s polls = 20 iterations → heartbeats on polls 4, 8, 12, 16, 20.
    expect(h.heartbeat).toHaveBeenCalledTimes(5);
  });
});

describe('request validity — never consume another step’s answer', () => {
  it('cancels on a missing row', async () => {
    const h = harness([null]);
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
  });

  it.each(['cancelled', 'failed', 'running'])('cancels on status=%s', async (status) => {
    const h = harness([{ status, input_value: '123456', input_request: { key: 'otp' } }]);
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
  });

  it('cancels when the request key changed — the sitting value is not consumed', async () => {
    const h = harness([awaiting('otp'), awaiting('other-key', '123456')]);
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
    expect(h.resumeManual).not.toHaveBeenCalled();
  });

  it('cancels when the configured email nonce no longer matches', async () => {
    const email = emailChannel();
    const h = harness([awaiting('otp', '123456', 'SOMEONE-ELSE')], { email });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
    expect(h.resumeManual).not.toHaveBeenCalled();
    expect(email.findCandidate).not.toHaveBeenCalled();
  });
});

describe('cancellation and shutdown', () => {
  it('propagates a cancellation thrown before the wait', async () => {
    const h = harness([]);
    h.checkCancelled.mockRejectedValueOnce(new RecipeCancelledError());
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
  });

  it('keeps checking cancellation around waits (a mid-wait shutdown stops the loop)', async () => {
    const h = harness([]);
    let calls = 0;
    h.checkCancelled.mockImplementation(async () => {
      calls += 1;
      if (calls >= 3) throw new RecipeCancelledError();
    });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
    // It stopped on the cancellation, not the 30 s deadline.
    expect(h.clock.at()).toBeLessThan(30_000);
  });
});

describe('email channel', () => {
  it('manual input wins immediately — trimmed, no mailbox poll, no relay before the grace', async () => {
    const email = emailChannel();
    const h = harness([awaiting('otp', '  999888  ', 'n1')], { email });
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('999888');
    expect(email.findCandidate).not.toHaveBeenCalled();
    expect(h.notifyRelay).not.toHaveBeenCalled();
  });

  it('polls the mailbox ~every 5s and wakes the relay once after the 20s grace', async () => {
    const email = emailChannel();
    const h = harness([], { email });
    const relayAt: number[] = [];
    h.notifyRelay.mockImplementation(async () => {
      relayAt.push(h.clock.at());
    });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(PortalInputTimeoutError);
    // Mailbox polls at t=6000, 12000, 18000, 24000 (1.5 s ticks, 5 s cadence).
    expect(email.findCandidate).toHaveBeenCalledTimes(4);
    // The poll is bounded by the time LEFT in the wait (30 s − 6 s at the first).
    expect(email.findCandidate).toHaveBeenNthCalledWith(1, 24_000, expect.any(AbortSignal));
    // The relay fires exactly once, only after the 20 s grace.
    expect(relayAt).toHaveLength(1);
    expect(relayAt[0]).toBeGreaterThanOrEqual(20_000);
  });

  it('a claimed candidate returns the code in memory — no generic resume, no relay', async () => {
    const email = emailChannel({
      findCandidate: vi.fn(async () => ({ code: '424242', messageId: 'm1' })),
    });
    const h = harness([], { email });
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('424242');
    expect(email.claimCandidate).toHaveBeenCalledWith('m1');
    expect(h.resumeManual).not.toHaveBeenCalled();
    expect(h.notifyRelay).not.toHaveBeenCalled();
  });

  it('a lost claim discards the mail and an immediate manual answer wins', async () => {
    let manual: string | null = null;
    const email = emailChannel({
      findCandidate: vi.fn(async () => ({ code: '111111', messageId: 'm1' })),
      claimCandidate: vi.fn(async () => { manual = ' 555555 '; return false; }),
    });
    const h = harness([], { email });
    h.opts.readRow = vi.fn(async () => awaiting('otp', manual, 'n1'));
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('555555');
    expect(email.discardCandidate).toHaveBeenCalledWith('m1');
    expect(h.resumeManual).toHaveBeenCalledTimes(1);
  });

  it('a discarded mail does not starve a later, different candidate', async () => {
    const email = emailChannel({
      claimCandidate: vi.fn(async (messageId: string) => messageId === 'm2'),
    });
    email.findCandidate
      .mockResolvedValueOnce({ code: '111111', messageId: 'm1' })
      .mockResolvedValue({ code: '222222', messageId: 'm2' });
    // Poll 1 (t=6000): head reads ×5 + re-read + post-discard re-read = 7 rows;
    // poll 2 (t=12000): head reads ×4 + head at 12000 + re-read = 5 rows.
    const rows = Array.from({ length: 12 }, () => awaiting('otp', null, 'n1'));
    const h = harness(rows, { email });
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('222222');
    expect(email.discardCandidate).toHaveBeenCalledWith('m1');
    expect(email.claimCandidate.mock.calls.map((c) => c[0])).toEqual(['m1', 'm2']);
    expect(h.resumeManual).not.toHaveBeenCalled();
  });

  it('a provider failure is rethrown unchanged when no manual answer arrived', async () => {
    const boom = new Error('gmail request failed (sanitized)');
    const email = emailChannel({
      findCandidate: vi.fn(async () => {
        throw boom;
      }),
    });
    const h = harness([], { email });
    await expect(waitForPortalInput(h.opts)).rejects.toBe(boom);
  });

  it('a manual answer typed while the provider request failed is still consumed', async () => {
    const email = emailChannel({
      findCandidate: vi.fn(async () => {
        throw new Error('gmail request failed (sanitized)');
      }),
    });
    // 5 loop-head rows (t=0…6000), then the catch-path re-read finds the answer.
    const rows = Array.from({ length: 5 }, () => awaiting('otp', null, 'n1'));
    rows.push(awaiting('otp', '777777', 'n1'));
    const h = harness(rows, { email });
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('777777');
    expect(h.resumeManual).toHaveBeenCalledTimes(1);
  });

  it('a manual answer typed while the mailbox was being polled wins over the candidate', async () => {
    const email = emailChannel({
      findCandidate: vi.fn(async () => ({ code: '111111', messageId: 'm1' })),
    });
    // 5 head rows, then the post-poll re-read finds the manual answer BEFORE
    // the claim is attempted.
    const rows = Array.from({ length: 5 }, () => awaiting('otp', null, 'n1'));
    rows.push(awaiting('otp', ' 333444 ', 'n1'));
    const h = harness(rows, { email });
    const value = await waitForPortalInput(h.opts);
    expect(value).toBe('333444');
    expect(email.claimCandidate).not.toHaveBeenCalled();
    expect(h.resumeManual).toHaveBeenCalledTimes(1);
  });
});

describe('one in-flight mailbox poll', () => {
  it('re-reads manual input before rethrowing a completed poll failure', async () => {
    const email = emailChannel({ findCandidate: vi.fn(async () => { throw new Error('sanitized failure'); }) });
    const h = harness([], { email });
    let readsAfterFailure = 0;
    h.opts.readRow = vi.fn(async () => {
      if (h.clock.at() >= 7_500) readsAfterFailure += 1;
      return awaiting('otp', readsAfterFailure === 2 ? ' 654321 ' : null, 'n1');
    });
    expect(await waitForPortalInput(h.opts)).toBe('654321');
    expect(h.resumeManual).toHaveBeenCalledTimes(1);
    expect(email.claimCandidate).not.toHaveBeenCalled();
  });

  it('consumes manual input during a deferred poll and drops its late candidate', async () => {
    const pending = deferred<{ code: string; messageId: string } | null>();
    const email = emailChannel({ findCandidate: vi.fn(() => pending.promise) });
    const h = harness([], { email });
    h.opts.readRow = vi.fn(async () => awaiting('otp', h.clock.at() >= 9_000 ? ' 654321 ' : null, 'n1'));
    expect(await waitForPortalInput(h.opts)).toBe('654321');
    expect(h.clock.at()).toBe(9_000);
    expect(email.findCandidate).toHaveBeenCalledTimes(1);
    expect(email.findCandidate.mock.calls[0][1].aborted).toBe(true);
    pending.resolve({ code: '111111', messageId: 'late' });
    await Promise.resolve();
    await Promise.resolve();
    expect(email.claimCandidate).not.toHaveBeenCalled();
    expect(h.notifyRelay).not.toHaveBeenCalled();
  });

  it('keeps heartbeats and relay grace running while a poll stays pending', async () => {
    const pending = deferred<null>();
    const email = emailChannel({ findCandidate: vi.fn(() => pending.promise) });
    const h = harness([], { email });
    const relayAt: number[] = [];
    h.notifyRelay.mockImplementation(async () => { relayAt.push(h.clock.at()); });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(PortalInputTimeoutError);
    expect(email.findCandidate).toHaveBeenCalledTimes(1);
    expect(h.heartbeat).toHaveBeenCalledTimes(5);
    expect(relayAt).toEqual([21_000]);
    expect(email.findCandidate.mock.calls[0][1].aborted).toBe(true);
    // A late failure is still observed, without an unhandled rejection.
    pending.reject(new Error('sanitized late failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(email.claimCandidate).not.toHaveBeenCalled();
  });

  it('aborts a pending poll when cancellation arrives before its result', async () => {
    const pending = deferred<{ code: string; messageId: string }>();
    const email = emailChannel({ findCandidate: vi.fn(() => pending.promise) });
    const h = harness([], { email });
    h.checkCancelled.mockImplementation(async () => { if (h.clock.at() >= 9_000) throw new RecipeCancelledError(); });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(RecipeCancelledError);
    expect(email.findCandidate.mock.calls[0][1].aborted).toBe(true);
    pending.resolve({ code: '111111', messageId: 'late' });
    await Promise.resolve();
    await Promise.resolve();
    expect(email.claimCandidate).not.toHaveBeenCalled();
    expect(h.resumeManual).not.toHaveBeenCalled();
  });

  it('never claims a candidate completed at the deadline', async () => {
    const pending = deferred<{ code: string; messageId: string }>();
    const email = emailChannel({ findCandidate: vi.fn(() => pending.promise) });
    const h = harness([], { email });
    h.opts.sleep = async (ms) => {
      await h.clock.sleep(ms);
      if (h.clock.at() >= 30_000) pending.resolve({ code: '111111', messageId: 'expired' });
    };
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(PortalInputTimeoutError);
    expect(email.claimCandidate).not.toHaveBeenCalled();
  });

  it('rechecks the deadline after reading the candidate race row', async () => {
    const email = emailChannel({ findCandidate: vi.fn(async () => ({ code: '111111', messageId: 'expired' })) });
    const h = harness([], { email });
    h.opts.readRow = vi.fn(async () => {
      if (h.clock.at() >= 7_500) await h.clock.sleep(30_000);
      return awaiting('otp', null, 'n1');
    });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(PortalInputTimeoutError);
    expect(email.claimCandidate).not.toHaveBeenCalled();
  });

  it('does not return an automatic code when its claim finishes after expiry', async () => {
    const email = emailChannel({ findCandidate: vi.fn(async () => ({ code: '111111', messageId: 'm1' })) });
    const h = harness([], { email });
    email.claimCandidate.mockImplementation(async () => { await h.clock.sleep(30_000); return true; });
    await expect(waitForPortalInput(h.opts)).rejects.toBeInstanceOf(PortalInputTimeoutError);
    expect(email.claimCandidate).toHaveBeenCalledTimes(1);
    expect(h.resumeManual).not.toHaveBeenCalled();
  });
});

describe('timeout', () => {
  it('throws PortalInputTimeoutError (not a cancellation) so the runtime can pick relay parking vs failure', async () => {
    const h = harness([]);
    const err = await waitForPortalInput(h.opts).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortalInputTimeoutError);
    expect(err).not.toBeInstanceOf(RecipeCancelledError);
    expect((err as Error).name).toBe('PortalInputTimeoutError');
  });
});
