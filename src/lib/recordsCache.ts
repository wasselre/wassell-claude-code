// ─────────────────────────────────────────────────────────────────
// Phase E.2 — paginated records cache
//
// Pure reducers for the per-model record cache that backs the
// `loadRecordsPage` action in appStore.ts.
//
// One cache entry per model. The cache holds the rows accumulated
// from successive `record_search` RPC calls (Phase E.1). When the
// user changes filter/search, the cache is invalidated and a fresh
// page-1 load is issued.
//
// Realtime integration (C.3): the orchestrator's mergeRecord
// continues to update the legacy `records[modelId]` slice. A future
// pass can also feed events into this cache via `upsertRow` /
// `removeRow` so paginated consumers see live updates without a
// reload. For now, the cache is a snapshot at last-load time.
// ─────────────────────────────────────────────────────────────────

import type { AppRecord } from '../types';

export type PageCursor = { created_at: string; id: string } | null;

export interface RecordsPageCache {
  /** All rows fetched so far for this filter context, ordered
   *  created_at DESC, id DESC (matches record_search). */
  rows: AppRecord[];
  /** Cursor for the next call to record_search. Null when no more
   *  pages remain or before the first load. */
  nextCursor: PageCursor;
  /** True if record_search reported has_more on the last page. */
  hasMore: boolean;
  /** True while a fetch is in flight. Use to disable "Load More"
   *  buttons and avoid double-fires. */
  loading: boolean;
  /** Last error message, or null if the last fetch succeeded. */
  error: string | null;
  /** Stable hash of the filter context. Changing filterKey triggers
   *  a full reset (page 1) on next loadRecordsPage. */
  filterKey: string;
}

export type PaginatedRecordsByModel = Record<string, RecordsPageCache>;

/** Stable string key for a (filters, searchText) tuple. Same inputs
 *  always produce the same key — used to detect filter changes that
 *  should invalidate the cache. */
export function buildFilterKey(
  filters: Record<string, unknown> | undefined,
  searchText: string | undefined,
): string {
  // Stable key order so {a:1, b:2} and {b:2, a:1} match.
  const sortedFilters: Record<string, unknown> = {};
  if (filters) {
    for (const k of Object.keys(filters).sort()) sortedFilters[k] = filters[k];
  }
  return JSON.stringify({ f: sortedFilters, s: searchText ?? null });
}

export function emptyCache(filterKey: string): RecordsPageCache {
  return {
    rows: [],
    nextCursor: null,
    hasMore: true,
    loading: false,
    error: null,
    filterKey,
  };
}

/** Build a cursor from a row's (created_at, id). Used after a
 *  page load to advance to the next page. */
export function buildCursorFromRow(row: AppRecord | undefined): PageCursor {
  if (!row || !row.created_at) return null;
  return { created_at: row.created_at, id: row.id };
}

/** Append a freshly-fetched page to the cache. Dedupes by id in
 *  case of cursor-edge overlap (rare but handled). */
export function appendPage(
  cache: RecordsPageCache,
  newRows: AppRecord[],
  hasMore: boolean,
): RecordsPageCache {
  const byId = new Map<string, AppRecord>();
  for (const r of cache.rows) byId.set(r.id, r);
  for (const r of newRows) byId.set(r.id, r);
  const merged = Array.from(byId.values());
  // Re-sort by created_at DESC, id DESC to match server ordering — keeps
  // the rendered list in stable order even after realtime upserts.
  merged.sort((a, b) => {
    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    if (ca !== cb) return cb.localeCompare(ca);
    return b.id.localeCompare(a.id);
  });
  return {
    ...cache,
    rows: merged,
    nextCursor: newRows.length > 0
      ? buildCursorFromRow(newRows[newRows.length - 1])
      : cache.nextCursor,
    hasMore,
    loading: false,
    error: null,
  };
}

/** Mark a fetch as in flight. */
export function setLoading(cache: RecordsPageCache, loading: boolean): RecordsPageCache {
  return { ...cache, loading, error: loading ? null : cache.error };
}

/** Record a fetch error. */
export function setError(cache: RecordsPageCache, error: string): RecordsPageCache {
  return { ...cache, loading: false, error };
}

/** Apply a realtime UPSERT to the cache. If the row exists, replace
 *  in place. If it's new, prepend (newest at top, matches sort). */
export function upsertRow(cache: RecordsPageCache, row: AppRecord): RecordsPageCache {
  const idx = cache.rows.findIndex((r) => r.id === row.id);
  if (idx >= 0) {
    const next = cache.rows.slice();
    next[idx] = row;
    return { ...cache, rows: next };
  }
  return { ...cache, rows: [row, ...cache.rows] };
}

/** Apply a realtime DELETE to the cache. */
export function removeRow(cache: RecordsPageCache, id: string): RecordsPageCache {
  const next = cache.rows.filter((r) => r.id !== id);
  if (next.length === cache.rows.length) return cache;
  return { ...cache, rows: next };
}
