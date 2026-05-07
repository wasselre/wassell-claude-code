// ─────────────────────────────────────────────────────────────────
// Stale-while-revalidate — Phase D.3
//
// Realtime (Phase C.3) keeps the store fresh while the user is
// actively connected. But there are two failure modes it doesn't
// cover:
//
//   1. The websocket dropped silently — laptop went to sleep, the
//      WiFi blipped, a corporate proxy tore down idle connections.
//      Reconnect logic in supabase-js handles most cases but the
//      delta between drop and reconnect is lost.
//   2. The user backgrounded the tab for hours and a teammate
//      edited records in the meantime. The realtime channel was
//      paused or queued.
//
// On `window.focus` and `window.online`, refresh tables that have
// an `updated_at` column by fetching only rows changed since our
// last load timestamp. Apply through the same merge handlers as
// realtime — same dedup, same idempotence, same store mutations.
//
// Throttle: at most once every 5 seconds. Tab-switching shouldn't
// cause a thrash of refresh queries.
// ─────────────────────────────────────────────────────────────────

import { supabase } from './../supabase';
import type { AppState } from '../../types';
import {
  mergeRecord, mergeModel, mergeProfile, mergeRole, mergeUser,
  mergeModelView, mergeWorkflow, mergeDashboard,
} from './mergeHandlers';
import type { PgEvent } from './mergeHandlers';

type SetState = (
  partial: AppState | Partial<AppState> | ((s: AppState) => AppState | Partial<AppState>),
  replace?: boolean,
) => void;

interface DeltaSpec {
  table: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: PgEvent, payload: any, setState: SetState) => unknown;
  // Some tables (records) have lots of rows; cap the delta fetch so
  // a flood of edits doesn't spam the network on focus.
  limit: number;
}

const DELTA_TABLES: DeltaSpec[] = [
  { table: 'records',     handler: mergeRecord,     limit: 500 },
  { table: 'models',      handler: mergeModel,      limit: 100 },
  { table: 'profiles',    handler: mergeProfile,    limit: 100 },
  { table: 'roles',       handler: mergeRole,       limit: 100 },
  { table: 'users',       handler: mergeUser,       limit: 100 },
  { table: 'model_views', handler: mergeModelView,  limit: 200 },
  { table: 'workflows',   handler: mergeWorkflow,   limit: 200 },
  { table: 'dashboards',  handler: mergeDashboard,  limit: 100 },
];

const lastLoadTs = new Map<string, string>();
const REFRESH_THROTTLE_MS = 5_000;
let lastRefreshAt = 0;
let listenersAttached = false;

interface RefreshSummary {
  tables_checked: number;
  rows_applied: number;
  errors: number;
  throttled: boolean;
  duration_ms: number;
}

let lastSummary: RefreshSummary | null = null;

/** Record the timestamp at which `table` was just loaded. Subsequent
 *  refreshSinceLastLoad() calls will fetch only rows with
 *  updated_at >= this timestamp.
 *
 *  Audit fix H2: the previous semantics used a `.gt` filter, which
 *  silently dropped any row that was modified at exactly `since` if we
 *  hadn't loaded it locally yet (the stale-dedup couldn't help — there
 *  was nothing to dedup against). The fetcher now uses `.gte` so the
 *  boundary row is always picked up; echo + stale dedup handle the
 *  duplicates the wider window introduces. With `.gte`, marking before
 *  vs after the load no longer matters for correctness — but we still
 *  recommend marking BEFORE so any concurrent writes during the load
 *  window land in the next refresh rather than being silently lost. */
export function markLoaded(table: string, ts: string = new Date().toISOString()): void {
  lastLoadTs.set(table, ts);
}

/** Fetch deltas for every delta-capable table and feed them through
 *  the same merge handlers as realtime. Returns telemetry; safe to
 *  ignore the return value. Throttled to once per REFRESH_THROTTLE_MS. */
export async function refreshSinceLastLoad(setState: SetState): Promise<RefreshSummary> {
  const startedAt = performance.now();
  const baseSummary: RefreshSummary = {
    tables_checked: 0,
    rows_applied: 0,
    errors: 0,
    throttled: false,
    duration_ms: 0,
  };
  if (!supabase) return { ...baseSummary, duration_ms: 0 };
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_THROTTLE_MS) {
    const summary = { ...baseSummary, throttled: true, duration_ms: Math.round(performance.now() - startedAt) };
    lastSummary = summary;
    return summary;
  }
  lastRefreshAt = now;

  let totalApplied = 0;
  let totalErrors = 0;
  let totalChecked = 0;

  for (const spec of DELTA_TABLES) {
    const since = lastLoadTs.get(spec.table);
    if (!since) continue; // Never loaded — skip; full load will handle it.
    totalChecked += 1;

    try {
      // Audit H2: `.gte` (not `.gt`) so a row modified exactly at the
      // watermark isn't silently skipped on every subsequent refresh.
      // The merge handler's stale-dedup discards the harmless duplicate
      // when we already have that row.
      const { data, error } = await supabase
        .from(spec.table)
        .select('*')
        .gte('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(spec.limit);

      if (error) {
        totalErrors += 1;
        // eslint-disable-next-line no-console
        console.warn(`[swr] ${spec.table} delta fetch failed:`, error.message);
        continue;
      }
      if (!data || data.length === 0) continue;

      // Synthesize an UPDATE payload per row and feed it through the
      // same merge handler realtime would use. Echo dedup is harmless
      // here (we wouldn't have written the row server-side from this
      // client without registering it in the recently-written set).
      for (const row of data) {
        try {
          spec.handler('UPDATE', { new: row }, setState);
          totalApplied += 1;
        } catch (err) {
          totalErrors += 1;
          // eslint-disable-next-line no-console
          console.warn(`[swr] ${spec.table} merge failed:`, err);
        }
      }

      // Advance the watermark to the newest updated_at in the batch.
      // If the batch was capped at `limit`, the next refresh will pick
      // up where we left off (sorted ASC).
      const latestTs = data.reduce(
        (max: string, r: { updated_at?: string }) =>
          (r.updated_at && r.updated_at > max) ? r.updated_at : max,
        since,
      );
      if (latestTs && latestTs > since) lastLoadTs.set(spec.table, latestTs);
    } catch (err) {
      totalErrors += 1;
      // eslint-disable-next-line no-console
      console.warn(`[swr] ${spec.table} unexpected error:`, err);
    }
  }

  const summary: RefreshSummary = {
    tables_checked: totalChecked,
    rows_applied: totalApplied,
    errors: totalErrors,
    throttled: false,
    duration_ms: Math.round(performance.now() - startedAt),
  };
  lastSummary = summary;
  if (totalApplied > 0) {
    // eslint-disable-next-line no-console
    console.info(`[swr] applied ${totalApplied} delta rows across ${totalChecked} tables in ${summary.duration_ms}ms`);
  }
  return summary;
}

/** Attach focus + online window event listeners. Idempotent —
 *  repeated calls are no-ops. Returns an unsubscribe function for
 *  symmetry with realtime startup. */
export function startStaleWhileRevalidate(setState: SetState): () => void {
  if (typeof window === 'undefined') return () => {};
  if (listenersAttached) return () => {};
  listenersAttached = true;

  const focusHandler = () => { void refreshSinceLastLoad(setState); };
  const onlineHandler = () => { void refreshSinceLastLoad(setState); };

  window.addEventListener('focus', focusHandler);
  window.addEventListener('online', onlineHandler);

  // Expose a debug global for the Phase G.2 PerfPage and ad-hoc
  // browser-console diagnosis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__wasselSwrStats = () => lastSummary;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__wasselSwrRefresh = () => refreshSinceLastLoad(setState);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__wasselSwrLastLoadTs = () => Object.fromEntries(lastLoadTs);

  // eslint-disable-next-line no-console
  console.info('[swr] stale-while-revalidate listeners attached (focus + online)');

  return () => {
    window.removeEventListener('focus', focusHandler);
    window.removeEventListener('online', onlineHandler);
    listenersAttached = false;
  };
}

/** Test/debug helper: returns the most recent refresh summary. */
export function getLastRefreshSummary(): RefreshSummary | null {
  return lastSummary;
}
