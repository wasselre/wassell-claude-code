/**
 * Per-conversation SEND LANE — keeps outbound WhatsApp messages to one
 * recipient single-file, ACROSS TABS of the same browser.
 *
 * Why: a project message goes out as text → photos → videos, where the
 * gallery is ONE long server request (`/api/whatsapp/send-media-batch`) that
 * sends each item in order. Meanwhile the rep keeps working — opens the units
 * list (often in a second tab) and sends a units PDF, or types a follow-up —
 * and that send used to go straight to the gateway and land IN THE MIDDLE of
 * the gallery (live complaint 2026-09-07: the unit PDF arrived between two
 * project photos).
 *
 * Model: each conversation (chat wid) has a lane. A long-running send HOLDS
 * the lane (`holdSendLane`); any other send-now to that conversation WAITS for
 * every hold to settle before it dispatches (`waitForSendLane`). Holds are
 * either a promise (the batch request) or a timestamp (a batch the server
 * upgraded to its delivery queue, which finishes at a known time).
 *
 * Cross-tab (2026-09-07): every hold is ALSO mirrored into localStorage as its
 * own key (`wassell_send_lane:<chatWid>:<holdId>` — one key per hold, so two
 * tabs never clobber each other's entries). A promise hold carries a heartbeat
 * the owning tab refreshes every few seconds; other tabs treat it as alive
 * while the heartbeat is fresh OR its estimated end has not passed (the batch
 * keeps sending server-side even if the owning tab closed — `keepalive`). A
 * time hold is alive until its timestamp. Waiting tabs wake on the `storage`
 * event and also poll once a second as a belt-and-braces fallback.
 *
 * Boundary: same browser profile only. A different device, browser, or
 * operator does not see these holds — that needs a server-side lane.
 * Scheduled (deliverAt) sends never touch the lane — they sit in the server
 * queue at explicit times.
 *
 * Safety: every hold has a ceiling (a hung request must never freeze a chat
 * forever). When it trips, the hold is released with a console.error — the
 * worst case is the old interleaving behavior, never a stuck composer. A
 * parked send lives only in its tab, so a `beforeunload` guard warns while
 * anything is queued here.
 *
 * Plain module + pub/sub (same pattern as jobCenter / staleBuild) so the store
 * and non-React libs read it synchronously.
 */

export interface SendLaneHold {
  id: string;
  /** Human label of the work holding the lane ("إرسال 5 من الوسائط"). */
  label: string;
  startedAt: number;
  /** True when the hold belongs to another tab of this browser. */
  remote: boolean;
}

type Listener = () => void;

/** A promise-backed hold may run this long before it is force-released. The
 *  batch endpoint's own ceiling is 300 s (maxDuration); this sits above it. */
const PROMISE_HOLD_CEILING_MS = 6 * 60_000;
/** A time-based hold (server delivery queue) may extend this far ahead —
 *  120 items × 10 s stagger = 20 min is the largest batch the server accepts. */
const UNTIL_HOLD_CEILING_MS = 25 * 60_000;
/** Owning tab refreshes a promise hold's heartbeat this often… */
const HEARTBEAT_MS = 4_000;
/** …and other tabs consider it dead this long after the last beat. */
const HEARTBEAT_STALE_MS = 20_000;
/** Fallback poll while waiting on a remote hold (storage events are primary). */
const REMOTE_POLL_MS = 1_000;

const STORAGE_PREFIX = 'wassell_send_lane:';

/** Shape persisted per hold in shared storage. */
interface StoredHold {
  id: string;
  chatWid: string;
  label: string;
  tabId: string;
  startedAt: number;
  /** Time hold: alive until this. Promise hold: the estimated end used only
   *  when the owning tab's heartbeat goes stale (tab closed mid-batch). */
  until: number;
  /** Promise holds only; time holds carry 0. */
  heartbeat: number;
}

/** Minimal storage surface so tests (plain Node) can inject a fake. */
export interface SendLaneStorage {
  keys(): string[];
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface InternalHold extends SendLaneHold {
  done: Promise<void>;
}

const TAB_ID = crypto.randomUUID();
const lanes = new Map<string, InternalHold[]>();
const listeners = new Set<Listener>();
let waiters = 0;
let storageWarned = false;

// ── shared storage (localStorage by default) ────────────────────────────────

function browserStorage(): SendLaneStorage | null {
  if (typeof localStorage === 'undefined') return null;
  return {
    keys: () => {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) out.push(k);
      }
      return out;
    },
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
  };
}

let storage: SendLaneStorage | null = browserStorage();

function storageKey(chatWid: string, id: string): string {
  return `${STORAGE_PREFIX}${chatWid}:${id}`;
}

/** localStorage can throw (SecurityError in a sandboxed frame, quota). The
 *  lane then degrades to in-tab only — logged once, never silent. */
function withStorage<T>(fn: (s: SendLaneStorage) => T): T | null {
  if (!storage) return null;
  try {
    return fn(storage);
  } catch (err) {
    if (!storageWarned) {
      storageWarned = true;
      console.error('[sendLane] shared storage unavailable — lane is in-tab only:', err);
    }
    return null;
  }
}

function writeStored(h: StoredHold): void {
  withStorage((s) => s.setItem(storageKey(h.chatWid, h.id), JSON.stringify(h)));
}

function removeStored(chatWid: string, id: string): void {
  withStorage((s) => s.removeItem(storageKey(chatWid, id)));
}

function storedIsAlive(h: StoredHold, now: number): boolean {
  if (h.heartbeat > 0) {
    // Promise hold: fresh heartbeat, or the owning tab died but the batch
    // is still (estimated to be) sending server-side.
    if (now - h.heartbeat < HEARTBEAT_STALE_MS) return true;
    return now < h.until;
  }
  return now < h.until;
}

/** Live holds owned by OTHER tabs for this conversation. Dead entries found on
 *  the way are pruned (their owner is gone, nobody else will). */
function remoteHolds(chatWid: string): SendLaneHold[] {
  const now = Date.now();
  const prefix = `${STORAGE_PREFIX}${chatWid}:`;
  const out: SendLaneHold[] = [];
  withStorage((s) => {
    for (const key of s.keys()) {
      if (!key.startsWith(prefix)) continue;
      let parsed: StoredHold | null = null;
      try {
        parsed = JSON.parse(s.getItem(key) ?? 'null') as StoredHold | null;
      } catch {
        // Corrupt entry (partial write / foreign value under our prefix):
        // drop it — a hold nobody can read must not block the lane.
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
        s.removeItem(key);
        continue;
      }
      if (parsed.tabId === TAB_ID) continue;
      if (!storedIsAlive(parsed, now) || now - parsed.startedAt > UNTIL_HOLD_CEILING_MS) {
        s.removeItem(key);
        continue;
      }
      out.push({ id: parsed.id, label: parsed.label, startedAt: parsed.startedAt, remote: true });
    }
  });
  return out;
}

// ── pub/sub ─────────────────────────────────────────────────────────────────

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeSendLanes(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Current holds on a conversation's lane — this tab's and other tabs' —
 *  (empty → free). */
export function getSendLaneHolds(chatWid: string): readonly SendLaneHold[] {
  return [...(lanes.get(chatWid) ?? []), ...remoteHolds(chatWid)];
}

export function isSendLaneBusy(chatWid: string): boolean {
  if ((lanes.get(chatWid)?.length ?? 0) > 0) return true;
  return remoteHolds(chatWid).length > 0;
}

/** Sends currently parked behind a lane in THIS tab, across conversations. */
export function getSendLaneWaiterCount(): number {
  return waiters;
}

function removeHold(chatWid: string, id: string): void {
  const list = lanes.get(chatWid);
  if (!list) return;
  const next = list.filter((h) => h.id !== id);
  if (next.length === 0) lanes.delete(chatWid);
  else lanes.set(chatWid, next);
  emit();
}

/**
 * Hold the conversation's lane while `work` runs, or until the `until`
 * timestamp (ms) passes. Returns a release function — calling it early ends
 * the hold (e.g. the batch request failed before sending anything).
 *
 * `estimatedMs` (promise holds): how long the work is expected to take. Other
 * tabs keep honoring the hold for that long if THIS tab closes mid-way (the
 * request is `keepalive`, the server keeps sending). Defaults to the ceiling.
 *
 * A rejected `work` promise releases the hold like a resolved one; the caller
 * owns its own error handling.
 */
export function holdSendLane(
  chatWid: string,
  label: string,
  work: Promise<unknown> | { until: number },
  opts: { estimatedMs?: number } = {},
): () => void {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  let release: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const done = new Promise<void>((resolve) => {
    let settled = false;
    release = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (beat) clearInterval(beat);
      removeStored(chatWid, id);
      removeHold(chatWid, id);
      resolve();
    };

    if ('until' in work) {
      const delay = Math.min(UNTIL_HOLD_CEILING_MS, Math.max(0, work.until - startedAt));
      timer = setTimeout(release, delay);
      writeStored({ id, chatWid, label, tabId: TAB_ID, startedAt, until: startedAt + delay, heartbeat: 0 });
    } else {
      // Ceiling: a request that never settles must not freeze the chat.
      timer = setTimeout(() => {
        console.error(`[sendLane] hold "${label}" on ${chatWid} exceeded ${PROMISE_HOLD_CEILING_MS / 1000}s — releasing`);
        release();
      }, PROMISE_HOLD_CEILING_MS);
      const estimated = Math.min(PROMISE_HOLD_CEILING_MS, Math.max(0, opts.estimatedMs ?? PROMISE_HOLD_CEILING_MS));
      const stored: StoredHold = { id, chatWid, label, tabId: TAB_ID, startedAt, until: startedAt + estimated, heartbeat: startedAt };
      writeStored(stored);
      beat = setInterval(() => {
        stored.heartbeat = Date.now();
        writeStored(stored);
      }, HEARTBEAT_MS);
      work.then(release, release);
    }
  });

  const hold: InternalHold = { id, label, startedAt, remote: false, done };
  lanes.set(chatWid, [...(lanes.get(chatWid) ?? []), hold]);
  emit();
  return release;
}

// ── remote wake-up: storage events from other tabs ──────────────────────────

let remoteWakers = new Set<() => void>();

function wakeRemoteWaiters(): void {
  const current = remoteWakers;
  remoteWakers = new Set();
  for (const w of current) w();
  emit();
}

/** Resolves on the next cross-tab lane change, or after the poll interval. */
function remoteChange(): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      remoteWakers.delete(wake);
      resolve();
    }, REMOTE_POLL_MS);
    const wake = () => {
      clearTimeout(t);
      resolve();
    };
    remoteWakers.add(wake);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key == null || e.key.startsWith(STORAGE_PREFIX)) wakeRemoteWaiters();
  });
  // A parked send lives only in this tab — warn before it dies with the tab.
  // (The batch it waits on is server-owned and refresh-safe.)
  window.addEventListener('beforeunload', (e) => {
    if (waiters > 0) {
      e.preventDefault();
      // Legacy browsers need returnValue set to show the prompt.
      e.returnValue = '';
    }
  });
}

/**
 * Resolve once the conversation's lane is free — in this tab and in every
 * other tab of this browser. Re-checks after every wave of holds settles, so
 * a hold added while waiting is honored too (a second gallery queued behind
 * the first keeps the PDF behind both).
 *
 * `onWaiting` fires once if the lane was busy on entry — callers use it to
 * show "waiting for the media to finish" in their job entry.
 */
export async function waitForSendLane(
  chatWid: string,
  onWaiting?: (holds: readonly SendLaneHold[]) => void,
): Promise<void> {
  if (!isSendLaneBusy(chatWid)) return;
  waiters++;
  emit();
  try {
    onWaiting?.(getSendLaneHolds(chatWid));
    while (isSendLaneBusy(chatWid)) {
      const local = lanes.get(chatWid) ?? [];
      if (local.length > 0) {
        // Own-tab holds settle precisely; a remote change may free the lane
        // sooner only if there are no local holds, so race both.
        await Promise.race([Promise.all(local.map((h) => h.done)), remoteChange()]);
      } else {
        await remoteChange();
      }
    }
  } finally {
    waiters--;
    emit();
  }
}

/** One-line description of what the lane is waiting on, for job details. */
export function describeSendLaneHolds(holds: readonly SendLaneHold[], isAr: boolean): string {
  const names = holds.map((h) => `«${h.label}»`).join(isAr ? '، ' : ', ');
  return isAr ? `بانتظار انتهاء ${names}` : `Waiting for ${names} to finish`;
}

/** TEST-ONLY. */
export function __resetSendLanes(): void {
  lanes.clear();
  waiters = 0;
  remoteWakers = new Set();
  emit();
}

/** TEST-ONLY: swap the shared storage (null → in-tab only). */
export function __setSendLaneStorage(s: SendLaneStorage | null): void {
  storage = s;
  storageWarned = false;
}

/** TEST-ONLY: simulate another tab's `storage` event. */
export function __notifySendLaneStorageChange(): void {
  wakeRemoteWaiters();
}

/** TEST-ONLY: this tab's id (to author "remote" entries with a different one). */
export function __sendLaneTabId(): string {
  return TAB_ID;
}

/** TEST-ONLY: storage key prefix. */
export const __SEND_LANE_STORAGE_PREFIX = STORAGE_PREFIX;
