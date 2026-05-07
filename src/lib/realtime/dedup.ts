// ─────────────────────────────────────────────────────────────────
// Echo dedup for the RealtimeOrchestrator.
//
// Problem: when this client writes a row, Supabase Realtime echoes
// the change back to us via the publication. Without dedup we'd
// re-apply our own write to local state, causing redundant React
// re-renders and (worse) racing with optimistic updates.
//
// Approach (audit fix H1 — was a 30s wall-clock TTL):
// Every successful write registers `<table>:<id>` here ALONG WITH
// the `updated_at` of the row we just wrote. Realtime merge handlers
// pass the incoming row's `updated_at` to `wasEchoOf(...)`. We treat
// the incoming event as our own echo IFF the last `updated_at` we
// wrote is >= the incoming `updated_at` — meaning realtime is
// echoing back something we already have. This is timing-independent:
// a 30-minute backlog still dedups correctly, and a real concurrent
// edit (with a strictly newer updated_at) is never falsely suppressed.
//
// We retain a 5-minute soft TTL on the map so it doesn't grow
// unbounded on long sessions, but the TTL is no longer load-bearing
// for correctness — it's just a memory floor.
// ─────────────────────────────────────────────────────────────────

interface DedupEntry {
  /** ISO timestamp of the row we wrote, used for the equal-or-newer compare. */
  writtenUpdatedAt: string | null;
  /** Wall-clock time the entry was registered, used only for soft-TTL GC. */
  registeredAt: number;
}

const recent = new Map<string, DedupEntry>();
/**
 * Soft TTL — entries older than this get GC'd opportunistically. NOT a
 * correctness boundary anymore: dedup uses `updated_at` comparison.
 * Long enough that even an hour-long disconnection followed by a
 * realtime reconnect typically still has the entry to compare against
 * for very recent writes; short enough that the map stays small.
 */
const SOFT_TTL_MS = 5 * 60_000;
const GC_THRESHOLD = 1024;

function key(table: string, id: string): string {
  return `${table}:${id}`;
}

/**
 * Mark a (table, id) as recently written by THIS client.
 *
 * @param table - the Supabase table the write targeted
 * @param id    - the row id
 * @param updatedAt - the `updated_at` of the row we just wrote, as it
 *                   should appear in the realtime echo. Pass null only
 *                   if the table doesn't have an `updated_at` column,
 *                   in which case dedup falls back to time-only.
 */
export function markRecentlyWritten(
  table: string,
  id: string,
  updatedAt: string | null = null,
): void {
  recent.set(key(table, id), {
    writtenUpdatedAt: updatedAt,
    registeredAt: Date.now(),
  });
  if (recent.size > GC_THRESHOLD) {
    const cutoff = Date.now() - SOFT_TTL_MS;
    for (const [k, entry] of recent.entries()) {
      if (entry.registeredAt < cutoff) recent.delete(k);
    }
  }
}

/**
 * True when the incoming realtime event matches a write THIS client
 * just made — i.e. the row's incoming `updated_at` is no newer than
 * the `updated_at` we registered when we wrote.
 *
 * @param table             - the Supabase table the event came on
 * @param id                - the row id
 * @param incomingUpdatedAt - the `updated_at` of the incoming row.
 *                            Pass null when the payload doesn't carry
 *                            it (REPLICA IDENTITY DEFAULT — only PK)
 *                            and we fall back to "any registered entry
 *                            within soft TTL counts as our echo."
 *
 * Removes the entry on a match so the next echo (from a real
 * subsequent write) is never falsely suppressed.
 */
export function wasEchoOf(
  table: string,
  id: string,
  incomingUpdatedAt: string | null,
): boolean {
  const k = key(table, id);
  const entry = recent.get(k);
  if (entry === undefined) return false;
  // Soft-TTL fallback only kicks in for the time-only case.
  const expired = Date.now() - entry.registeredAt > SOFT_TTL_MS;
  if (expired && (entry.writtenUpdatedAt === null || incomingUpdatedAt === null)) {
    recent.delete(k);
    return false;
  }
  // Authoritative case: compare updated_at. Strings are ISO 8601 from
  // Postgres, so lexicographic compare is correct as long as both sides
  // use the same precision (Postgres timestamptz emits microseconds).
  if (entry.writtenUpdatedAt !== null && incomingUpdatedAt !== null) {
    if (entry.writtenUpdatedAt >= incomingUpdatedAt) {
      // Echo or older — definitely ours.
      recent.delete(k);
      return true;
    }
    // Real concurrent edit (newer). Don't dedup, and remove our entry
    // so subsequent echoes of the NEW write aren't silently squashed.
    recent.delete(k);
    return false;
  }
  // Fallback (one side missing updated_at): treat as ours within soft TTL.
  recent.delete(k);
  return true;
}

/**
 * @deprecated Use {@link wasEchoOf} which does updated_at comparison.
 * Retained as a thin shim for callers that still pass only (table, id).
 * Returns true if there's any registered entry within soft-TTL.
 */
export function wasRecentlyWritten(table: string, id: string): boolean {
  return wasEchoOf(table, id, null);
}

/** Test/debug: clear all entries. */
export function _resetRecentlyWritten(): void {
  recent.clear();
}
