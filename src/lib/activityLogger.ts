/**
 * Client-side activity logger — the single funnel into the unified `/logs`
 * timeline. Every helper in here delegates to `appendActivityLog` on the
 * Zustand store, which handles in-memory state + localStorage + Supabase
 * write order. Helpers are intentionally fire-and-forget: any DB error is
 * swallowed by the store's standard supabase-error path so the user's
 * action never fails because logging did.
 *
 * IMPORTANT: do not throw from helpers. If the actor or model can't be
 * resolved, fall back to whatever we have. A missing log entry beats
 * crashing the action that triggered it.
 */

import { useAppStore } from '@/stores/appStore';
import type { AppRecord, AppModel, ActivityLogStatus, ActivityLogEntry } from '@/types';

// ─── Actor resolution ─────────────────────────────────────────────────

/**
 * Audit fix M5: actor provenance. The unified /logs timeline previously
 * couldn't tell a user's manual edit apart from a workflow / webhook /
 * AI-agent edit because every entry was attributed to whoever was
 * signed in. With ActivityActor threaded through saveRecord, each entry
 * persists `details.provenance` and the summary line carries a [bot]
 * prefix so filters work without a schema change.
 */
export type ActivityActor =
  | { kind: 'user' }
  | { kind: 'workflow'; workflow_id: string; run_id?: string }
  | { kind: 'webhook'; slug: string }
  | { kind: 'agent'; conversation_id?: string };

function actorLabelAr(actor: ActivityActor | undefined): string {
  if (!actor || actor.kind === 'user') return '';
  if (actor.kind === 'workflow') return '[سير عمل] ';
  if (actor.kind === 'webhook') return '[ويبهوك] ';
  return '[المساعد الذكي] ';
}

function actorLabelEn(actor: ActivityActor | undefined): string {
  if (!actor || actor.kind === 'user') return '';
  if (actor.kind === 'workflow') return '[workflow] ';
  if (actor.kind === 'webhook') return '[webhook] ';
  return '[agent] ';
}

interface ActorInfo {
  user_id: string | null;
  email: string | null;
}

/** Resolve the current actor from Zustand state. Falls back gracefully when
 *  the store hasn't initialized or the user is signed out. */
function currentActor(): ActorInfo {
  try {
    const s = useAppStore.getState();
    const user = s.users.find((u) => u.id === s.currentUserId);
    return {
      user_id: s.currentUserId ?? null,
      email: user?.email ?? s.authEmail ?? null,
    };
  } catch {
    return { user_id: null, email: null };
  }
}

// ─── Record diff ──────────────────────────────────────────────────────

/** Compute a per-field diff for record updates. Includes only fields whose
 *  value actually changed (deep-equality on JSON serialization, which is
 *  sufficient for our JSONB scalar/object/array values). */
export function diffRecordData(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const beforeData = before ?? {};
  const keys = new Set([...Object.keys(beforeData), ...Object.keys(after)]);
  for (const key of keys) {
    const a = beforeData[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diff[key] = { before: a, after: b };
    }
  }
  return diff;
}

// ─── Display helpers ──────────────────────────────────────────────────

function modelLabels(modelId: string | null | undefined): { ar: string; en: string } {
  if (!modelId) return { ar: '', en: '' };
  try {
    const model = useAppStore.getState().models.find((m) => m.id === modelId);
    if (!model) return { ar: modelId.slice(0, 8), en: modelId.slice(0, 8) };
    return { ar: model.label_ar, en: model.label_en };
  } catch {
    return { ar: '', en: '' };
  }
}

/** Best-effort title for a record — uses the model's card_config.title_field
 *  when present, otherwise the first text-ish field on the record's data. */
function recordTitle(record: AppRecord, model: AppModel | undefined): string {
  if (!model) return record.id.slice(0, 8);
  const titleFieldId = model.card_config?.title_field_id;
  if (titleFieldId) {
    const field = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.id === titleFieldId);
    if (field) {
      const v = record.data[field.name];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
  }
  // Fallback — first non-empty string value.
  for (const [, v] of Object.entries(record.data)) {
    if (typeof v === 'string' && v.trim()) return v.slice(0, 80);
  }
  return record.id.slice(0, 8);
}

// ─── Core append ──────────────────────────────────────────────────────

interface LogInput {
  category: ActivityLogEntry['category'];
  event_type: string;
  summary_ar: string;
  summary_en: string;
  details?: Record<string, unknown>;
  target_model_id?: string | null;
  target_record_id?: string | null;
  target_label?: string | null;
  duration_ms?: number | null;
  status?: ActivityLogStatus | null;
  error?: string | null;
  workflow_run_id?: string | null;
  /** Override the actor — used by webhooks/system events that have no current user. */
  actor_user_id?: string | null;
  actor_email?: string | null;
}

function append(input: LogInput): void {
  try {
    const actor = currentActor();
    useAppStore.getState().appendActivityLog({
      category: input.category,
      event_type: input.event_type,
      actor_user_id: input.actor_user_id !== undefined ? input.actor_user_id : actor.user_id,
      actor_email: input.actor_email !== undefined ? input.actor_email : actor.email,
      target_model_id: input.target_model_id ?? null,
      target_record_id: input.target_record_id ?? null,
      target_label: input.target_label ?? null,
      summary_ar: input.summary_ar,
      summary_en: input.summary_en,
      details: input.details ?? {},
      duration_ms: input.duration_ms ?? null,
      status: input.status ?? null,
      error: input.error ?? null,
      workflow_run_id: input.workflow_run_id ?? null,
    });
  } catch (err) {
    console.error('[activityLogger] append failed', err);
  }
}

// ─── Public helpers ───────────────────────────────────────────────────

export const activityLogger = {
  /** User signed in via Supabase Auth. */
  signIn(email: string, userId: string | null) {
    append({
      category: 'auth',
      event_type: 'sign_in',
      actor_user_id: userId,
      actor_email: email,
      status: 'success',
      summary_ar: `تسجيل دخول: ${email}`,
      summary_en: `Signed in: ${email}`,
      details: { email, user_id: userId },
    });
  },

  /** User signed out. */
  signOut(email: string | null, userId: string | null) {
    append({
      category: 'auth',
      event_type: 'sign_out',
      actor_user_id: userId,
      actor_email: email,
      status: 'info',
      summary_ar: email ? `تسجيل خروج: ${email}` : 'تسجيل خروج',
      summary_en: email ? `Signed out: ${email}` : 'Signed out',
      details: { email, user_id: userId },
    });
  },

  /** Record was created. The optional `actor` arg (audit fix M5) records
   *  provenance — workflow vs manual vs webhook vs AI agent. Persisted
   *  inside `details.provenance` so /logs filters can split timelines. */
  recordCreated(record: AppRecord, model: AppModel | undefined, actor?: ActivityActor) {
    const labels = modelLabels(record.model_id);
    const title = recordTitle(record, model);
    append({
      category: 'record',
      event_type: 'create',
      target_model_id: record.model_id,
      target_record_id: record.id,
      target_label: title,
      status: 'success',
      summary_ar: `${actorLabelAr(actor)}إنشاء سجل في "${labels.ar}": ${title}`,
      summary_en: `${actorLabelEn(actor)}Created record in "${labels.en}": ${title}`,
      details: {
        model_label_ar: labels.ar,
        model_label_en: labels.en,
        record_data: record.data,
        ...(actor ? { provenance: actor } : {}),
      },
    });
  },

  /** Record was updated. Logs only the changed fields, not the full snapshot. */
  recordUpdated(record: AppRecord, previous: AppRecord, model: AppModel | undefined, actor?: ActivityActor) {
    const labels = modelLabels(record.model_id);
    const title = recordTitle(record, model);
    const diff = diffRecordData(previous.data, record.data);
    const changedKeys = Object.keys(diff);
    if (changedKeys.length === 0) return; // no-op save → don't spam the log
    append({
      category: 'record',
      event_type: 'update',
      target_model_id: record.model_id,
      target_record_id: record.id,
      target_label: title,
      status: 'success',
      summary_ar: `${actorLabelAr(actor)}تحديث "${title}" — ${changedKeys.length} حقل`,
      summary_en: `${actorLabelEn(actor)}Updated "${title}" — ${changedKeys.length} field(s)`,
      details: {
        model_label_ar: labels.ar,
        model_label_en: labels.en,
        changed_fields: diff,
        changed_count: changedKeys.length,
        ...(actor ? { provenance: actor } : {}),
      },
    });
  },

  /** Record was deleted. Logs the last known snapshot for forensics. */
  recordDeleted(record: AppRecord, model: AppModel | undefined, actor?: ActivityActor) {
    const labels = modelLabels(record.model_id);
    const title = recordTitle(record, model);
    append({
      category: 'record',
      event_type: 'delete',
      target_model_id: record.model_id,
      target_record_id: record.id,
      target_label: title,
      status: 'warning',
      summary_ar: `${actorLabelAr(actor)}حذف سجل من "${labels.ar}": ${title}`,
      summary_en: `${actorLabelEn(actor)}Deleted record in "${labels.en}": ${title}`,
      details: {
        model_label_ar: labels.ar,
        model_label_en: labels.en,
        last_snapshot: record.data,
        ...(actor ? { provenance: actor } : {}),
      },
    });
  },

  /** A user opened a record (navigated to its detail/form page). */
  recordOpened(recordId: string, modelId: string, model: AppModel | undefined, record: AppRecord | undefined) {
    const labels = modelLabels(modelId);
    const title = record && model ? recordTitle(record, model) : recordId.slice(0, 8);
    append({
      category: 'record',
      event_type: 'open',
      target_model_id: modelId,
      target_record_id: recordId,
      target_label: title,
      status: 'info',
      summary_ar: `فتح سجل "${title}" في "${labels.ar}"`,
      summary_en: `Opened record "${title}" in "${labels.en}"`,
      details: {
        model_label_ar: labels.ar,
        model_label_en: labels.en,
      },
    });
  },

  /** Mirror of a workflow run, used for the unified timeline. The rich detail
   *  still lives in `workflow_runs` — the UI uses workflow_run_id to deep-link. */
  workflowRunSummary(args: {
    runId: string;
    workflowId: string;
    workflowLabelAr: string;
    workflowLabelEn: string;
    triggerEvent: string;
    triggerModelId: string | null;
    triggerRecordId: string | null;
    status: string;
    durationMs: number;
    actorUserId: string | null;
    error?: string;
    actionsCount: number;
    conditionsPassed: boolean;
  }) {
    const ok = args.status === 'success' || args.status === 'partial_success';
    const labels = modelLabels(args.triggerModelId);
    append({
      category: 'workflow',
      event_type: 'run',
      actor_user_id: args.actorUserId,
      target_model_id: args.triggerModelId,
      target_record_id: args.triggerRecordId,
      target_label: labels.en,
      status: args.status === 'success' ? 'success' : args.status === 'failed' ? 'error' : args.status === 'skipped' ? 'info' : 'warning',
      duration_ms: args.durationMs,
      error: args.error ?? null,
      workflow_run_id: args.runId,
      summary_ar: `${ok ? 'تنفيذ سير عمل' : 'فشل/تخطي'} "${args.workflowLabelAr}" (${args.actionsCount} إجراء)`,
      summary_en: `${ok ? 'Ran workflow' : 'Workflow ' + args.status} "${args.workflowLabelEn}" (${args.actionsCount} action${args.actionsCount === 1 ? '' : 's'})`,
      details: {
        workflow_id: args.workflowId,
        workflow_run_id: args.runId,
        trigger_event: args.triggerEvent,
        conditions_passed: args.conditionsPassed,
        actions_count: args.actionsCount,
      },
    });
  },
};
