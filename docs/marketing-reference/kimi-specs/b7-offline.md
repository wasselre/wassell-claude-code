TASK: Write ONE new file: src/pages/Marketing/lib/offline.ts — the genuine offline shooting engine for the Marketing workspace (mobile site-shoot mode, design screen 30). Write the file only; do not modify other files (the UI wiring happens in a later task, but export a complete, typed API for it).

CONTEXT: React 18 + TS + Vite app. Coding rules: NO `any` type anywhere; explicit interfaces; loud failures (never swallow an error silently — the repo has a hard rule about this; every catch must be scoped, commented, and console.error at minimum). Sibling module src/pages/Marketing/lib/upload.ts exports uploadToStorage(file, path, onProgress, signal) -> Promise<{path, publicUrl}> and storagePath(assetId, fileName) — READ IT first; this module integrates with it.

WHAT IT DOES: a photographer on a site with no connectivity must be able to (a) tick shoot-list items done and (b) capture/attach photo+video files; both survive page reloads and phone standby, then reconcile automatically when connectivity returns. Truthfulness rule: no claimed background behavior the platform can't provide — Background Sync is used only where available (feature-detect); the ALWAYS-reliable path is foreground drain on 'online' events + on module init + on visibilitychange resume.

IMPLEMENT with IndexedDB (raw indexedDB API, no dependency):
- DB 'mos-offline' v1, two object stores:
  - 'ticks': { id (uuid), kind: 'shoot_item_toggle', shootItemId: string, done: boolean, queuedAt: string ISO, attempts: number, lastError?: string }
  - 'captures': { id (uuid = the future asset id), kind: 'capture', shootRequestId: string, fileName: string, mimeType: string, size: number, blob: Blob (Blobs ARE structured-cloneable into IndexedDB), note?: string, queuedAt: string, attempts: number, status: 'queued'|'uploading'|'failed', lastError?: string }
- Public API (all typed, all Promise-based):
  - enqueueTick(shootItemId: string, done: boolean): Promise<void>
  - enqueueCapture(input: { shootRequestId: string; file: File; note?: string }): Promise<string> — returns the asset id
  - listQueue(): Promise<OfflineQueueState> where OfflineQueueState = { ticks: QueuedTick[]; captures: QueuedCaptureMeta[] (no blob — metadata only); draining: boolean }
  - subscribe(listener: (s: OfflineQueueState) => void): () => void — fires on every queue mutation and drain progress; implement with a simple listener set + a refresh helper.
  - drain(handlers: DrainHandlers): Promise<DrainResult> where DrainHandlers = { toggleShootItem: (shootItemId: string, done: boolean) => Promise<void>; registerAsset: (meta: { assetId: string; shootRequestId: string; fileName: string; mimeType: string; size: number; storagePath: string; publicUrl: string; note?: string }) => Promise<void> } — the UI passes API-calling closures; this module stays transport-agnostic except uploads: captures upload their blob via uploadToStorage(new File([blob], fileName, {type: mimeType}), storagePath(assetId, fileName), progressCb) BEFORE calling registerAsset.
  - startAutoDrain(handlers: DrainHandlers): () => void — wires 'online' + visibilitychange listeners + immediate attempt when navigator.onLine; returns a teardown fn. Single-flight: a drain already running is never doubled (module-level promise guard).
  - isOnline(): boolean (navigator.onLine).
- Drain semantics: ticks first (cheap), then captures oldest-first. Per item: mark attempts+=1; on success remove from store; on failure set status 'failed' + lastError and CONTINUE with the next item (one poisoned item must not block the queue); items with attempts >= 8 stay in the store flagged failed until the user retries explicitly — export retryItem(id: string): Promise<void> that resets attempts/status to queued.
- Background Sync: after enqueue, if ('serviceWorker' in navigator) and registration.sync exists, register tag 'mos-offline-drain' inside a scoped try/catch (comment: SyncManager is Chromium-only; failure only means we rely on the foreground path) — the existing service worker may not handle the tag; that is fine because the foreground path is authoritative. Do NOT modify sw.js.
- Every state transition calls the subscribers so the UI can render queued/uploading/failed/retry chips live.
- Storage pressure: catch QuotaExceededError specifically on enqueueCapture, rethrow a typed OfflineQuotaError with a bilingual-ready message field pair {message_ar, message_en} so the UI can toast it.

Module tone: file-header comment explaining the design (why IndexedDB, why foreground drain is the reliable path, the no-silent-failure rule). ~250-350 lines. When done print exactly: OFFLINE-ENGINE WRITTEN.
