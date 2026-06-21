/**
 * Stale-build lockout (2026-06-21, conflict-storm layer 2).
 *
 * When the version poller detects this tab is running an OUTDATED build, it
 * marks the build stale here with a hard forced-reload deadline. This module is
 * the single source of truth the rest of the app reads:
 *
 *  - the UpdateBanner renders a countdown + "save your work" warning,
 *  - appStore's save path can be write-locked (so a stale tab that is ALSO
 *    storming stops hitting the DB immediately — "stop autosave if needed"),
 *  - a beforeunload guard protects unsaved changes when the forced reload fires.
 *
 * Why a plain module (not the Zustand store): it must be readable from the
 * non-React save path (`supabaseRecordUpsert`) and from a beforeunload handler,
 * synchronously, without a hook. A tiny pub/sub keeps React in sync.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
const unsavedKeys = new Set<string>();

let outdated = false;
let forcedReloadAt = 0; // epoch ms; 0 = not scheduled
let writeLocked = false;

function emit(): void {
  for (const l of listeners) l();
}

export interface StaleBuildState {
  outdated: boolean;
  forcedReloadAt: number;
  writeLocked: boolean;
  hasUnsaved: boolean;
}

export function getStaleBuildState(): StaleBuildState {
  return { outdated, forcedReloadAt, writeLocked, hasUnsaved: unsavedKeys.size > 0 };
}

export function subscribeStaleBuild(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Called once by the poller when an outdated build is first detected. */
export function markStaleBuildOutdated(deadlineEpochMs: number): void {
  if (outdated) return;
  outdated = true;
  forcedReloadAt = deadlineEpochMs;
  emit();
}

/**
 * Hard-stop all record writes from this (stale) tab. Engaged when a stale tab is
 * ALSO detected storming (the save breaker trips while outdated), and right
 * before the forced reload. Saves then short-circuit with a terminal, non-silent
 * "reload required" outcome — never a silent drop.
 */
export function lockStaleBuildWrites(): void {
  if (writeLocked) return;
  writeLocked = true;
  // Once we've decided this tab must die, don't make the user wait the full
  // grace — bring the forced reload in close (but leave a beat for the
  // beforeunload unsaved-changes guard to protect real work).
  const soon = Date.now() + 8_000;
  if (forcedReloadAt === 0 || soon < forcedReloadAt) forcedReloadAt = soon;
  emit();
}

export function isStaleBuildWriteLocked(): boolean {
  return writeLocked;
}

/** Forms register their dirty state so the forced reload can protect real work. */
export function setFormUnsaved(key: string, dirty: boolean): void {
  const had = unsavedKeys.size > 0;
  if (dirty) unsavedKeys.add(key);
  else unsavedKeys.delete(key);
  if ((unsavedKeys.size > 0) !== had) emit();
}

export function hasUnsavedChanges(): boolean {
  return unsavedKeys.size > 0;
}
