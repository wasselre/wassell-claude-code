// ─────────────────────────────────────────────────────────────────
// Echo dedup for the RealtimeOrchestrator.
//
// Problem: when this client writes a row, Supabase Realtime echoes
// the change back to us via the publication. Without dedup we'd
// re-apply our own write to local state, causing redundant React
// re-renders and (worse) racing with optimistic updates.
//
// Approach: every successful write registers `<table>:<id>` here
// with a timestamp. Realtime merge handlers consult `wasRecentlyWritten`
// before applying — if a row id was just written by us, skip it.
//
// TTL = 30s. The realtime echo typically arrives within 100ms of the
// HTTP write completing, but we leave a generous window for laggy
// connections. Entries past TTL are GC'd lazily on next access.
// ─────────────────────────────────────────────────────────────────

const recent = new Map<string, number>();
const TTL_MS = 30_000;

function key(table: string, id: string): string {
  return `${table}:${id}`;
}

/** Mark a (table, id) as recently written by THIS client. Called on
 *  successful Supabase upsert/delete to suppress the echo from the
 *  realtime channel. */
export function markRecentlyWritten(table: string, id: string): void {
  recent.set(key(table, id), Date.now());
  // Opportunistic GC — keeps the map from unbounded growth on long
  // sessions. Only sweeps when the map exceeds a soft threshold.
  if (recent.size > 256) {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, ts] of recent.entries()) {
      if (ts < cutoff) recent.delete(k);
    }
  }
}

/** Was this (table, id) written by us within the dedup window?
 *  Removes the entry on a true return so the next echo for the same
 *  id (e.g. a real concurrent edit) is not falsely suppressed. */
export function wasRecentlyWritten(table: string, id: string): boolean {
  const k = key(table, id);
  const ts = recent.get(k);
  if (ts === undefined) return false;
  if (Date.now() - ts > TTL_MS) {
    recent.delete(k);
    return false;
  }
  recent.delete(k);
  return true;
}

/** Test/debug: clear all entries. */
export function _resetRecentlyWritten(): void {
  recent.clear();
}
