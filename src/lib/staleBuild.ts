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
const activeJobKeys = new Set<string>();

let outdated = false;
let forcedReloadAt = 0; // epoch ms; 0 = not scheduled
let writeLocked = false;
let hardStopReason: string | null = null; // why writes are locked (telemetry/UX)
let jobDeferredMsTotal = 0; // how long the forced reload has been pushed back for jobs

// The forced reload DEFERS while an active job is registered (photo cleaning,
// media fan-out, AI drafting — work a reload would kill; live incident
// 2026-07-17: a deploy force-reloaded the tab mid listing-message cleaning).
// Bounded so a stuck job can't keep a stale tab alive forever, and a
// write-locked (storming) tab never defers — that's the kill switch.
const JOB_DEFER_STEP_MS = 30_000;
const JOB_DEFER_MAX_MS = 10 * 60_000;

function emit(): void {
  for (const l of listeners) l();
}

export interface StaleBuildState {
  outdated: boolean;
  forcedReloadAt: number;
  writeLocked: boolean;
  hardStopReason: string | null;
  hasUnsaved: boolean;
  hasActiveJobs: boolean;
}

export function getStaleBuildState(): StaleBuildState {
  return {
    outdated,
    forcedReloadAt,
    writeLocked,
    hardStopReason,
    hasUnsaved: unsavedKeys.size > 0,
    hasActiveJobs: activeJobKeys.size > 0,
  };
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

/** TEST-ONLY: reset all module state between tests. */
export function __resetStaleBuild(): void {
  outdated = false;
  forcedReloadAt = 0;
  writeLocked = false;
  hardStopReason = null;
  jobDeferredMsTotal = 0;
  unsavedKeys.clear();
  activeJobKeys.clear();
  emit();
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

/**
 * Long-running in-tab work (photo cleaning, background media fan-out, AI
 * drafting) registers here so a forced reload WAITS for it instead of killing
 * it mid-flight. Key = a short stable tag per surface; register true on start,
 * false on finish/unmount.
 */
export function setJobActive(key: string, active: boolean): void {
  const had = activeJobKeys.size > 0;
  if (active) activeJobKeys.add(key);
  else activeJobKeys.delete(key);
  if ((activeJobKeys.size > 0) !== had) emit();
}

export function hasActiveJobs(): boolean {
  return activeJobKeys.size > 0;
}

/**
 * Called by the reload watcher when the forced-reload deadline hits while a
 * job is active. Pushes the deadline back one step and returns true, or
 * returns false once the total deferral budget is exhausted (a stuck job must
 * not keep a stale tab alive forever). Write-locked (storming) tabs never get
 * here — the watcher reloads them regardless of jobs.
 */
export function deferForcedReloadForJobs(): boolean {
  if (jobDeferredMsTotal >= JOB_DEFER_MAX_MS) return false;
  jobDeferredMsTotal += JOB_DEFER_STEP_MS;
  forcedReloadAt = Date.now() + JOB_DEFER_STEP_MS;
  emit();
  return true;
}
