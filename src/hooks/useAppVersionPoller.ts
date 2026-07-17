/**
 * Detects when a new build is live on Vercel and FORCES a stale tab onto it.
 *
 * The flow:
 *   1. Vite injects `__BUILD_VERSION__` (the short commit SHA) into the
 *      bundle at build time. Every visitor's tab carries the version their
 *      tab was loaded against.
 *   2. /api/version returns the version of the CURRENT live deploy.
 *   3. This hook polls /api/version every 60 seconds (only while the tab
 *      is visible — Page Visibility API). When the response differs from
 *      the baked-in version, the tab is OUTDATED.
 *   4. On outdated: mark the build stale (`markStaleBuildOutdated`) with a
 *      short forced-reload deadline, show the UpdateBanner countdown, and at
 *      the deadline FORCE a reload — regardless of tab visibility. This is the
 *      conflict-storm layer-2 fix: a stale tab is the source of the record_save
 *      version-conflict storms, so a stale tab must not be allowed to linger.
 *
 * Protecting the user (so "force" never means "lose work"):
 *   - The banner counts down visibly with a "save your changes" warning.
 *   - A `beforeunload` guard fires the browser's native unsaved-changes prompt
 *     when any form is dirty (forms register via staleBuild.setFormUnsaved).
 *   - If a stale tab is ALSO storming (the save breaker trips while outdated),
 *     writes lock immediately (stop hitting the DB) and the reload is pulled in.
 *
 * Without this, a stale VISIBLE tab never reloaded (the old behavior only
 * auto-reloaded HIDDEN tabs), so a pre-fix bundle could run — and storm — for
 * days. See src/lib/staleBuild.ts and the 2026-06-21 conflict-storm hardening.
 */

import { useEffect, useRef, useState } from 'react';
import {
  markStaleBuildOutdated,
  lockStaleBuildWrites,
  hasUnsavedChanges,
  hasActiveJobs,
  deferForcedReloadForJobs,
  subscribeStaleBuild,
  getStaleBuildState,
} from '@/lib/staleBuild';

const POLL_INTERVAL_MS = 60_000; // 1 minute
// Short grace after detection before we force the reload — enough time for the
// banner countdown to let the user save, short enough that a stale (possibly
// storming) tab can't linger. A storming tab pulls this in further (see
// lockStaleBuildWrites).
const FORCE_RELOAD_GRACE_MS = 90_000;

interface VersionResponse {
  sha?: string;
  deployedAt?: string | null;
}

export interface AppVersionState {
  /** True once a different live version has been observed at least once. */
  updateAvailable: boolean;
  /** The live version string from /api/version, if known. */
  liveVersion: string | null;
  /** The version baked into THIS tab's bundle. */
  loadedVersion: string;
  /** Whole seconds until the forced reload (0 once due). null when not stale. */
  secondsUntilForcedReload: number | null;
  /** Whether saves are currently locked (stale + storming). */
  writeLocked: boolean;
  /** Whether any open form has unsaved edits (drives the banner warning). */
  hasUnsaved: boolean;
  /** Whether a long-running in-tab job is deferring the forced reload. */
  hasActiveJobs: boolean;
  /** Force a reload now. Exposed so the banner button can call it. */
  reload: () => void;
}

export function useAppVersionPoller(): AppVersionState {
  const loadedVersion =
    typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'unknown';
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [liveVersion, setLiveVersion] = useState<string | null>(null);
  // Re-render tick so the countdown updates and staleBuild changes propagate.
  const [, setTick] = useState(0);
  const detectedAtRef = useRef<number | null>(null);

  // Mirror staleBuild module changes into React.
  useEffect(() => subscribeStaleBuild(() => setTick((n) => n + 1)), []);

  useEffect(() => {
    // Skip the poller in dev — /api/version isn't served by `vite dev`,
    // and in that mode HMR already handles updates. The fallback bundle
    // version starts with `dev-` which we use as the dev signal.
    if (loadedVersion.startsWith('dev-') || loadedVersion === 'unknown') {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function checkOnce(): Promise<void> {
      if (cancelled) return;
      // Only poll when the tab is visible — pollers in background tabs
      // are wasteful and Chrome throttles them anyway.
      if (document.hidden) {
        schedule();
        return;
      }
      try {
        // Cache-bust query param + no-store fetch options so the browser
        // and any intermediate proxy can't return a stale answer.
        const res = await fetch(`/api/version?_=${Date.now()}`, {
          method: 'GET',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          schedule();
          return;
        }
        const body = (await res.json()) as VersionResponse;
        const live = body.sha;
        if (cancelled) return;
        // Ignore sentinel values — those mean Vercel didn't have a real SHA
        // to stamp this deploy with. Treating them as a mismatch would force a
        // reload loop on otherwise-fine deploys.
        const liveIsValid = live && typeof live === 'string'
          && live !== 'unknown' && !live.startsWith('dev-');
        if (liveIsValid) {
          setLiveVersion(live);
          if (live !== loadedVersion) {
            setUpdateAvailable(true);
            if (detectedAtRef.current === null) {
              detectedAtRef.current = Date.now();
              // Arm the stale-build lockout + forced-reload deadline ONCE.
              markStaleBuildOutdated(Date.now() + FORCE_RELOAD_GRACE_MS);
            }
          }
        }
      } catch {
        // Network blip — try again on the next tick. Failure here must
        // never break the app or surface a noisy toast; the user is
        // still on the version they have, which works.
      }
      schedule();
    }

    function schedule(): void {
      if (cancelled) return;
      timer = setTimeout(checkOnce, POLL_INTERVAL_MS);
    }

    // First check fires shortly after mount so a returning tab catches up
    // quickly — but with a small initial delay so the tab finishes booting.
    timer = setTimeout(checkOnce, 5_000);

    // Re-check immediately when the tab becomes visible again — common
    // case: user comes back to the tab the next morning, we want to know
    // before they start typing.
    const onVisible = (): void => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(checkOnce, 0);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadedVersion]);

  // Forced reload at the deadline — REGARDLESS of tab visibility (the key
  // difference from the old "hidden tabs only" behavior). The beforeunload
  // guard below protects unsaved work; a storming tab already had its writes
  // locked so it isn't hammering the DB while it waits out the grace.
  // Forced reload at the deadline — REGARDLESS of tab visibility AND regardless
  // of whether a newer BUILD is available. A deadline can be armed by stale-build
  // detection (updateAvailable) OR by a build-INDEPENDENT hard write-stop (T1,
  // req 6): the server returning conflict_storm_blocked, or a record wedged after
  // its one allowed reload. So this watcher is ALWAYS on (a storming tab on the
  // CURRENT build must still be force-reloaded), gated only on a pending deadline.
  useEffect(() => {
    const interval = setInterval(() => {
      const { forcedReloadAt, writeLocked } = getStaleBuildState();
      if (forcedReloadAt > 0 && Date.now() >= forcedReloadAt) {
        // Active in-tab work (photo cleaning, media fan-out, AI drafting)
        // defers the reload — bounded, and NEVER for a write-locked
        // (storming) tab, which must die regardless (live incident
        // 2026-07-17: a deploy reloaded the tab mid photo-cleaning).
        if (!writeLocked && hasActiveJobs() && deferForcedReloadForJobs()) {
          setTick((n) => n + 1);
          return;
        }
        lockStaleBuildWrites(); // belt-and-suspenders: no save can race the reload
        window.location.reload();
      } else if (forcedReloadAt > 0) {
        setTick((n) => n + 1); // keep the countdown ticking while a deadline pends
      }
    }, 1_000);
    return () => clearInterval(interval);
  }, []);

  // Unsaved-changes guard: the browser's native prompt is our safety net so a
  // forced reload can never silently discard real work. Only engages when a
  // form is actually dirty (clean tabs reload without a prompt).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const reload = (): void => {
    window.location.reload();
  };

  const { forcedReloadAt, writeLocked, hasUnsaved, hasActiveJobs: jobsActive } = getStaleBuildState();
  const secondsUntilForcedReload =
    updateAvailable && forcedReloadAt > 0
      ? Math.max(0, Math.ceil((forcedReloadAt - Date.now()) / 1000))
      : null;

  return {
    updateAvailable,
    liveVersion,
    loadedVersion,
    secondsUntilForcedReload,
    writeLocked,
    hasUnsaved,
    hasActiveJobs: jobsActive,
    reload,
  };
}
