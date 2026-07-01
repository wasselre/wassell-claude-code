/**
 * Invisible, console-only FREEZE DETECTOR.
 *
 * When the browser's main thread is blocked for longer than THRESHOLD_MS (a hang
 * the user would actually notice), this logs a `[freeze]` warning to the console
 * naming WHAT the app was doing at the time + how long it froze. It exists to
 * diagnose perf hangs that don't reproduce on fast dev hardware but do on a real
 * user's machine — the developer asks the user to reproduce once and read back the
 * console line, which pinpoints the exact phase to fix.
 *
 * Zero UI, no network, no state. `markActivity(label)` sets the current phase
 * label; the observer attaches whatever label is current when a long task fires.
 * Safe to call from anywhere; a no-op where PerformanceObserver('longtask') is
 * unsupported (Safari/Firefox don't implement the longtask entry type).
 */

let installed = false;
let currentActivity = 'idle';
let activityStartedAt = 0;

// A block longer than this reads as a "freeze" to a person. 800ms is comfortably
// above normal React render jank (we measured finder actions at ≤0.5s on fast HW)
// so only genuine hangs are logged.
const THRESHOLD_MS = 800;

/** Label the phase the app is entering, so a subsequent freeze is attributed to it. */
export function markActivity(label: string): void {
  currentActivity = label;
  try {
    activityStartedAt = performance.now();
  } catch {
    // performance.now() is unavailable only in non-browser contexts we never hit
    // here; fall back to "unknown offset". No behavior depends on this value.
    activityStartedAt = 0;
  }
}

/** Install the long-task observer once. Idempotent. */
export function startFreezeDetector(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < THRESHOLD_MS) continue;
        const sinceMark = activityStartedAt ? Math.round(entry.startTime - activityStartedAt) : null;
        // eslint-disable-next-line no-console
        console.warn(
          `[freeze] main thread blocked ${Math.round(entry.duration)}ms during "${currentActivity}"` +
            (sinceMark != null ? ` (+${sinceMark}ms into that step)` : ''),
        );
      }
    });
    po.observe({ entryTypes: ['longtask'] });
    installed = true;
  } catch {
    // The ONLY failure here is a browser without the 'longtask' entry type
    // (Safari/Firefox). Detection is a best-effort diagnostic — degrade to
    // no-op rather than surface an error for an unsupported-but-harmless case.
    installed = true; // don't retry every call
  }
}
