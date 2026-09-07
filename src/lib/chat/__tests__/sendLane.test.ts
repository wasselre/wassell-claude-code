import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetSendLanes,
  describeSendLaneHolds,
  getSendLaneHolds,
  getSendLaneWaiterCount,
  holdSendLane,
  isSendLaneBusy,
  waitForSendLane,
} from '../sendLane';

const WID = '966500000000@c.us';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('sendLane', () => {
  beforeEach(() => {
    __resetSendLanes();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is free when nothing holds it and waitForSendLane resolves immediately', async () => {
    expect(isSendLaneBusy(WID)).toBe(false);
    const onWaiting = vi.fn();
    await waitForSendLane(WID, onWaiting);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('parks a send behind an in-flight gallery and releases it after', async () => {
    const gallery = deferred();
    holdSendLane(WID, 'إرسال 5 من الوسائط', gallery.promise);
    expect(isSendLaneBusy(WID)).toBe(true);

    const order: string[] = [];
    const onWaiting = vi.fn();
    const pdf = waitForSendLane(WID, onWaiting).then(() => order.push('pdf'));
    await flush();
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls[0]![0].map((h: { label: string }) => h.label)).toEqual(['إرسال 5 من الوسائط']);
    expect(getSendLaneWaiterCount()).toBe(1);
    expect(order).toEqual([]);

    order.push('gallery-done');
    gallery.resolve();
    await pdf;
    expect(order).toEqual(['gallery-done', 'pdf']);
    expect(isSendLaneBusy(WID)).toBe(false);
    expect(getSendLaneWaiterCount()).toBe(0);
  });

  it('honors a hold added while already waiting (second gallery queued behind the first)', async () => {
    const first = deferred();
    holdSendLane(WID, 'first', first.promise);
    const done = vi.fn();
    const waiter = waitForSendLane(WID).then(done);
    await flush();

    const second = deferred();
    holdSendLane(WID, 'second', second.promise);
    first.resolve();
    await flush();
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(isSendLaneBusy(WID)).toBe(true);

    second.resolve();
    await waiter;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a rejected hold releases the lane like a resolved one', async () => {
    const work = deferred();
    holdSendLane(WID, 'failing', work.promise);
    const waiter = waitForSendLane(WID);
    work.reject(new Error('boom'));
    await waiter;
    expect(isSendLaneBusy(WID)).toBe(false);
  });

  it('an early release ends the hold', async () => {
    const work = deferred();
    const release = holdSendLane(WID, 'x', work.promise);
    release();
    expect(isSendLaneBusy(WID)).toBe(false);
    await waitForSendLane(WID);
  });

  it('lanes are per conversation', async () => {
    const work = deferred();
    holdSendLane(WID, 'x', work.promise);
    expect(isSendLaneBusy('966511111111@c.us')).toBe(false);
    await waitForSendLane('966511111111@c.us');
    work.resolve();
  });

  it('a time-based hold releases when the timestamp passes', async () => {
    vi.useFakeTimers();
    holdSendLane(WID, 'queued', { until: Date.now() + 30_000 });
    expect(isSendLaneBusy(WID)).toBe(true);
    const waiter = waitForSendLane(WID);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(isSendLaneBusy(WID)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await waiter;
    expect(isSendLaneBusy(WID)).toBe(false);
  });

  it('a promise hold that never settles is force-released at the ceiling (never freezes a chat)', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    holdSendLane(WID, 'hung', new Promise<void>(() => {}));
    const waiter = waitForSendLane(WID);
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 10);
    await waiter;
    expect(isSendLaneBusy(WID)).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('describes the holds bilingually', () => {
    const work = deferred();
    holdSendLane(WID, 'إرسال 5 من الوسائط', work.promise);
    const holds = getSendLaneHolds(WID);
    expect(describeSendLaneHolds(holds, true)).toBe('بانتظار انتهاء «إرسال 5 من الوسائط»');
    expect(describeSendLaneHolds(holds, false)).toBe('Waiting for «إرسال 5 من الوسائط» to finish');
    work.resolve();
  });
});
