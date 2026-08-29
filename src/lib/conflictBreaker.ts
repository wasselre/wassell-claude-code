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
/**
 * Absolute, monotonic conflict cap per record (2026-08-29 followups storm).
 *
 * The windowed `recordConflicts` count and the `recordReloadAttempts` cap both
 * have RESET paths: `releaseBreakerForRetry` DELETES the window count on every
 * reload-and-retry, and the reload cap is only a single-shot backstop. On a hot
 * TWO-WRITER record — a `followups` row that server automation (the WhatsApp
 * activity bridge / no-response escalation) bumps version-unaware while a browser
 * tab also auto-saves it — those resets can keep firing so that NEITHER hard-stop
 * trigger ever latches, and a stale tab loops `record_save` forever (measured
 * ~1,158 rejects/sec, 697k conflicts, on the CURRENT prod build, expected=2 fixed
 * because the tab never re-read a version it would accept). This counter has NO
 * window and only ONE reset — a genuinely SUCCESSFUL save (`clearRecordConflict`).
 * During a real storm there is no success (the version never advances), so this
 * marches to the cap and latches the tab-wide hard write-stop deterministically.
 * A legitimate concurrent edit resolves in ≤2 conflicts then SUCCEEDS (resetting
 * to 0), so a small cap here can never false-positive on real editing.
 */
export const RECORD_ABSOLUTE_CONFLICT_LIMIT = 6;

interface ConflictState {
  count: number;
  first: number;
  tripped: boolean;
}

const recordConflicts = new Map<string, ConflictState>();
const recordReloadAttempts = new Map<string, number>();
/** Total version-conflicts on a record since its last SUCCESSFUL save. Only
 *  `clearRecordConflict` (a real success) resets it — no re-fetch/retry path
 *  does — so it cannot be zeroed by the reset races that defeat the windowed
 *  count + reload cap. */
const recordAbsoluteConflicts = new Map<string, number>();

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

/** Clear the breaker AND both conflict counters — called after any SUCCESSFUL
 *  save, restoring the fresh one-reload allowance. This is the ONLY reset for
 *  the absolute counter, so a storm (which never succeeds) can't escape it. */
export function clearRecordConflict(id: string): void {
  recordConflicts.delete(id);
  recordReloadAttempts.delete(id);
  recordAbsoluteConflicts.delete(id);
}

/** Record one version-conflict on a record and return the running total since
 *  its last successful save. Monotonic — no window, reset ONLY by a successful
 *  save. Once the return value reaches RECORD_ABSOLUTE_CONFLICT_LIMIT the caller
 *  must latch the tab-wide hard write-stop (a reset race can't undo it). */
export function noteAbsoluteConflict(id: string): number {
  const n = (recordAbsoluteConflicts.get(id) ?? 0) + 1;
  recordAbsoluteConflicts.set(id, n);
  return n;
}

/** True once a record has hit the absolute conflict cap since its last success. */
export function reachedAbsoluteConflictCap(id: string): boolean {
  return (recordAbsoluteConflicts.get(id) ?? 0) >= RECORD_ABSOLUTE_CONFLICT_LIMIT;
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
  recordAbsoluteConflicts.clear();
}
