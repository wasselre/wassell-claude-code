// Conflict-storm CLIENT breaker — the per-record kill-switch state machine.
//
// Extracted from appStore (T1 validation, 2026-06-24) into a pure module so it
// can be unit-tested in the repo's node test env like the other lib units — it
// has NO DB / DOM / store imports, only Date.now + in-memory Maps.
//
// `record_save` rejects a write whose `p_expected_version` is behind the row's
// current version (SQLSTATE 40001 / "version_mismatch"); the server can also
// terminally reject with `conflict_storm_blocked`. A stale tab that re-sends the
// same stale version loops and pins Postgres CPU. This breaker bounds the blast
// radius: count conflicts per record in a short window; once a record trips (or
// is force-wedged) STOP issuing saves for it until a SUCCESSFUL save or a page
// reload (which resets this module state). It also caps reload-on-conflict to
// ONE retry per record (the repeated clear→retry→conflict cycle was the storm
// engine — see appStore's reload-on-conflict + the T1 audit).

export const RECORD_CONFLICT_LIMIT = 4;
export const RECORD_CONFLICT_WINDOW_MS = 10_000;
/** Reloads-on-conflict allowed per record before it is treated as WEDGED. */
export const MAX_RELOAD_RETRIES = 1;

interface ConflictState {
  count: number;
  first: number;
  tripped: boolean;
}

const recordConflicts = new Map<string, ConflictState>();
const recordReloadAttempts = new Map<string, number>();

/** Returns true the moment a record crosses the conflict threshold (so the
 *  caller can fire exactly one toast). Once tripped the breaker is PERMANENT
 *  until clearRecordConflict / a page reload — a wedged client never re-opens
 *  it on a timer. */
export function noteRecordConflict(id: string): boolean {
  const now = Date.now();
  const cur = recordConflicts.get(id);
  if (!cur) {
    recordConflicts.set(id, { count: 1, first: now, tripped: false });
    return false;
  }
  if (cur.tripped) return false;
  // Still counting toward the trip: only the COUNTING window rolls over.
  if (now - cur.first > RECORD_CONFLICT_WINDOW_MS) {
    recordConflicts.set(id, { count: 1, first: now, tripped: false });
    return false;
  }
  cur.count += 1;
  if (cur.count >= RECORD_CONFLICT_LIMIT) {
    cur.tripped = true;
    return true;
  }
  return false;
}

/** Whether saves for this record are currently short-circuited. */
export function recordSaveBlocked(id: string): boolean {
  return recordConflicts.get(id)?.tripped ?? false;
}

/** Force the per-record breaker permanently tripped — the server terminally
 *  blocked the record/session, or it stayed wedged after its one allowed
 *  reload. Immediate + terminal until a successful save / page reload. */
export function markRecordWedged(id: string): void {
  recordConflicts.set(id, { count: RECORD_CONFLICT_LIMIT, first: Date.now(), tripped: true });
}

/** Release the breaker so exactly ONE reload-and-retry may proceed, WITHOUT
 *  resetting the reload-attempt counter — so a recurrence is still capped. */
export function releaseBreakerForRetry(id: string): void {
  recordConflicts.delete(id);
}

/** Clear the breaker AND the reload-attempt counter — called after any
 *  SUCCESSFUL save, restoring the fresh one-reload allowance. */
export function clearRecordConflict(id: string): void {
  recordConflicts.delete(id);
  recordReloadAttempts.delete(id);
}

/** How many reload-and-retry passes this record has consumed since its last
 *  successful save. */
export function getReloadAttempts(id: string): number {
  return recordReloadAttempts.get(id) ?? 0;
}

/** Record one reload-and-retry pass; returns the new attempt count. */
export function noteReloadAttempt(id: string): number {
  const n = getReloadAttempts(id) + 1;
  recordReloadAttempts.set(id, n);
  return n;
}

/** True once a record has exhausted its reload allowance (→ wedge + hard-stop
 *  instead of re-fetching again). */
export function reachedReloadCap(id: string): boolean {
  return getReloadAttempts(id) >= MAX_RELOAD_RETRIES;
}

/** Decide whether a form should adopt the store's advanced version into its
 *  (otherwise frozen) snapshot. Only when armed by a prior version_mismatch AND
 *  the live store version actually moved past the snapshot — so an UNRELATED
 *  realtime bump (not armed) is never silently adopted. (T1 req 5.) */
export function shouldAdoptResync(
  armed: boolean,
  live: number | null,
  snap: number | null,
): boolean {
  return armed && live != null && (snap == null || live > snap);
}

/** TEST-ONLY: reset all in-memory breaker state between tests. */
export function __resetConflictBreaker(): void {
  recordConflicts.clear();
  recordReloadAttempts.clear();
}
