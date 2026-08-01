/**
 * Offline shooting engine — screen 30's "no bars on site" mode.
 *
 * A photographer standing in a basement parking level with zero connectivity
 * must be able to (a) tick shoot-list items done and (b) capture photos and
 * videos, and have both survive a page reload, a phone standby, and a full
 * browser kill. Everything lands in IndexedDB first; reconciliation with the
 * server happens later, automatically, when connectivity returns.
 *
 * Why IndexedDB and not localStorage: captures are multi-megabyte Blobs.
 * localStorage is synchronous, string-only, and capped around 5–10 MB — one
 * 4K clip would blow straight through it. IndexedDB stores Blobs natively
 * (structured clone), is asynchronous, and its quota is negotiated with the
 * browser in the hundreds of MB.
 *
 * Why the FOREGROUND drain is the reliable path: Background Sync
 * (registration.sync) is Chromium-only, requires the service worker to
 * actually handle the tag, and is throttled by the browser on its own
 * schedule. We register the tag where it exists — a free bonus wake-up —
 * but the drains that ALWAYS run are: on module init, on the 'online'
 * event, and on visibilitychange back to visible. No claimed background
 * behavior the platform can't provide.
 *
 * No-silent-failure rule (repo-wide hard rule): every catch in this file is
 * scoped, commented, and console.error'd at minimum. A queue that loses a
 * shoot silently is worse than no queue at all — the photographer would
 * drive home believing the office has the photos.
 */
import { uploadToStorage, storagePath } from './upload';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface QueuedTick {
  id: string;
  kind: 'shoot_item_toggle';
  shootItemId: string;
  done: boolean;
  queuedAt: string; // ISO
  attempts: number;
  lastError?: string;
}

export type CaptureStatus = 'queued' | 'uploading' | 'failed';

/** The row as stored in IndexedDB — blob included. */
export interface QueuedCapture extends QueuedCaptureMeta {
  blob: Blob;
}

/** Metadata-only view of a capture, safe for UI rendering lists. */
export interface QueuedCaptureMeta {
  /** The future asset id — assigned at enqueue so upload path is stable. */
  id: string;
  kind: 'capture';
  shootRequestId: string;
  fileName: string;
  mimeType: string;
  size: number;
  note?: string;
  queuedAt: string; // ISO
  attempts: number;
  status: CaptureStatus;
  lastError?: string;
}

export interface OfflineQueueState {
  ticks: QueuedTick[];
  captures: QueuedCaptureMeta[];
  draining: boolean;
}

export interface DrainHandlers {
  toggleShootItem: (shootItemId: string, done: boolean) => Promise<void>;
  registerAsset: (meta: {
    assetId: string;
    shootRequestId: string;
    fileName: string;
    mimeType: string;
    size: number;
    storagePath: string;
    publicUrl: string;
    note?: string;
  }) => Promise<void>;
}

export interface DrainResult {
  ticksSynced: number;
  capturesSynced: number;
  /** Items that failed this pass but remain queued for the next one. */
  failed: number;
  /** Items at the attempts ceiling — parked until explicit retryItem(). */
  parked: number;
}

/** Storage-full error with a bilingual message pair the UI can toast. */
export class OfflineQuotaError extends Error {
  readonly message_ar: string;
  readonly message_en: string;
  constructor() {
    super('offline storage is full');
    this.name = 'OfflineQuotaError';
    this.message_ar = 'ذاكرة الهاتف ممتلئة — احذف بعض الملفات ثم أعد المحاولة';
    this.message_en = 'Phone storage is full — free some space and try again';
  }
}

/** Items at this many attempts stop auto-draining until retryItem(). */
const MAX_ATTEMPTS = 8;

/* ------------------------------------------------------------------ */
/* IndexedDB plumbing                                                  */
/* ------------------------------------------------------------------ */

const DB_NAME = 'mos-offline';
const DB_VERSION = 1;
const STORE_TICKS = 'ticks';
const STORE_CAPTURES = 'captures';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      dbPromise = null;
      reject(new Error('IndexedDB is unavailable — offline queue cannot persist'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TICKS)) {
        db.createObjectStore(STORE_TICKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CAPTURES)) {
        db.createObjectStore(STORE_CAPTURES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null; // let the next call retry instead of caching a corpse
      reject(req.error ?? new Error('failed to open offline database'));
    };
    req.onblocked = () => {
      console.error('[mos-offline] database upgrade blocked by another tab');
      reject(new Error('offline database blocked by another tab'));
    };
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('offline transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('offline transaction failed'));
  });
}

async function putRow(store: string, row: QueuedTick | QueuedCapture): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(row);
  await txDone(tx);
}

async function deleteRow(store: string, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await txDone(tx);
}

function getAllRows<T>(store: string): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error ?? new Error(`failed to read ${store}`));
      }),
  );
}

/* ------------------------------------------------------------------ */
/* Subscribers — the UI renders queued/uploading/failed chips live     */
/* ------------------------------------------------------------------ */

type Listener = (state: OfflineQueueState) => void;
const listeners = new Set<Listener>();
let draining = false;

export async function listQueue(): Promise<OfflineQueueState> {
  const [ticks, captures] = await Promise.all([
    getAllRows<QueuedTick>(STORE_TICKS),
    getAllRows<QueuedCapture>(STORE_CAPTURES),
  ]);
  const byQueuedAt = (a: { queuedAt: string }, b: { queuedAt: string }): number =>
    a.queuedAt.localeCompare(b.queuedAt);
  return {
    ticks: ticks.sort(byQueuedAt),
    captures: captures
      .sort(byQueuedAt)
      // Strip the blob — list consumers get metadata only; the blob is
      // re-read from the store at drain time.
      .map((c) => {
        const meta: QueuedCaptureMeta = { ...c };
        delete (meta as Partial<QueuedCapture>).blob;
        return meta;
      }),
    draining,
  };
}

function notify(): void {
  if (listeners.size === 0) return;
  listQueue()
    .then((state) => listeners.forEach((fn) => fn(state)))
    .catch((err: unknown) => {
      // A failed refresh must not kill the listener set — but it must be
      // loud, per the repo rule. The next mutation retries the refresh.
      console.error('[mos-offline] failed to refresh queue state', err);
    });
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  notify();
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ */
/* Enqueue + Background Sync hint                                      */
/* ------------------------------------------------------------------ */

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Best-effort Background Sync registration. SyncManager is Chromium-only
 * and the existing service worker may not handle the tag — both are fine,
 * because the foreground drain (online / visibilitychange / init) is the
 * authoritative path. Failure here only means we rely on that path.
 */
function hintBackgroundSync(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => {
      const syncReg = reg as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      };
      if (!syncReg.sync) return;
      return syncReg.sync.register('mos-offline-drain');
    })
    .catch((err: unknown) => {
      console.error('[mos-offline] background-sync registration failed (foreground path still active)', err);
    });
}

export async function enqueueTick(shootItemId: string, done: boolean): Promise<void> {
  const tick: QueuedTick = {
    id: newId(),
    kind: 'shoot_item_toggle',
    shootItemId,
    done,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  await putRow(STORE_TICKS, tick);
  hintBackgroundSync();
  notify();
}

export async function enqueueCapture(input: {
  shootRequestId: string;
  file: File;
  note?: string;
}): Promise<string> {
  const capture: QueuedCapture = {
    id: newId(),
    kind: 'capture',
    shootRequestId: input.shootRequestId,
    fileName: input.file.name,
    mimeType: input.file.type || 'application/octet-stream',
    size: input.file.size,
    blob: input.file,
    note: input.note,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    status: 'queued',
  };
  try {
    await putRow(STORE_CAPTURES, capture);
  } catch (err) {
    // Scoped: a full disk is the ONE enqueue failure the user can act on, so
    // it gets a typed bilingual error for the toast. Anything else rethrows
    // as-is — never silently drop a captured photo.
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.error('[mos-offline] storage quota exceeded on capture enqueue', err);
      throw new OfflineQuotaError();
    }
    console.error('[mos-offline] failed to persist capture', err);
    throw err;
  }
  hintBackgroundSync();
  notify();
  return capture.id;
}

/* ------------------------------------------------------------------ */
/* Drain                                                               */
/* ------------------------------------------------------------------ */

let drainInFlight: Promise<DrainResult> | null = null;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function drainTick(tick: QueuedTick, handlers: DrainHandlers): Promise<'synced' | 'failed'> {
  const bumped: QueuedTick = { ...tick, attempts: tick.attempts + 1 };
  try {
    await handlers.toggleShootItem(tick.shootItemId, tick.done);
    await deleteRow(STORE_TICKS, tick.id);
    return 'synced';
  } catch (err) {
    // One poisoned tick must not block the queue — record and continue.
    console.error(`[mos-offline] tick ${tick.id} failed (attempt ${bumped.attempts})`, err);
    await putRow(STORE_TICKS, { ...bumped, lastError: describeError(err) });
    return 'failed';
  }
}

async function drainCapture(
  capture: QueuedCapture,
  handlers: DrainHandlers,
): Promise<'synced' | 'failed'> {
  const bumped: QueuedCapture = { ...capture, attempts: capture.attempts + 1 };
  try {
    await putRow(STORE_CAPTURES, { ...bumped, status: 'uploading' });
    notify();
    const file = new File([capture.blob], capture.fileName, { type: capture.mimeType });
    const path = storagePath(capture.id, capture.fileName);
    const { publicUrl } = await uploadToStorage(file, path, () => {
      // Progress fractions could stream to subscribers here; the status flip
      // to 'uploading' already drives the chip, and per-chunk notifications
      // would re-read both stores on every XHR progress event.
    });
    await handlers.registerAsset({
      assetId: capture.id,
      shootRequestId: capture.shootRequestId,
      fileName: capture.fileName,
      mimeType: capture.mimeType,
      size: capture.size,
      storagePath: path,
      publicUrl,
      note: capture.note,
    });
    await deleteRow(STORE_CAPTURES, capture.id);
    return 'synced';
  } catch (err) {
    console.error(`[mos-offline] capture ${capture.id} failed (attempt ${bumped.attempts})`, err);
    await putRow(STORE_CAPTURES, { ...bumped, status: 'failed', lastError: describeError(err) });
    return 'failed';
  }
}

async function runDrain(handlers: DrainHandlers): Promise<DrainResult> {
  const result: DrainResult = { ticksSynced: 0, capturesSynced: 0, failed: 0, parked: 0 };
  draining = true;
  notify();
  try {
    // Ticks first — cheap JSON calls that unblock the office's shoot list.
    const ticks = await getAllRows<QueuedTick>(STORE_TICKS);
    ticks.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const tick of ticks) {
      if (tick.attempts >= MAX_ATTEMPTS) {
        result.parked += 1;
        continue;
      }
      const outcome = await drainTick(tick, handlers);
      if (outcome === 'synced') result.ticksSynced += 1;
      else result.failed += 1;
      notify();
    }
    // Then captures, oldest-first.
    const captures = await getAllRows<QueuedCapture>(STORE_CAPTURES);
    captures.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const capture of captures) {
      if (capture.attempts >= MAX_ATTEMPTS) {
        result.parked += 1;
        continue;
      }
      const outcome = await drainCapture(capture, handlers);
      if (outcome === 'synced') result.capturesSynced += 1;
      else result.failed += 1;
      notify();
    }
  } finally {
    draining = false;
    notify();
  }
  return result;
}

/** Single-flight: a drain already running is never doubled. */
export function drain(handlers: DrainHandlers): Promise<DrainResult> {
  if (drainInFlight) return drainInFlight;
  drainInFlight = runDrain(handlers).finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

/** Reset a parked/failed item so the next drain picks it up again. */
export async function retryItem(id: string): Promise<void> {
  const ticks = await getAllRows<QueuedTick>(STORE_TICKS);
  const tick = ticks.find((t) => t.id === id);
  if (tick) {
    const reset: QueuedTick = { ...tick, attempts: 0 };
    delete reset.lastError;
    await putRow(STORE_TICKS, reset);
    notify();
    return;
  }
  const captures = await getAllRows<QueuedCapture>(STORE_CAPTURES);
  const capture = captures.find((c) => c.id === id);
  if (capture) {
    const reset: QueuedCapture = { ...capture, attempts: 0, status: 'queued' };
    delete reset.lastError;
    await putRow(STORE_CAPTURES, reset);
    notify();
    return;
  }
  // Loud, not silent: retrying an id that doesn't exist is a UI bug.
  throw new Error(`offline queue item not found: ${id}`);
}

/* ------------------------------------------------------------------ */
/* Auto-drain wiring                                                   */
/* ------------------------------------------------------------------ */

export function isOnline(): boolean {
  return navigator.onLine;
}

/**
 * Wires the three foreground triggers — 'online', visibilitychange back to
 * visible, and an immediate attempt if we're online right now — plus the
 * module-init attempt. Returns a teardown function.
 */
export function startAutoDrain(handlers: DrainHandlers): () => void {
  const attempt = (): void => {
    if (!isOnline()) return;
    drain(handlers).catch((err: unknown) => {
      // drain() itself only rejects on store-level failure (per-item errors
      // are captured in DrainResult) — still surface it, never swallow.
      console.error('[mos-offline] auto-drain failed', err);
    });
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') attempt();
  };

  window.addEventListener('online', attempt);
  document.addEventListener('visibilitychange', onVisibility);
  attempt(); // module-init / call-time attempt

  return () => {
    window.removeEventListener('online', attempt);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
