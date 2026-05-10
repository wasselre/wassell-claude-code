/**
 * Detects when a new build is live on Vercel and surfaces it to the user.
 *
 * The flow:
 *   1. Vite injects `__BUILD_VERSION__` (the short commit SHA) into the
 *      bundle at build time. Every visitor's tab carries the version their
 *      tab was loaded against.
 *   2. /api/version returns the version of the CURRENT live deploy.
 *   3. This hook polls /api/version every 60 seconds (only while the tab
 *      is visible — Page Visibility API). When the response differs from
 *      the baked-in version, it sets `updateAvailable: true`.
 *   4. The UI surfaces a persistent "New version available — reload" banner
 *      with a one-click reload button. Two minutes after detection, if the
 *      user hasn't clicked, we auto-reload — but only when the tab is
 *      hidden (so we don't yank the page out from under someone mid-task).
 *
 * Without this, every user has to clear their browser cache after a deploy,
 * which we are NOT doing — see the explicit feedback in our memory:
 * shipping a release should never require user-side cache surgery.
 */

import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 60_000; // 1 minute
const AUTO_RELOAD_HIDDEN_TAB_MS = 2 * 60_000; // 2 minutes

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
  /** Force a reload now. Exposed so the banner button can call it. */
  reload: () => void;
}

export function useAppVersionPoller(): AppVersionState {
  const loadedVersion =
    typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'unknown';
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [liveVersion, setLiveVersion] = useState<string | null>(null);
  const detectedAtRef = useRef<number | null>(null);

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
        if (live && typeof live === 'string') {
          setLiveVersion(live);
          if (live !== loadedVersion) {
            setUpdateAvailable(true);
            if (detectedAtRef.current === null) {
              detectedAtRef.current = Date.now();
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

  // Auto-reload (background tab only) after the grace window. We never
  // yank an active tab — the banner stays up and the user reloads when
  // it's safe for them.
  useEffect(() => {
    if (!updateAvailable) return;
    const interval = setInterval(() => {
      if (
        detectedAtRef.current !== null
        && Date.now() - detectedAtRef.current >= AUTO_RELOAD_HIDDEN_TAB_MS
        && document.hidden
      ) {
        window.location.reload();
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, [updateAvailable]);

  const reload = (): void => {
    window.location.reload();
  };

  return { updateAvailable, liveVersion, loadedVersion, reload };
}
