import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __notifySendLaneStorageChange,
  __resetSendLanes,
  __sendLaneTabId,
  __SEND_LANE_STORAGE_PREFIX,
  __setSendLaneStorage,
  describeSendLaneHolds,
  getSendLaneHolds,
  getSendLaneWaiterCount,
  holdSendLane,
  isSendLaneBusy,
  waitForSendLane,
  type SendLaneStorage,
} from '../sendLane';

const WID = '966500000000@c.us';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** In-memory stand-in for localStorage shared by "tabs" in a test. */
function memoryStorage(): SendLaneStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    keys: () => [...map.keys()],
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Write a hold as ANOTHER tab would. */
function remoteHold(
  store: SendLaneStorage,
  input: { id: string; label?: string; until: number; heartbeat: number; startedAt?: number; chatWid?: string },
): string {
  const chatWid = input.chatWid ?? WID;
  const key = `${__SEND_LANE_STORAGE_PREFIX}${chatWid}:${input.id}`;
  store.setItem(key, JSON.stringify({
    id: input.id,
    chatWid,
    label: input.label ?? 'remote gallery',
    tabId: 'other-tab',
    startedAt: input.startedAt ?? Date.now(),
    until: input.until,
    heartbeat: input.heartbeat,
  }));
  return key;
}

describe('sendLane (single tab)', () => {
  beforeEach(() => {
    __resetSendLanes();
    __setSendLaneStorage(null);
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

describe('sendLane (across tabs)', () => {
  let store: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    __resetSendLanes();
    store = memoryStorage();
    __setSendLaneStorage(store);
    vi.useFakeTimers();
  });
  afterEach(() => {
    __setSendLaneStorage(null);
    vi.useRealTimers();
  });

  it('mirrors own holds into shared storage with a heartbeat and removes them on release', async () => {
    const work = deferred();
    const release = holdSendLane(WID, 'إرسال 5 من الوسائط', work.promise, { estimatedMs: 50_000 });
    expect(store.map.size).toBe(1);
    const [key, raw] = [...store.map.entries()][0]!;
    expect(key.startsWith(`${__SEND_LANE_STORAGE_PREFIX}${WID}:`)).toBe(true);
    const stored = JSON.parse(raw) as { tabId: string; heartbeat: number; until: number; startedAt: number };
    expect(stored.tabId).toBe(__sendLaneTabId());
    expect(stored.until - stored.startedAt).toBe(50_000);

    await vi.advanceTimersByTimeAsync(4_500);
    const beat = JSON.parse(store.map.get(key)!) as { heartbeat: number };
    expect(beat.heartbeat).toBeGreaterThan(stored.heartbeat);

    // Own holds are never counted as remote.
    expect(getSendLaneHolds(WID).filter((h) => h.remote)).toHaveLength(0);

    release();
    expect(store.map.size).toBe(0);
    work.resolve();
  });

  it('sees another tab\'s live hold and waits until that tab removes it', async () => {
    const key = remoteHold(store, { id: 'g1', until: Date.now() + 60_000, heartbeat: Date.now() });
    expect(isSendLaneBusy(WID)).toBe(true);
    expect(getSendLaneHolds(WID)).toEqual([expect.objectContaining({ id: 'g1', remote: true })]);

    const done = vi.fn();
    const onWaiting = vi.fn();
    const waiter = waitForSendLane(WID, onWaiting).then(done);
    await vi.advanceTimersByTimeAsync(2_500); // several polls
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();

    // Other tab finishes: removes its key, storage event fires here.
    store.removeItem(key);
    __notifySendLaneStorageChange();
    await vi.advanceTimersByTimeAsync(0);
    await waiter;
    expect(done).toHaveBeenCalledTimes(1);
    expect(isSendLaneBusy(WID)).toBe(false);
  });

  it('falls back to polling when no storage event arrives', async () => {
    const key = remoteHold(store, { id: 'g2', until: Date.now() + 60_000, heartbeat: Date.now() });
    const done = vi.fn();
    const waiter = waitForSendLane(WID).then(done);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(done).not.toHaveBeenCalled();
    store.removeItem(key); // no event
    await vi.advanceTimersByTimeAsync(1_100);
    await waiter;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a remote promise hold with a stale heartbeat stays alive only until its estimated end (owner tab closed)', () => {
    const now = Date.now();
    // Tab died 30 s ago; batch estimated to run another 20 s.
    remoteHold(store, { id: 'g3', until: now + 20_000, heartbeat: now - 30_000 });
    expect(isSendLaneBusy(WID)).toBe(true);

    vi.setSystemTime(now + 21_000);
    expect(isSendLaneBusy(WID)).toBe(false);
    // Dead entry was pruned by the reader.
    expect(store.map.size).toBe(0);
  });

  it('a remote time hold expires at its timestamp regardless of heartbeat', () => {
    const now = Date.now();
    remoteHold(store, { id: 'g4', until: now + 5_000, heartbeat: 0 });
    expect(isSendLaneBusy(WID)).toBe(true);
    vi.setSystemTime(now + 5_001);
    expect(isSendLaneBusy(WID)).toBe(false);
  });

  it('ignores a corrupt entry and prunes it', () => {
    store.setItem(`${__SEND_LANE_STORAGE_PREFIX}${WID}:junk`, '{not json');
    expect(isSendLaneBusy(WID)).toBe(false);
    expect(store.map.size).toBe(0);
  });

  it('remote holds are per conversation', () => {
    remoteHold(store, { id: 'g5', until: Date.now() + 60_000, heartbeat: Date.now(), chatWid: '966511111111@c.us' });
    expect(isSendLaneBusy(WID)).toBe(false);
    expect(isSendLaneBusy('966511111111@c.us')).toBe(true);
  });

  it('waits for BOTH a local hold and a remote hold', async () => {
    const local = deferred();
    holdSendLane(WID, 'local', local.promise);
    const key = remoteHold(store, { id: 'g6', until: Date.now() + 60_000, heartbeat: Date.now() });
    const done = vi.fn();
    const waiter = waitForSendLane(WID).then(done);

    local.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(done).not.toHaveBeenCalled(); // remote still holds

    store.removeItem(key);
    __notifySendLaneStorageChange();
    await vi.advanceTimersByTimeAsync(0);
    await waiter;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('degrades to in-tab only when shared storage throws (logged once)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setSendLaneStorage({
      keys: () => { throw new Error('SecurityError'); },
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    });
    const work = deferred();
    holdSendLane(WID, 'x', work.promise);
    expect(isSendLaneBusy(WID)).toBe(true);
    work.resolve();
    await waitForSendLane(WID);
    expect(isSendLaneBusy(WID)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
