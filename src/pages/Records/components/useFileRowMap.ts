/**
 * Shared in-memory cache + React hook for resolving Files-System `files.id`
 * UUIDs to `FileRow` metadata. Used by `image`, `multi_image`, `file`,
 * `multi_file`, and `attachment` field inputs so multiple fields on the
 * same form don't re-query for the same id.
 *
 * The cache is process-lifetime (no TTL). Renames done anywhere in the app
 * (Files page, Drive picker, or a record-field preview) call
 * `updateFileRowCache`, which both refreshes the cached row AND notifies every
 * mounted `useFileRowMap` so chips/labels re-render with the new name live —
 * no reload needed.
 */
import { useEffect, useMemo, useState } from 'react';
import { getFile } from '@/lib/files/client';
import type { FileRow } from '@/types';

const fileRowCache = new Map<string, FileRow>();
const fileRowInflight = new Map<string, Promise<FileRow | null>>();
/** Mounted hooks subscribe here so a cache update can re-render them. */
const cacheSubscribers = new Set<() => void>();

export async function loadFileRow(id: string): Promise<FileRow | null> {
  const cached = fileRowCache.get(id);
  if (cached) return cached;
  const pending = fileRowInflight.get(id);
  if (pending) return pending;
  const p = getFile(id)
    .then((row) => {
      if (row) fileRowCache.set(id, row);
      return row;
    })
    .finally(() => {
      fileRowInflight.delete(id);
    });
  fileRowInflight.set(id, p);
  return p;
}

/**
 * Replace a cached file row (e.g. after a rename) and notify every mounted
 * `useFileRowMap` so the new metadata shows immediately. Safe to call with a
 * row whose id isn't cached yet — it just primes the cache.
 */
export function updateFileRowCache(row: FileRow): void {
  fileRowCache.set(row.id, row);
  cacheSubscribers.forEach((fn) => fn());
}

export function useFileRowMap(ids: readonly string[]): {
  rows: Map<string, FileRow>;
  missing: string[];
  loading: boolean;
} {
  const [rows, setRows] = useState<Map<string, FileRow>>(() => {
    const m = new Map<string, FileRow>();
    for (const id of ids) {
      const cached = fileRowCache.get(id);
      if (cached) m.set(id, cached);
    }
    return m;
  });
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const key = useMemo(() => ids.join('|'), [ids]);

  useEffect(() => {
    let cancelled = false;
    const toLoad = ids.filter((id) => !fileRowCache.has(id));
    if (toLoad.length === 0) {
      const next = new Map<string, FileRow>();
      const miss: string[] = [];
      for (const id of ids) {
        const c = fileRowCache.get(id);
        if (c) next.set(id, c);
        else miss.push(id);
      }
      setRows(next);
      setMissing(miss);
      return;
    }
    setLoading(true);
    void Promise.all(toLoad.map((id) => loadFileRow(id))).then((results) => {
      if (cancelled) return;
      const next = new Map<string, FileRow>();
      const miss: string[] = [];
      results.forEach((row, idx) => {
        const id = toLoad[idx]!;
        if (row) next.set(id, row);
        else miss.push(id);
      });
      for (const id of ids) {
        if (!next.has(id)) {
          const c = fileRowCache.get(id);
          if (c) next.set(id, c);
        }
      }
      setRows(next);
      setMissing(miss);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Re-render when a cached row this hook cares about is updated elsewhere
  // (e.g. renamed via a preview modal). Pulls the fresh row from the cache.
  useEffect(() => {
    const onCacheChange = () => {
      setRows((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const id of ids) {
          const cached = fileRowCache.get(id);
          if (cached && next.get(id) !== cached) {
            next.set(id, cached);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    cacheSubscribers.add(onCacheChange);
    return () => {
      cacheSubscribers.delete(onCacheChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { rows, missing, loading };
}
