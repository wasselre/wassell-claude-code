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
let hardStopReason: string | null = null; // why writes are locked (telemetry/UX)

function emit(): void {
  for (const l of listeners) l();
}

export interface StaleBuildState {
  outdated: boolean;
  forcedReloadAt: number;
  writeLocked: boolean;
  hardStopReason: string | null;
  hasUnsaved: boolean;
}

export function getStaleBuildState(): StaleBuildState {
  return { outdated, forcedReloadAt, writeLocked, hardStopReason, hasUnsaved: unsavedKeys.size > 0 };
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
 * Hard-stop ALL record writes from this tab and schedule a forced reload, for
 * ANY reason — NOT only a stale build. This is the build-independent kill switch
 * (T1, req 6): a tab storming version conflicts on the CURRENT build, or one the
 * SERVER terminally blocked (conflict_storm_blocked), must stop hitting the DB
 * and reload to recover — exactly as a stale tab does. Saves then short-circuit
 * with a terminal, non-silent "reload required" outcome — never a silent drop.
 * The forced reload itself fires from the (now build-independent) reload watcher
 * in useAppVersionPoller, driven by `forcedReloadAt`.
 *
 *   reason — short tag for telemetry/UX, e.g. 'server-blocked', 'record-storm',
 *            'wedged-after-reload', 'stale-build'.
 */
export function engageHardWriteStop(reason: string): void {
  if (writeLocked) return;
  writeLocked = true;
  hardStopReason = reason;
  // Once we've decided this tab must die, don't make the user wait the full
  // grace — bring the forced reload in close (but leave a beat for the
  // beforeunload unsaved-changes guard to protect real work).
  const soon = Date.now() + 8_000;
  if (forcedReloadAt === 0 || soon < forcedReloadAt) forcedReloadAt = soon;
  emit();
}

/** Back-compat alias: the stale-build path is just one reason for a hard stop. */
export function lockStaleBuildWrites(): void {
  engageHardWriteStop('stale-build');
}

/** True once any hard write-stop (stale build, server block, or wedged storm)
 *  is engaged — every record write short-circuits while this is true. */
export function isStaleBuildWriteLocked(): boolean {
  return writeLocked;
}

/** Preferred name going forward; same flag. */
export const isHardWriteStopped = isStaleBuildWriteLocked;

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
