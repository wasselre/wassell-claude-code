/**
 * Per-conversation composer drafts that survive leaving the chat, navigating
 * away, and a full page reload.
 *
 * Two stores, chosen deliberately:
 *   • TEXT + template-attachment metadata → localStorage. Small and readable
 *     SYNCHRONOUSLY, so a restored draft paints on first render with no flash
 *     of an empty box.
 *   • A picked local FILE → IndexedDB. A File/Blob cannot go in localStorage,
 *     and we deliberately do NOT upload on pick: an unsent attachment must not
 *     leave bytes on the server. IndexedDB keeps the actual file locally until
 *     the user really sends it.
 *
 * Everything is keyed by chat wid, so drafts for different conversations never
 * collide. Failures are non-fatal: a draft is a convenience, never a reason to
 * break the composer (private-mode / quota / blocked IndexedDB all degrade to
 * "no draft" rather than throwing).
 */

const TEXT_KEY = (wid: string) => `wassell_chat_draft_text:${wid}`;
const META_KEY = (wid: string) => `wassell_chat_draft_meta:${wid}`;

const DB_NAME = 'wassell-chat-drafts';
const DB_VERSION = 1;
const STORE = 'files';

/** Template attachment (already uploaded — only its reference is stored). */
export interface DraftTemplateMeta {
  fileId: string;
  mime: string | null;
  size: number | null;
  filename: string | null;
  mediaKind: string | null;
}

// ─── text ────────────────────────────────────────────────────────────

export function loadDraftText(wid: string): string {
  try {
    return localStorage.getItem(TEXT_KEY(wid)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraftText(wid: string, text: string): void {
  try {
    if (text.trim().length === 0) localStorage.removeItem(TEXT_KEY(wid));
    else localStorage.setItem(TEXT_KEY(wid), text);
  } catch (err) {
    // Quota or private mode — the composer still works, the draft just
    // won't survive a reload. Surfaced in the console, never thrown.
    console.error('[drafts] saveDraftText failed:', err);
  }
}

// ─── template attachment metadata ────────────────────────────────────

export function loadDraftTemplateMeta(wid: string): DraftTemplateMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY(wid));
    return raw ? (JSON.parse(raw) as DraftTemplateMeta) : null;
  } catch {
    return null;
  }
}

export function saveDraftTemplateMeta(wid: string, meta: DraftTemplateMeta | null): void {
  try {
    if (!meta) localStorage.removeItem(META_KEY(wid));
    else localStorage.setItem(META_KEY(wid), JSON.stringify(meta));
  } catch (err) {
    console.error('[drafts] saveDraftTemplateMeta failed:', err);
  }
}

// ─── local file (IndexedDB) ──────────────────────────────────────────

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.error('[drafts] IndexedDB open failed:', req.error?.message);
        resolve(null);
      };
    } catch (err) {
      console.error('[drafts] IndexedDB unavailable:', err);
      resolve(null);
    }
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.error('[drafts] IndexedDB op failed:', req.error?.message);
        resolve(null);
      };
      tx.oncomplete = () => db.close();
    } catch (err) {
      console.error('[drafts] IndexedDB transaction failed:', err);
      db.close();
      resolve(null);
    }
  });
}

interface StoredFile { blob: Blob; name: string; type: string }

/** Persist the picked files so they survive a reload. Nothing is uploaded. */
export async function saveDraftFiles(wid: string, files: File[]): Promise<void> {
  if (files.length === 0) { await clearDraftFiles(wid); return; }
  const payload: StoredFile[] = files.map((f) => ({ blob: f, name: f.name, type: f.type }));
  await withStore('readwrite', (s) => s.put({ files: payload }, wid) as IDBRequest<IDBValidKey>);
}

/** Restore the picked files (rebuilt as File objects so send treats them identically). */
export async function loadDraftFiles(wid: string): Promise<File[]> {
  const rec = (await withStore('readonly', (s) => s.get(wid) as IDBRequest<unknown>)) as
    | { files?: StoredFile[] }
    // Back-compat with the earlier single-file shape { blob, name, type }.
    | { blob?: Blob; name?: string; type?: string }
    | undefined
    | null;
  if (!rec) return [];
  const list: StoredFile[] = Array.isArray((rec as { files?: StoredFile[] }).files)
    ? (rec as { files: StoredFile[] }).files
    : (rec as StoredFile).blob
      ? [rec as StoredFile]
      : [];
  const out: File[] = [];
  for (const r of list) {
    if (!r?.blob) continue;
    try {
      out.push(new File([r.blob], r.name || 'attachment', { type: r.type || r.blob.type }));
    } catch { /* skip an unrebuildable blob */ }
  }
  return out;
}

export async function clearDraftFiles(wid: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(wid) as IDBRequest<undefined>);
}

/** Clear everything for one conversation — call after a successful send. */
export async function clearDraft(wid: string): Promise<void> {
  saveDraftText(wid, '');
  saveDraftTemplateMeta(wid, null);
  await clearDraftFiles(wid);
}
