/**
 * Micro-batching, TTL-cached signer for file VIEW urls.
 *
 * Record-list image cells each render one thumbnail and used to sign it with
 * its OWN `POST /api/files/sign-view-url` — so a list with an image column and
 * 50–100 visible rows fired 50–100 serverless round-trips on mount, and again
 * on every navigation back (nothing cached the signed URL). See the 2026-08
 * perf audit, finding B4.
 *
 * This coalesces every `resolveSignedViewUrl` call made within one animation
 * frame into a SINGLE `signViewUrls` batch request (the batch endpoint already
 * exists, is RLS-filtered, and caps at 200 ids/request — same one the Files
 * grid and the marketing library use), and caches each result with a TTL so a
 * remount / re-navigation reuses it instead of re-signing.
 *
 * Not a new signing subsystem — just a batching+caching front door onto the
 * existing `signViewUrls`.
 */
import { useEffect, useState } from 'react';
import { signViewUrls } from './client';

/** Matches MAX_BATCH in api/files/sign-view-urls.ts (larger batches truncate there). */
const SIGN_BATCH = 200;
/** Server signs with a 5-min TTL (VIEW_URL_TTL_SECONDS); expire a minute early
 *  so a cached URL handed to a freshly-mounted <img> is never already dead. */
const TTL_MS = 4 * 60 * 1000;
/** Coalescing window — one frame is enough to gather a table's worth of cells. */
const FLUSH_MS = 16;

const cache = new Map<string, { url: string; expires: number }>();
/** id → resolve fn for the batch currently being gathered. */
const pending = new Map<string, (url: string | null) => void>();
/** id → in-flight promise, so concurrent callers for one id share a request. */
const pendingPromises = new Map<string, Promise<string | null>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  flushTimer = null;
  const ids = Array.from(pending.keys());
  const resolvers = new Map(pending);
  pending.clear();
  for (const id of ids) pendingPromises.delete(id);

  const merged: Record<string, string> = {};
  try {
    for (let i = 0; i < ids.length; i += SIGN_BATCH) {
      Object.assign(merged, await signViewUrls(ids.slice(i, i + SIGN_BATCH)));
    }
  } catch (e) {
    // Fail loudly (CLAUDE.md "Silent Failures"): a blank thumbnail with a
    // silent console is exactly the trap. Every waiter resolves null below and
    // the cell renders its placeholder.
    console.error('[files] batch sign view urls failed', e);
  }

  const now = Date.now();
  for (const id of ids) {
    const url = merged[id] ?? null;
    if (url) cache.set(id, { url, expires: now + TTL_MS });
    resolvers.get(id)?.(url);
  }
}

/**
 * Resolve a signed VIEW url for a files.id, batched + cached. Returns null when
 * the id can't be viewed / signed. Legacy raw-URL values must be handled by the
 * caller (they need no signing) — pass only files.id UUIDs here.
 */
export function resolveSignedViewUrl(fileId: string): Promise<string | null> {
  const hit = cache.get(fileId);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.url);
  const existing = pendingPromises.get(fileId);
  if (existing) return existing;
  const p = new Promise<string | null>((resolve) => {
    pending.set(fileId, resolve);
  });
  pendingPromises.set(fileId, p);
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  return p;
}

/** Synchronous cache peek — lets a hook paint instantly on remount. */
function cachedUrl(fileId: string): string | null {
  const hit = cache.get(fileId);
  return hit && hit.expires > Date.now() ? hit.url : null;
}

/**
 * Hook: a signed VIEW url for a files.id (or a legacy raw URL returned verbatim),
 * batched + cached across every cell on screen. `null` while loading or when the
 * id can't be resolved.
 */
export function useSignedViewUrl(fileId: string | null | undefined): string | null {
  const isRaw = !!fileId && /^https?:\/\//i.test(fileId);
  const [url, setUrl] = useState<string | null>(() => {
    if (!fileId) return null;
    if (isRaw) return fileId;
    return cachedUrl(fileId);
  });

  useEffect(() => {
    if (!fileId) { setUrl(null); return; }
    if (isRaw) { setUrl(fileId); return; }
    const cached = cachedUrl(fileId);
    if (cached) { setUrl(cached); return; }
    let cancelled = false;
    void resolveSignedViewUrl(fileId).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [fileId, isRaw]);

  return url;
}
