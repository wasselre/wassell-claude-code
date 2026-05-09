// ─────────────────────────────────────────────────────────────────
// RealtimeOrchestrator — Phase C.3
//
// Subscribes to postgres_changes on the tables newly added to the
// supabase_realtime publication in Phase C.1+C.2 and dispatches
// payloads to the per-table merge handlers in mergeHandlers.ts.
//
// Design notes:
//   - Module-scoped singleton on globalThis.__wasselRealtimeOrch
//     prevents double-subscribe across HMR / strict-mode double
//     renders. Mirrors the existing subscribeMarketingRealtime
//     pattern in appStore.ts.
//
//   - One channel per table (small N — 11 tables). Per-table channels
//     simplify the kill-switch: turning off realtime for `records` is
//     just removing that one channel. A single fat channel would
//     couple all tables and make selective rollback harder.
//
//   - Echo dedup: the wasRecentlyWritten() check filters payloads
//     that originated from this client's own writes. Without this,
//     every save would round-trip through the orchestrator and
//     re-render the row that React just optimistically painted.
//
//   - Stale dedup: handlers compare local `updated_at` to incoming
//     and skip if the local copy is at-least-as-fresh. Defends
//     against out-of-order delivery.
//
//   - Telemetry: per-table counters of received / applied / skipped /
//     errored events. Surfaced via getStats() — useful for the
//     debug overlay in Phase G.2 and for diagnosing "is realtime
//     actually working?" complaints.
//
//   - Kill switch: localStorage.wassell_realtime_disabled = '1'
//     skips startup entirely. Per-table disable via env vars
//     VITE_REALTIME_<TABLE>=off.
//
// Frozen models: NOT covered here. Realtime payloads from dedicated
// frozen tables go to those tables' channels, not `records`. Phase
// E.4 will add a frozen-model fast path; until then, frozen models
// are read-snapshot-only.
// ─────────────────────────────────────────────────────────────────

import { supabase } from './../supabase';
import type { AppState } from '../../types';
import { wasEchoOf } from './dedup';
import {
  mergeRecord, mergeModel, mergeModelGroup, mergeWorkflow, mergeWorkflowGroup,
  mergeWorkflowRun, mergeDashboard, mergeModelView, mergeProfile, mergeRole, mergeUser,
} from './mergeHandlers';
import type { PgEvent, RealtimeOutcome } from './mergeHandlers';

type SetState = (
  partial: AppState | Partial<AppState> | ((s: AppState) => AppState | Partial<AppState>),
  replace?: boolean,
) => void;

interface TableSpec {
  table: string;
  envFlag: string; // VITE_REALTIME_<flag>=off disables this table
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: PgEvent, payload: any, setState: SetState) => RealtimeOutcome;
}

// Order matters only for log readability. Each subscription is independent.
const TABLES: TableSpec[] = [
  { table: 'records',         envFlag: 'VITE_REALTIME_RECORDS',         handler: mergeRecord },
  { table: 'models',          envFlag: 'VITE_REALTIME_MODELS',          handler: mergeModel },
  { table: 'model_groups',    envFlag: 'VITE_REALTIME_MODEL_GROUPS',    handler: mergeModelGroup },
  { table: 'workflows',       envFlag: 'VITE_REALTIME_WORKFLOWS',       handler: mergeWorkflow },
  { table: 'workflow_groups', envFlag: 'VITE_REALTIME_WORKFLOW_GROUPS', handler: mergeWorkflowGroup },
  { table: 'workflow_runs',   envFlag: 'VITE_REALTIME_WORKFLOW_RUNS',   handler: mergeWorkflowRun },
  { table: 'dashboards',      envFlag: 'VITE_REALTIME_DASHBOARDS',      handler: mergeDashboard },
  { table: 'model_views',     envFlag: 'VITE_REALTIME_MODEL_VIEWS',     handler: mergeModelView },
  { table: 'profiles',        envFlag: 'VITE_REALTIME_PROFILES',        handler: mergeProfile },
  { table: 'roles',           envFlag: 'VITE_REALTIME_ROLES',           handler: mergeRole },
  { table: 'users',           envFlag: 'VITE_REALTIME_USERS',           handler: mergeUser },
];

interface TableStats {
  received: number;
  applied: number;
  echo_skipped: number;
  stale_skipped: number;
  unknown_model: number;
  errors: number;
  last_event_at: number | null;
}

function emptyStats(): TableStats {
  return {
    received: 0,
    applied: 0,
    echo_skipped: 0,
    stale_skipped: 0,
    unknown_model: 0,
    errors: 0,
    last_event_at: null,
  };
}

interface OrchestratorState {
  channels: Map<string, ReturnType<NonNullable<typeof supabase>['channel']>>;
  stats: Map<string, TableStats>;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wasselRealtimeOrch: OrchestratorState | undefined;
}

function isTableDisabled(envFlag: string): boolean {
  // Vite inlines import.meta.env.* at build time. The string match
  // catches "off" / "false" / "0" / "no" — anything else is enabled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (import.meta as any).env?.[envFlag];
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase();
  return s === 'off' || s === 'false' || s === '0' || s === 'no';
}

function isGloballyDisabled(): boolean {
  try {
    return localStorage.getItem('wassell_realtime_disabled') === '1';
  } catch {
    return false;
  }
}

/** Start the orchestrator. Idempotent — repeated calls are no-ops if
 *  already running. Returns an unsubscribe function for symmetry with
 *  subscribeMarketingRealtime; the orchestrator usually outlives the
 *  React tree (the lifecycle is the auth session, not any one mount).
 */
export function startRealtimeOrchestrator(setState: SetState): () => void {
  if (!supabase) return () => {};
  if (isGloballyDisabled()) {
    // eslint-disable-next-line no-console
    console.warn('[realtime] globally disabled via wassell_realtime_disabled localStorage key');
    return () => {};
  }
  if (globalThis.__wasselRealtimeOrch) {
    // Already running — return a no-op so callers can still safely
    // call this in useEffect without leaking state.
    return () => {};
  }

  const state: OrchestratorState = {
    channels: new Map(),
    stats: new Map(),
    startedAt: Date.now(),
  };
  globalThis.__wasselRealtimeOrch = state;

  for (const spec of TABLES) {
    if (isTableDisabled(spec.envFlag)) {
      // eslint-disable-next-line no-console
      console.info(`[realtime] ${spec.table} disabled via ${spec.envFlag}`);
      continue;
    }
    state.stats.set(spec.table, emptyStats());

    const channel = supabase
      .channel(`wassell-${spec.table}`)
      .on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: spec.table },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const stats = state.stats.get(spec.table)!;
          stats.received += 1;
          stats.last_event_at = Date.now();
          try {
            const event = payload.eventType as PgEvent;
            // Echo dedup: skip events whose row id this client just wrote.
            // For DELETE the id is in payload.old; for INSERT/UPDATE it's in payload.new.
            // Audit fix H1: pass the incoming `updated_at` so dedup can do
            // strict updated_at comparison instead of relying on a 30s TTL.
            const id = event === 'DELETE' ? payload.old?.id : payload.new?.id;
            const incomingUpdatedAt =
              event === 'DELETE'
                ? null
                : (typeof payload.new?.updated_at === 'string' ? payload.new.updated_at : null);
            if (id && wasEchoOf(spec.table, id, incomingUpdatedAt)) {
              stats.echo_skipped += 1;
              return;
            }
            const outcome = spec.handler(event, payload, setState);
            if (outcome === 'applied') stats.applied += 1;
            else if (outcome === 'skipped_stale') stats.stale_skipped += 1;
            else if (outcome === 'skipped_unknown_model') stats.unknown_model += 1;
            // 'noop' is uncounted — payload was acceptable but produced no state change.
          } catch (err) {
            stats.errors += 1;
            // eslint-disable-next-line no-console
            console.error(`[realtime] ${spec.table} handler error:`, err);
          }
        },
      )
      .subscribe();

    state.channels.set(spec.table, channel);
  }

  // Expose a debug global for the Phase G.2 PerfPage and ad-hoc
  // browser-console diagnosis. Read-only — call getStats() instead of
  // poking the map directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__wasselRealtimeStats = () => getStats();

  // eslint-disable-next-line no-console
  console.info(
    `[realtime] orchestrator started; ${state.channels.size}/${TABLES.length} tables subscribed`,
  );

  return () => stopRealtimeOrchestrator();
}

/** Stop the orchestrator. Removes all channels, clears the singleton.
 *  Safe to call when not running. */
export function stopRealtimeOrchestrator(): void {
  const state = globalThis.__wasselRealtimeOrch;
  if (!state || !supabase) return;
  for (const channel of state.channels.values()) {
    try { supabase.removeChannel(channel); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[realtime] removeChannel failed:', err);
    }
  }
  state.channels.clear();
  globalThis.__wasselRealtimeOrch = undefined;
}

/** Snapshot of per-table counters for telemetry / debugging. */
export function getStats(): Record<string, TableStats & { table: string }> {
  const state = globalThis.__wasselRealtimeOrch;
  const out: Record<string, TableStats & { table: string }> = {};
  if (!state) return out;
  for (const [table, s] of state.stats) {
    out[table] = { table, ...s };
  }
  return out;
}

/** Whether the orchestrator is currently running. */
export function isOrchestratorRunning(): boolean {
  return !!globalThis.__wasselRealtimeOrch;
}
