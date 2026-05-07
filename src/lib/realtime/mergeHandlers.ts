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
function isIncomingStale(local: { updated_at?: string } | undefined, incoming: { updated_at?: string }): boolean {
  if (!local?.updated_at || !incoming.updated_at) return false;
  return local.updated_at >= incoming.updated_at;
}

// ─── records ──────────────────────────────────────────────────────
//
// records[modelId]: AppRecord[]. INSERT/UPDATE upsert by id within the
// model's bucket. DELETE removes by id; with REPLICA IDENTITY DEFAULT
// (the records table) payload.old contains only `id` — that's all we
// need.
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
      if (!removed) return s;
      outcome = 'applied';
      return { records: next };
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
    if (!s.models.some((m) => m.id === row.model_id)) {
      outcome = 'skipped_unknown_model';
      return s;
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
    outcome = 'applied';
    return { records: { ...s.records, [row.model_id]: nextList } };
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
