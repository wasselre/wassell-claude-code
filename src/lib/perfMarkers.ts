// ─────────────────────────────────────────────────────────────────
// Phase G.2 — Frontend perf markers
//
// Thin wrapper over the Performance Timeline API that exposes a
// stable `__wasselPerf()` global for ad-hoc browser-console
// diagnosis and (later) a Settings/PerfPage UI.
//
// Marks set across the codebase:
//   - wassell:init:loads:start  / :end       (Phase D.1)
//   - wassell:init:critical:end              (Phase D.2 — chrome ready)
//   - wassell:init:end                       (everything ready)
//
// Combined with the orchestrator's __wasselRealtimeStats() and the
// SWR's __wasselSwrStats(), this gives a complete picture of what's
// happening at any moment.
//
// Idempotent — repeated install calls are no-ops.
// ─────────────────────────────────────────────────────────────────

interface PerfMeasure {
  name: string;
  start_ms: number;
  duration_ms: number;
}

interface PerfSnapshot {
  /** Time of capture, relative to navigation start (page load). */
  now_ms: number;
  /** Per-name list of measure entries. */
  measures: PerfMeasure[];
  /** Realtime orchestrator counters. */
  realtime?: unknown;
  /** Stale-while-revalidate last-summary. */
  swr?: unknown;
  /** Realtime channel last-load timestamps (per-table). */
  swr_lastLoadTs?: unknown;
}

let installed = false;

/** Read all wassell:* measures from the Performance Timeline. */
function readMeasures(): PerfMeasure[] {
  if (typeof performance === 'undefined') return [];
  return performance
    .getEntriesByType('measure')
    .filter((e) => e.name.startsWith('wassell:'))
    .map((e) => ({
      name: e.name,
      start_ms: Math.round(e.startTime),
      duration_ms: Math.round(e.duration),
    }))
    .sort((a, b) => a.start_ms - b.start_ms);
}

/** Build a snapshot of the perf state right now. */
function snapshot(): PerfSnapshot {
  const out: PerfSnapshot = {
    now_ms: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
    measures: readMeasures(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.__wasselRealtimeStats === 'function') out.realtime = g.__wasselRealtimeStats();
  if (typeof g.__wasselSwrStats === 'function') out.swr = g.__wasselSwrStats();
  if (typeof g.__wasselSwrLastLoadTs === 'function') out.swr_lastLoadTs = g.__wasselSwrLastLoadTs();
  return out;
}

/** Install the debug global. Safe to call repeatedly. */
export function installPerfMarkers(): void {
  if (installed) return;
  installed = true;
  if (typeof globalThis === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__wasselPerf = snapshot;
  // eslint-disable-next-line no-console
  console.info('[perf] markers installed — call __wasselPerf() in the console for a snapshot');
}

/** Direct access for callers that already have a reference (e.g.,
 *  the future PerfPage component reading current state on mount). */
export { snapshot as getPerfSnapshot };

/** Convenience wrapper for marking events. Logs nothing on its own —
 *  the marks show up in __wasselPerf(). */
export function markEvent(name: string): void {
  if (typeof performance === 'undefined') return;
  const fullName = name.startsWith('wassell:') ? name : `wassell:${name}`;
  try { performance.mark(fullName); } catch { /* ignore */ }
}

/** Measure between two marks (or from a single mark to "now"). */
export function measureBetween(name: string, startMark: string, endMark?: string): void {
  if (typeof performance === 'undefined') return;
  const fullName = name.startsWith('wassell:') ? name : `wassell:${name}`;
  try {
    performance.measure(fullName, startMark, endMark);
  } catch {
    /* mark missing or already measured — telemetry shouldn't crash */
  }
}
