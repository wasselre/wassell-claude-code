// ─────────────────────────────────────────────────────────────────
// Pure merge functions for realtime payloads.
//
// Each handler receives the Postgres event ('INSERT' | 'UPDATE' |
// 'DELETE'), the row payload, and a Zustand state setter. It returns
// a `RealtimeOutcome` for telemetry — the orchestrator counts these
// to expose per-table health (see RealtimeOrchestrator.getStats()).
//
// Handlers MUST be:
//   - Idempotent: re-applying the same payload yields the same state.
//   - Echo-safe: handlers are not called for ids in the recently-written
//     set (the orchestrator filters first), but if they were they would
//     no-op via the stale-dedup check.
//   - Pure-as-possible: read/write Zustand state through the passed-in
//     setState; do NOT call out to other modules or fire side-effects.
// ─────────────────────────────────────────────────────────────────

import type { AppState } from '../../types';
import type {
  AppModel,
  ModelGroup,
  AppRecord,
  Workflow,
  WorkflowGroup,
  WorkflowRun,
  Dashboard,
  ModelView,
  Profile,
  Role,
  User,
} from '../../types';
import { upsertRow as upsertCachedRow, removeRow as removeCachedRow } from '../recordsCache';
import { isLazyModelName, isSummaryModelName, slimSummaryData } from '../lazyModels';

export type RealtimeOutcome = 'applied' | 'skipped_stale' | 'skipped_unknown_model' | 'noop';
export type PgEvent = 'INSERT' | 'UPDATE' | 'DELETE';

type SetState = (
  partial: AppState | Partial<AppState> | ((s: AppState) => AppState | Partial<AppState>),
  replace?: boolean,
) => void;

// ─── Internal: stale-dedup helper ────────────────────────────────
//
// If the local copy's `updated_at` is >= incoming.updated_at, the
// incoming event is either our own echo (already applied locally) or
// out-of-order delivery for an older revision. Skip.
//
// Audit fix L1: parse to milliseconds before comparing instead of
// trusting the lex-compare. Postgres timestamptz emits microseconds
// (`2026-05-07T12:34:56.789012+00:00`), but realtime payloads sometimes
// strip trailing zeros (`...:56.78+00:00`) — that breaks lexicographic
// compare. `Date.parse` collapses both to the same millisecond.
function isIncomingStale(local: { updated_at?: string } | undefined, incoming: { updated_at?: string }): boolean {
  if (!local?.updated_at || !incoming.updated_at) return false;
  const localMs = Date.parse(local.updated_at);
  const incomingMs = Date.parse(incoming.updated_at);
  if (Number.isNaN(localMs) || Number.isNaN(incomingMs)) {
    // Bad input — fall back to string compare so we never crash. Strict
    // equality means "same timestamp string" → treat as stale.
    return local.updated_at >= incoming.updated_at;
  }
  return localMs >= incomingMs;
}

// ─── records ──────────────────────────────────────────────────────
//
// records[modelId]: AppRecord[]. INSERT/UPDATE upsert by id within the
// model's bucket. DELETE removes by id; with REPLICA IDENTITY DEFAULT
// (the records table) payload.old contains only `id` — that's all we
// need.
//
// Audit fix H9: this handler ALSO updates `recordsByModel` (the Phase E
// paginated cache) so its consumers see live updates instead of a stale
// snapshot. The legacy `records[modelId]` slice and the paginated cache
// were drifting in opposite directions when realtime fired. With the tee
// in place, both caches stay aligned for free.
export function mergeRecord(
  event: PgEvent,
  payload: { new?: AppRecord; old?: Partial<AppRecord> },
  setState: SetState,
): RealtimeOutcome {
  if (event === 'DELETE') {
    const id = payload.old?.id;
    if (!id) return 'noop';
    let outcome: RealtimeOutcome = 'noop';
    setState((s) => {
      const next: Record<string, AppRecord[]> = {};
      let removed = false;
      for (const [modelId, list] of Object.entries(s.records)) {
        const filtered = list.filter((r) => r.id !== id);
        if (filtered.length !== list.length) removed = true;
        next[modelId] = filtered;
      }
      // Tee into the paginated cache (audit H9). We don't know which
      // model the deleted row belonged to without payload.old.model_id,
      // so sweep every cached model — `removeRow` is a cheap no-op
      // when the id isn't present.
      const nextRBM = { ...s.recordsByModel };
      let cacheTouched = false;
      for (const [mid, cache] of Object.entries(nextRBM)) {
        const updated = removeCachedRow(cache, id);
        if (updated !== cache) {
          nextRBM[mid] = updated;
          cacheTouched = true;
        }
      }
      if (!removed && !cacheTouched) return s;
      outcome = 'applied';
      return cacheTouched ? { records: next, recordsByModel: nextRBM } : { records: next };
    });
    return outcome;
  }

  // INSERT / UPDATE
  const row = payload.new;
  if (!row?.id || !row.model_id) return 'noop';

  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    // If the model isn't loaded into memory, drop the event — Phase E
    // (paginated cache) will load it on demand. For now, ignoring an
    // unknown model is safer than synthesizing a half-record.
    const eventModel = s.models.find((m) => m.id === row.model_id);
    if (!eventModel) {
      outcome = 'skipped_unknown_model';
      return s;
    }

    // Summary models (e.g. market_listings) keep ALL rows in the normal
    // `records[modelId]` slice, but SLIM — the in-memory store must never
    // accumulate the heavy per-record fields. So we project the incoming
    // full row's data down to the summary keys before merging. Same
    // upsert-if-present / stale-dedup / cache-tee posture as a normal row.
    if (isSummaryModelName(eventModel.name)) {
      const slimRow: AppRecord = { ...row, data: slimSummaryData(eventModel.name, row.data) };
      const list = s.records[row.model_id] ?? [];
      const existing = list.find((r) => r.id === slimRow.id);
      if (event === 'UPDATE' && isIncomingStale(existing, slimRow)) {
        outcome = 'skipped_stale';
        return s;
      }
      const nextList = existing
        ? list.map((r) => (r.id === slimRow.id ? slimRow : r))
        : [...list, slimRow];
      const cache = s.recordsByModel[row.model_id];
      const updates: Partial<AppState> = {
        records: { ...s.records, [row.model_id]: nextList },
      };
      if (cache) {
        updates.recordsByModel = {
          ...s.recordsByModel,
          [row.model_id]: upsertCachedRow(cache, slimRow),
        };
      }
      outcome = 'applied';
      return updates;
    }

    // Lazy models (dormant — no model uses this path today) are NEVER
    // materialized into the legacy `records[modelId]` slice — their rows
    // live only in the paginated `recordsByModel` cache. Appending here
    // would re-bloat the legacy slice over a session, so we touch ONLY the
    // cache bucket (if one exists), with the same upsert-if-present /
    // stale-dedup posture as below.
    if (isLazyModelName(eventModel.name)) {
      const cache = s.recordsByModel[row.model_id];
      if (!cache) {
        // No paginated bucket yet — nothing to update, and we must not
        // create the legacy slice. The next loadRecordsPage picks it up.
        outcome = 'noop';
        return s;
      }
      const cachedExisting = cache.rows.find((r) => r.id === row.id);
      if (event === 'UPDATE' && isIncomingStale(cachedExisting, row)) {
        outcome = 'skipped_stale';
        return s;
      }
      outcome = 'applied';
      return {
        recordsByModel: {
          ...s.recordsByModel,
          [row.model_id]: upsertCachedRow(cache, row),
        },
      };
    }

    const list = s.records[row.model_id] ?? [];
    const existing = list.find((r) => r.id === row.id);
    if (event === 'UPDATE' && isIncomingStale(existing, row)) {
      outcome = 'skipped_stale';
      return s;
    }
    const nextList = existing
      ? list.map((r) => (r.id === row.id ? row : r))
      : [...list, row];
    // Tee into paginated cache (audit H9). Only update the bucket if
    // it already exists — we don't synthesize a cache entry for a
    // model the user never paginated through.
    const cache = s.recordsByModel[row.model_id];
    const updates: Partial<AppState> = {
      records: { ...s.records, [row.model_id]: nextList },
    };
    if (cache) {
      updates.recordsByModel = {
        ...s.recordsByModel,
        [row.model_id]: upsertCachedRow(cache, row),
      };
    }
    outcome = 'applied';
    return updates;
  });
  return outcome;
}

// ─── Generic single-list merger ──────────────────────────────────
//
// Used for top-level slices that are flat AppX[] arrays keyed by id:
// models, model_groups, workflows, workflow_groups, workflow_runs,
// dashboards, model_views, profiles, roles, users.
function mergeFlatList<T extends { id: string; updated_at?: string }>(
  event: PgEvent,
  payload: { new?: T; old?: Partial<T> },
  current: T[],
): { next: T[]; outcome: RealtimeOutcome } {
  if (event === 'DELETE') {
    const id = payload.old?.id;
    if (!id) return { next: current, outcome: 'noop' };
    const filtered = current.filter((r) => r.id !== id);
    if (filtered.length === current.length) return { next: current, outcome: 'noop' };
    return { next: filtered, outcome: 'applied' };
  }
  const row = payload.new;
  if (!row?.id) return { next: current, outcome: 'noop' };
  const existing = current.find((r) => r.id === row.id);
  if (event === 'UPDATE' && isIncomingStale(existing, row)) {
    return { next: current, outcome: 'skipped_stale' };
  }
  const nextList = existing
    ? current.map((r) => (r.id === row.id ? row : r))
    : [...current, row];
  return { next: nextList, outcome: 'applied' };
}

export function mergeModel(
  event: PgEvent,
  payload: { new?: AppModel; old?: Partial<AppModel> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.models);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { models: r.next } : s;
  });
  return outcome;
}

export function mergeModelGroup(
  event: PgEvent,
  payload: { new?: ModelGroup; old?: Partial<ModelGroup> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.groups);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { groups: r.next } : s;
  });
  return outcome;
}

export function mergeWorkflow(
  event: PgEvent,
  payload: { new?: Workflow; old?: Partial<Workflow> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.workflows);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { workflows: r.next } : s;
  });
  return outcome;
}

export function mergeWorkflowGroup(
  event: PgEvent,
  payload: { new?: WorkflowGroup; old?: Partial<WorkflowGroup> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.workflowGroups);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { workflowGroups: r.next } : s;
  });
  return outcome;
}

export function mergeWorkflowRun(
  event: PgEvent,
  payload: { new?: WorkflowRun; old?: Partial<WorkflowRun> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.workflowRuns);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { workflowRuns: r.next } : s;
  });
  return outcome;
}

export function mergeDashboard(
  event: PgEvent,
  payload: { new?: Dashboard; old?: Partial<Dashboard> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.dashboards);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { dashboards: r.next } : s;
  });
  return outcome;
}

export function mergeModelView(
  event: PgEvent,
  payload: { new?: ModelView; old?: Partial<ModelView> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.views);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { views: r.next } : s;
  });
  return outcome;
}

export function mergeProfile(
  event: PgEvent,
  payload: { new?: Profile; old?: Partial<Profile> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.profiles);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { profiles: r.next } : s;
  });
  return outcome;
}

export function mergeRole(
  event: PgEvent,
  payload: { new?: Role; old?: Partial<Role> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.roles);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { roles: r.next } : s;
  });
  return outcome;
}

export function mergeUser(
  event: PgEvent,
  payload: { new?: User; old?: Partial<User> },
  setState: SetState,
): RealtimeOutcome {
  let outcome: RealtimeOutcome = 'noop';
  setState((s) => {
    const r = mergeFlatList(event, payload, s.users);
    outcome = r.outcome;
    return r.outcome === 'applied' ? { users: r.next } : s;
  });
  return outcome;
}
