/**
 * Server-side mini-engine for the `on_due` workflow trigger.
 *
 * The client-side workflow engine (`src/lib/workflowEngine.ts`) runs in
 * the browser and handles the `create` / `update` / `delete` / `webhook`
 * / `button_click` triggers — those fire synchronously after a record
 * save.
 *
 * `on_due` is different: it fires when a followup's `scheduled_datetime`
 * arrives, regardless of whether any browser tab is open. The
 * `api/sweep-due-followups.ts` cron endpoint sweeps for due rows every 5
 * minutes and calls into this module to execute their workflows.
 *
 * **Supported scope (v1):**
 *   - Trigger event: `on_due` only.
 *   - Trigger model: `followups` only.
 *   - Action types: `update_record`, `create_record`, `send_whatsapp_message`.
 *   - Field-mapping sources: `static`, `trigger_field`, `current_date`,
 *     `record_id`, `date_expression`.
 *
 * **Unsupported in v1 (loud failure, no silent skip):**
 *   - Other action types (`outbound_ivr`, `http_request`, `assign_user`,
 *     `send_notification`, `paseet_query`) — they're either client-only
 *     (notifications) or not yet wired here. The action's status comes
 *     back as `failed` with reason `unsupported_in_sweeper` so the run
 *     summary surfaces it loudly.
 *   - Field-mapping sources `current_user`, `role_variable`, `formula`
 *     resolve to `null` with a console warn. Not silent — just narrow
 *     in v1.
 *
 * Mirrors the client engine's semantics for the supported subset:
 *   - Branch evaluation: top-down, first match wins, `else` is the
 *     trailing default.
 *   - Branch `condition_mode`: `'all'` (AND, default) or `'any'` (OR).
 *   - `update_record` filter is lookup-aware (single-lookup field whose
 *     `lookup_model_id` matches `target_model_id` → match by record id).
 *
 * @see docs/prd/workflow-automation.md
 */

// Web Crypto API (`crypto.randomUUID`, `crypto.subtle.digest`) instead of
// `node:crypto`. Vercel's edge runtime ships the Web Crypto API as a
// global but disallows the `node:crypto` import.
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AppRecord,
  AppModel,
  OutboundIvrDestination,
  Workflow,
  WorkflowAction,
  WorkflowActionCreateRecord,
  WorkflowActionUpdateRecord,
  WorkflowActionSendWhatsAppMessage,
  FieldMapping,
  WorkflowCondition,
  WorkflowRun,
  WorkflowConditionTrace,
  WorkflowActionTrace,
  WorkflowBranchTrace,
  FieldMappingTrace,
} from '../../src/types/index.js';
import {
  applyDateExpression,
  evaluateCondition,
  formatDateForField,
  getWorkflowBranches,
  substituteFieldTokens,
} from '../../src/lib/workflowEngineCore.js';
import { normalizePhone } from '../../src/lib/phone.js';
import { sendMessage as haberchatSendMessage, resolveDefaultDeviceId } from './whatsappGateway.js';

interface ActionResult {
  action_id: string;
  type: WorkflowAction['type'];
  status: 'executed' | 'skipped' | 'failed';
  reason?: string;
  detail?: Record<string, unknown>;
}

interface BranchResult {
  branch_id: string;
  conditions_passed: boolean;
  was_selected: boolean;
}

export interface WorkflowRunSummary {
  workflow_id: string;
  workflow_label_en?: string;
  trigger_record_id: string;
  branches: BranchResult[];
  selected_branch_id?: string;
  actions: ActionResult[];
  status: 'success' | 'partial_success' | 'failed' | 'skipped';
}

export interface SweeperContext {
  supabase: SupabaseClient;
  models: AppModel[];
  workflows: Workflow[];
  // Cached records keyed by model_id, used for lookup-aware filter
  // resolution and to find dedup matches when create_record has
  // skip_if_exists set. Lazily populated as needed.
  recordsByModel: Map<string, AppRecord[]>;
}

/**
 * Run every active `on_due` workflow whose `trigger_model_id` matches the
 * triggerRecord's model. Returns a per-workflow summary the caller can log.
 */
export async function runOnDueForRecord(
  triggerRecord: AppRecord,
  ctx: SweeperContext,
): Promise<WorkflowRunSummary[]> {
  const matching = ctx.workflows.filter(
    (w) =>
      w.is_active &&
      w.trigger_event === 'on_due' &&
      w.trigger_model_id === triggerRecord.model_id,
  );
  const summaries: WorkflowRunSummary[] = [];
  for (const workflow of matching) {
    summaries.push(await runWorkflow(workflow, triggerRecord, ctx));
  }
  return summaries;
}

async function runWorkflow(
  workflow: Workflow,
  triggerRecord: AppRecord,
  ctx: SweeperContext,
): Promise<WorkflowRunSummary> {
  const startedMs = Date.now();
  const startedIso = new Date().toISOString();
  const branches = getWorkflowBranches(workflow);
  // Lightweight summary trace (returned to the cron response) + rich
  // WorkflowBranchTrace[] (persisted to workflow_runs for the Logs page).
  const branchSummaries: BranchResult[] = [];
  const branchTraces: WorkflowBranchTrace[] = [];
  let winnerIdx = -1;

  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]!;
    const decided = winnerIdx >= 0;
    if (decided) {
      // An earlier branch already won — record this one as not-evaluated.
      branchSummaries.push({ branch_id: b.id, conditions_passed: false, was_selected: false });
      branchTraces.push({
        branch_id: b.id,
        branch_label_ar: b.label_ar,
        branch_label_en: b.label_en,
        is_else: b.is_else ?? false,
        conditions_trace: [],
        conditions_passed: false,
        evaluated: false,
        was_selected: false,
      });
      continue;
    }
    if (b.is_else) {
      winnerIdx = i;
      branchSummaries.push({ branch_id: b.id, conditions_passed: true, was_selected: true });
      branchTraces.push({
        branch_id: b.id,
        branch_label_ar: b.label_ar,
        branch_label_en: b.label_en,
        is_else: true,
        conditions_trace: [],
        conditions_passed: true,
        evaluated: true,
        was_selected: true,
      });
      continue;
    }
    const condTraces = b.conditions.map((c) => buildConditionTrace(c, triggerRecord.data));
    const mode = b.condition_mode ?? 'all';
    const passed = condTraces.length === 0
      ? true
      : (mode === 'any' ? condTraces.some((t) => t.result) : condTraces.every((t) => t.result));
    if (passed) winnerIdx = i;
    branchSummaries.push({ branch_id: b.id, conditions_passed: passed, was_selected: passed });
    branchTraces.push({
      branch_id: b.id,
      branch_label_ar: b.label_ar,
      branch_label_en: b.label_en,
      is_else: false,
      conditions_trace: condTraces,
      conditions_passed: passed,
      evaluated: true,
      was_selected: passed,
    });
  }

  if (winnerIdx < 0) {
    // No branch matched — log a `skipped` run so the Logs page shows the
    // sweeper evaluated this workflow and why nothing fired.
    await insertWorkflowRun(buildRunRow({
      workflow, triggerRecord, ctx, startedMs, startedIso,
      branchTraces, winnerBranchTrace: branchTraces[0], actionTraces: [], status: 'skipped',
      selectedBranchId: undefined,
    }), ctx);
    return {
      workflow_id: workflow.id,
      workflow_label_en: workflow.label_en,
      trigger_record_id: triggerRecord.id,
      branches: branchSummaries,
      actions: [],
      status: 'skipped',
    };
  }

  const winner = branches[winnerIdx]!;
  const actions: ActionResult[] = [];
  const actionTraces: WorkflowActionTrace[] = [];
  let anyFailed = false;
  let anyExecuted = false;
  // Map of action_id → record this action created. Lets `prev_action_output`
  // destinations (rare, but supported for parity with the client engine)
  // resolve against records the workflow just created.
  const prevActionOutputs: Record<string, AppRecord> = {};

  for (let idx = 0; idx < winner.actions.length; idx++) {
    const action = winner.actions[idx]!;
    const result = await executeAction(action, triggerRecord, ctx, prevActionOutputs);
    actions.push(result);
    actionTraces.push(buildActionTrace(action, result, idx, triggerRecord));
    if (result.status === 'executed') anyExecuted = true;
    if (result.status === 'failed') anyFailed = true;
    // A self-update that lost an optimistic-concurrency race (`version_conflict`)
    // means a human — or a concurrent tick — changed the trigger record since it
    // was selected. The rest of this branch assumes that update landed (e.g. the
    // appointment no-show flow's client move + recovery follow-up assume the
    // appointment is now no_show), so we ABORT the remaining actions rather than
    // act on a record we didn't actually change. This keeps "never override a
    // human update" true for the WHOLE sequence, not just the flip. Only
    // `version_conflict` aborts — it is produced solely by version-guarded
    // self-updates (the appointment no-show sweeper passes a trigger `version`),
    // so no other on_due workflow's behavior changes.
    if (result.status === 'skipped' && result.reason === 'version_conflict') break;
  }

  const status: WorkflowRunSummary['status'] = anyFailed
    ? (anyExecuted ? 'partial_success' : 'failed')
    : 'success';

  await insertWorkflowRun(buildRunRow({
    workflow, triggerRecord, ctx, startedMs, startedIso,
    branchTraces, winnerBranchTrace: branchTraces[winnerIdx], actionTraces, status,
    selectedBranchId: winner.id,
  }), ctx);

  return {
    workflow_id: workflow.id,
    workflow_label_en: workflow.label_en,
    trigger_record_id: triggerRecord.id,
    branches: branchSummaries,
    selected_branch_id: winner.id,
    actions,
    status,
  };
}

/* ─── workflow_runs logging (Phase 6 — on_due → Logs parity) ─────────── */

/**
 * Build a full WorkflowRun row from a sweeper execution. Uses the SAME closed
 * `WorkflowRunStatus` union as the client engine — unsupported sweeper actions
 * are recorded as per-action `failed` entries in `actions_trace` (with reason
 * `unsupported_in_sweeper`) and roll the run up to `partial_success`/`failed`;
 * we never invent a new status (which would need type + UI changes). The row is
 * realtime-published, so the Logs page shows on_due runs without a reload.
 */
function buildRunRow(args: {
  workflow: Workflow;
  triggerRecord: AppRecord;
  ctx: SweeperContext;
  startedMs: number;
  startedIso: string;
  branchTraces: WorkflowBranchTrace[];
  winnerBranchTrace: WorkflowBranchTrace | undefined;
  actionTraces: WorkflowActionTrace[];
  status: WorkflowRunSummary['status'];
  selectedBranchId: string | undefined;
}): WorkflowRun {
  const { workflow, triggerRecord, ctx, startedMs, startedIso } = args;
  const triggerModel = ctx.models.find((m) => m.id === triggerRecord.model_id);
  const label = workflow.label_en || workflow.label_ar || 'workflow';
  return {
    id: crypto.randomUUID(),
    workflow_id: workflow.id,
    workflow_label_ar: workflow.label_ar || label,
    workflow_label_en: workflow.label_en || label,
    trigger_event: 'on_due',
    trigger_model_id: triggerRecord.model_id,
    trigger_model_label_ar: triggerModel?.label_ar,
    trigger_model_label_en: triggerModel?.label_en,
    trigger_record_id: triggerRecord.id,
    trigger_record_snapshot: triggerRecord.data,
    // on_due has no "before" image — the row's scheduled time arrived; it
    // wasn't an edit. Left undefined so the Logs page hides the diff panel.
    triggered_by_user_id: null, // cron/system, not a user action
    depth: 0,
    started_at: startedIso,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    status: args.status,
    conditions_trace: args.winnerBranchTrace?.conditions_trace ?? [],
    conditions_passed: args.winnerBranchTrace?.conditions_passed ?? false,
    actions_trace: args.actionTraces,
    // Only attach the branch tree when there's a real if/else to show.
    branches_trace: args.branchTraces.length > 1 ? args.branchTraces : undefined,
    selected_branch_id: args.selectedBranchId,
  };
}

async function insertWorkflowRun(row: WorkflowRun, ctx: SweeperContext): Promise<void> {
  // supabase-js drops `undefined` keys on serialize, so optional columns fall
  // back to their DB defaults/null. Service-role client → bypasses RLS.
  const { error } = await ctx.supabase.from('workflow_runs').insert(row);
  if (error) {
    // Never silent: the workflow already executed; only its audit row failed.
    // We don't fail the sweep over a logging miss, but we surface it loudly so
    // a schema/permission drift on workflow_runs is diagnosable from cron logs.
    // eslint-disable-next-line no-console
    console.error(
      `[workflowSweeper] failed to write workflow_runs row for workflow ${row.workflow_id} / record ${row.trigger_record_id}: ${error.message}`,
    );
  }
}

function buildConditionTrace(c: WorkflowCondition, data: Record<string, unknown>): WorkflowConditionTrace {
  const passes = evaluateCondition(c, data);
  return {
    id: c.id,
    field_id: c.field_id,
    operator: c.operator,
    expected_value: c.value,
    actual_value: data[c.field_id],
    only_on_change: c.only_on_change ?? false,
    // on_due fires on a scheduled time, not a field edit — there's no previous
    // record image, so `only_on_change` can't suppress and result == passes_now.
    passes_now: passes,
    result: passes,
  };
}

function describeMappingSource(m: FieldMapping): string {
  switch (m.source_type) {
    case 'static': return `static: ${String(m.static_value ?? '')}`;
    case 'trigger_field': return `trigger.${m.trigger_field_id ?? ''}`;
    case 'record_id': return 'trigger record id';
    case 'current_date': return 'now()';
    case 'date_expression': return `date_expr(${m.date_expression ?? ''})`;
    default: return m.source_type;
  }
}

function describeMapping(mapping: FieldMapping, triggerRecord: AppRecord): FieldMappingTrace {
  return {
    target_field_id: mapping.target_field_id,
    source_type: mapping.source_type,
    source_description: describeMappingSource(mapping),
    resolved_value: resolveFieldMapping(mapping, triggerRecord),
    ...(mapping.trigger_field_id ? { trigger_field_id: mapping.trigger_field_id } : {}),
  };
}

function buildActionTrace(
  action: WorkflowAction,
  result: ActionResult,
  index: number,
  triggerRecord: AppRecord,
): WorkflowActionTrace {
  const base = {
    id: action.id,
    order: index,
    status: result.status,
    duration_ms: 0, // the sweeper doesn't time individual actions in v1
    ...(result.reason ? { skip_reason: result.reason } : {}),
    ...(result.detail && typeof result.detail.message === 'string' ? { error: result.detail.message } : {}),
  };
  const detail = result.detail ?? {};
  switch (action.type) {
    case 'create_record': {
      const resolved: Record<string, unknown> = {};
      for (const m of action.field_mappings) resolved[m.target_field_id] = resolveFieldMapping(m, triggerRecord);
      return {
        ...base,
        type: 'create_record',
        target_model_id: action.target_model_id,
        resolved_data: resolved,
        field_mappings: action.field_mappings.map((m) => describeMapping(m, triggerRecord)),
        created_record_id: typeof detail.created_record_id === 'string' ? detail.created_record_id : undefined,
        dedup_match_record_id: typeof detail.matched_record_id === 'string' ? detail.matched_record_id : undefined,
      };
    }
    case 'update_record': {
      const filterValueSource = action.filter_value_source ?? 'static';
      const resolvedFilter = (filterValueSource === 'trigger_field' && action.filter_trigger_field_id)
        ? triggerRecord.data[action.filter_trigger_field_id]
        : action.filter_value;
      return {
        ...base,
        type: 'update_record',
        target_model_id: action.target_model_id,
        filter_field_id: action.filter_field_id,
        filter_value_source: filterValueSource,
        filter_trigger_field_id: action.filter_trigger_field_id,
        resolved_filter_value: resolvedFilter,
        matched_record_id: typeof detail.matched_record_id === 'string' ? detail.matched_record_id : undefined,
        field_mappings: action.field_mappings.map((m) => describeMapping(m, triggerRecord)),
      };
    }
    case 'send_whatsapp_message': {
      return {
        ...base,
        type: 'send_whatsapp_message',
        resolved_to_number: typeof detail.phone === 'string' ? detail.phone : undefined,
        message_wid: typeof detail.wid === 'string' ? detail.wid : undefined,
        response_status: typeof detail.status === 'number' ? detail.status : undefined,
      };
    }
    default:
      // The trace union intentionally doesn't model the unsupported-in-sweeper
      // action types (and has no variant for `paseet_query`). We still record
      // the failed entry + reason so the run log is complete; the detail page
      // renders the header + skip-reason note and skips the (absent) body. A
      // single targeted cast at this boundary — the data is bound for JSONB.
      return { ...base, type: (action as WorkflowAction).type } as WorkflowActionTrace;
  }
}

async function executeAction(
  action: WorkflowAction,
  triggerRecord: AppRecord,
  ctx: SweeperContext,
  prevActionOutputs: Record<string, AppRecord>,
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case 'update_record':
        return await executeUpdateRecord(action, triggerRecord, ctx);
      case 'create_record':
        return await executeCreateRecord(action, triggerRecord, ctx, prevActionOutputs);
      case 'send_whatsapp_message':
        return await executeSendWhatsApp(action, triggerRecord, ctx, prevActionOutputs);
      // The remaining action types are intentionally unsupported in v1 —
      // we fail loudly so users understand why their on_due workflow
      // didn't behave as expected. The client-side engine still handles
      // these on `create`/`update`/etc. triggers.
      case 'send_notification':
      case 'outbound_ivr':
      case 'http_request':
      case 'assign_user':
      case 'paseet_query':
      default:
        // eslint-disable-next-line no-console
        console.warn(
          `[workflowSweeper] action type "${(action as WorkflowAction).type}" is not supported on the on_due trigger yet — skipping`,
        );
        return {
          action_id: action.id,
          type: (action as WorkflowAction).type,
          status: 'failed',
          reason: 'unsupported_in_sweeper',
        };
    }
  } catch (err) {
    return {
      action_id: action.id,
      type: action.type,
      status: 'failed',
      reason: 'exception',
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/* ─── update_record ────────────────────────────────────────────────── */

async function executeUpdateRecord(
  action: WorkflowActionUpdateRecord,
  triggerRecord: AppRecord,
  ctx: SweeperContext,
): Promise<ActionResult> {
  const targetRecords = await loadRecordsForModel(action.target_model_id, ctx);
  const filterValueSource = action.filter_value_source ?? 'static';
  const filterValue = (filterValueSource === 'trigger_field' && action.filter_trigger_field_id)
    ? triggerRecord.data[action.filter_trigger_field_id]
    : action.filter_value;

  // Lookup-aware match — same posture as the client engine.
  let target: AppRecord | undefined;
  if (filterValueSource === 'trigger_field' && action.filter_trigger_field_id && typeof filterValue === 'string') {
    const triggerModel = ctx.models.find((m) => m.id === triggerRecord.model_id);
    const triggerField = triggerModel?.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.name === action.filter_trigger_field_id);
    if (
      triggerField?.type === 'lookup' &&
      !triggerField.is_multi &&
      triggerField.lookup_model_id === action.target_model_id
    ) {
      target = targetRecords.find((r) => r.id === filterValue);
    }
  }
  if (!target && action.filter_field_id === 'id' && typeof filterValue === 'string') {
    target = targetRecords.find((r) => r.id === filterValue);
  }
  if (!target) {
    target = targetRecords.find((r) => r.data[action.filter_field_id] === filterValue);
  }
  if (!target) {
    return { action_id: action.id, type: 'update_record', status: 'skipped', reason: 'no_matching_record' };
  }

  const updatedData = { ...target.data };
  for (const mapping of action.field_mappings) {
    const value = resolveFieldMapping(mapping, triggerRecord);
    updatedData[mapping.target_field_id] = value;
  }

  // Optimistic-concurrency guard for self-updates — the trigger record updating
  // ITSELF (e.g. the appointment no-show auto-close flips its own status). When
  // the engine is handed a trigger record carrying its loaded `version` (the
  // appointment sweeper does this), pass it as p_expected_version so a write
  // that bumped the version since selection — a human editing the record, or a
  // concurrent cron tick — is rejected. A rejected flip is SKIPPED, never an
  // override. Other on_due paths (e.g. followups) don't set `version`, so
  // expectedVersion stays null and behavior is unchanged (null == skip check).
  const isSelfUpdate = target.id === triggerRecord.id;
  const expectedVersion = isSelfUpdate && typeof triggerRecord.version === 'number'
    ? triggerRecord.version
    : null;

  const { error } = await ctx.supabase.rpc('record_save', {
    p_model_id: action.target_model_id,
    p_id: target.id,
    p_data: updatedData,
    p_created_by: target.created_by_user_id ?? null,
    p_expected_version: expectedVersion,
  });
  if (error) {
    // SQLSTATE 40001 / version_mismatch = a concurrent (human or sweep) write
    // won the race. Record it as skipped (surfaced loudly in the run log), not
    // failed, and never retry-overwrite — this is what honors "a manual update
    // is never overridden".
    const isVersionConflict = error.code === '40001' || /version_mismatch/i.test(error.message ?? '');
    return {
      action_id: action.id,
      type: 'update_record',
      status: isVersionConflict ? 'skipped' : 'failed',
      reason: isVersionConflict ? 'version_conflict' : 'rpc_error',
      detail: { message: error.message },
    };
  }

  // Invalidate the model's cache so a later action in the same workflow
  // sees the fresh data.
  ctx.recordsByModel.delete(action.target_model_id);

  return {
    action_id: action.id,
    type: 'update_record',
    status: 'executed',
    detail: { matched_record_id: target.id },
  };
}

/* ─── create_record ────────────────────────────────────────────────── */

async function executeCreateRecord(
  action: WorkflowActionCreateRecord,
  triggerRecord: AppRecord,
  ctx: SweeperContext,
  prevActionOutputs: Record<string, AppRecord>,
): Promise<ActionResult> {
  const data: Record<string, unknown> = {};
  for (const mapping of action.field_mappings) {
    data[mapping.target_field_id] = resolveFieldMapping(mapping, triggerRecord);
  }

  // skip_if_exists guard — same as client engine.
  if (action.skip_if_exists && action.dedup_target_field_id) {
    const existing = await loadRecordsForModel(action.target_model_id, ctx);
    const dup = existing.find((r) => r.data[action.dedup_target_field_id!] === data[action.dedup_target_field_id!]);
    if (dup) {
      return {
        action_id: action.id,
        type: 'create_record',
        status: 'skipped',
        reason: 'duplicate_exists',
        detail: { matched_record_id: dup.id },
      };
    }
  }

  const newId = crypto.randomUUID();
  const newRecord: AppRecord = {
    id: newId,
    model_id: action.target_model_id,
    data,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await ctx.supabase.rpc('record_save', {
    p_model_id: action.target_model_id,
    p_id: newId,
    p_data: data,
    p_created_by: null,
  });
  if (error) {
    return {
      action_id: action.id,
      type: 'create_record',
      status: 'failed',
      reason: 'rpc_error',
      detail: { message: error.message },
    };
  }

  prevActionOutputs[action.id] = newRecord;
  ctx.recordsByModel.delete(action.target_model_id);

  return {
    action_id: action.id,
    type: 'create_record',
    status: 'executed',
    detail: { created_record_id: newId },
  };
}

/* ─── send_whatsapp_message ─────────────────────────────────────────── */

async function executeSendWhatsApp(
  action: WorkflowActionSendWhatsAppMessage,
  triggerRecord: AppRecord,
  ctx: SweeperContext,
  prevActionOutputs: Record<string, AppRecord>,
): Promise<ActionResult> {
  const dest = action.to ?? { kind: 'trigger_field' as const, field_name: action.to_field_id ?? '' };
  const phone = await resolveDestinationPhone(dest, triggerRecord, ctx, prevActionOutputs);
  if (!phone) {
    return { action_id: action.id, type: 'send_whatsapp_message', status: 'skipped', reason: 'no_destination_number' };
  }

  const body = substituteFieldTokens(action.body_template ?? '', triggerRecord, {
    triggerModel: ctx.models.find((m) => m.id === triggerRecord.model_id),
    recordsByModel: ctx.recordsByModel,
  });
  if (!body.trim()) {
    return { action_id: action.id, type: 'send_whatsapp_message', status: 'skipped', reason: 'empty_body_after_substitution' };
  }

  // Resolve the sending device. Action override → server env default.
  // The client engine also consults the user's overlay default but that
  // table is per-user — for cron we fall back to the env default.
  const deviceId = action.device_id || (await resolveDefaultDeviceId());
  if (!deviceId) {
    return {
      action_id: action.id,
      type: 'send_whatsapp_message',
      status: 'failed',
      reason: 'no_device_id',
      detail: { hint: 'set HABERCHAT_DEFAULT_DEVICE_ID in env or pin a device on the workflow action' },
    };
  }

  // Idempotency reference: stable hash of (workflow-action, trigger record,
  // trigger record's fired_at). Re-running the sweeper for the same row
  // (e.g. a cron retry after a partial failure) gives the same reference,
  // and Haberchat dedupes by `reference` server-side. Web Crypto's
  // `subtle.digest` returns an ArrayBuffer that we hex-encode by hand.
  const refInput = `${action.id}|${triggerRecord.id}|${String(triggerRecord.data.fired_at ?? '')}`;
  const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refInput));
  const reference = Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);

  try {
    const result = await haberchatSendMessage({ deviceId, phone, body, reference });
    return {
      action_id: action.id,
      type: 'send_whatsapp_message',
      status: 'executed',
      detail: { wid: result.wid, status: result.status, phone, body_length: body.length },
    };
  } catch (err) {
    return {
      action_id: action.id,
      type: 'send_whatsapp_message',
      status: 'failed',
      reason: 'haberchat_error',
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/* ─── shared helpers ────────────────────────────────────────────────── */

function getTargetFieldType(
  models: AppModel[],
  modelId: string,
  fieldName: string,
): string | undefined {
  const model = models.find((m) => m.id === modelId);
  for (const s of model?.schema.sections ?? []) {
    for (const f of s.fields) {
      if (f.name === fieldName) return f.type;
    }
  }
  return undefined;
}

function resolveFieldMapping(mapping: FieldMapping, triggerRecord: AppRecord): unknown {
  switch (mapping.source_type) {
    case 'static':
      return mapping.static_value ?? null;
    case 'trigger_field':
      return mapping.trigger_field_id ? triggerRecord.data[mapping.trigger_field_id] : null;
    case 'current_date': {
      // We don't know the target field type from the mapping alone — the
      // sweeper doesn't track every model's field types. Default to
      // datetime format which is a strict superset of date and round-trips
      // through the form's <input type="datetime-local">.
      return formatDateForField(new Date(), 'datetime');
    }
    case 'record_id':
      return triggerRecord.id;
    case 'date_expression': {
      const baseVal = mapping.date_base === 'trigger_field' && mapping.date_base_field_id
        ? triggerRecord.data[mapping.date_base_field_id]
        : new Date();
      const baseDate = baseVal instanceof Date ? baseVal : new Date(String(baseVal ?? ''));
      if (isNaN(baseDate.getTime())) return null;
      return formatDateForField(applyDateExpression(baseDate, mapping.date_expression ?? ''), 'datetime');
    }
    case 'current_user':
    case 'role_variable':
    case 'formula':
      // eslint-disable-next-line no-console
      console.warn(
        `[workflowSweeper] field-mapping source "${mapping.source_type}" is not supported on the on_due trigger yet — resolving to null`,
      );
      return null;
    default:
      return null;
  }
}

async function loadRecordsForModel(modelId: string, ctx: SweeperContext): Promise<AppRecord[]> {
  const cached = ctx.recordsByModel.get(modelId);
  if (cached) return cached;
  // Read through unified_records so we cover both records-table-backed
  // models and frozen models without branching here. Same posture the
  // client store uses on initial load.
  const { data, error } = await ctx.supabase
    .from('unified_records')
    .select('id, model_id, data, created_by_user_id, created_at, updated_at')
    .eq('model_id', modelId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`[workflowSweeper] failed to load records for model ${modelId}: ${error.message}`);
    return [];
  }
  const rows: AppRecord[] = (data ?? []).map((r) => ({
    id: r.id as string,
    model_id: r.model_id as string,
    data: (r.data as Record<string, unknown>) ?? {},
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    created_by_user_id: (r.created_by_user_id as string | null) ?? undefined,
  }));
  ctx.recordsByModel.set(modelId, rows);
  return rows;
}

async function resolveDestinationPhone(
  dest: OutboundIvrDestination,
  triggerRecord: AppRecord,
  ctx: SweeperContext,
  prevActionOutputs: Record<string, AppRecord>,
): Promise<string | null> {
  switch (dest.kind) {
    case 'trigger_field': {
      const raw = triggerRecord.data[dest.field_name];
      return typeof raw === 'string' ? normalizePhone(raw) : null;
    }
    case 'static': {
      return normalizePhone(dest.phone);
    }
    case 'lookup': {
      const lookupValue = triggerRecord.data[dest.lookup_field_name];
      const targetId = Array.isArray(lookupValue) ? lookupValue[0] : lookupValue;
      if (typeof targetId !== 'string' || !targetId) return null;
      const triggerModel = ctx.models.find((m) => m.id === triggerRecord.model_id);
      const lookupField = triggerModel?.schema.sections
        .flatMap((s) => s.fields)
        .find((f) => f.name === dest.lookup_field_name);
      if (!lookupField?.lookup_model_id) return null;
      const targetRecords = await loadRecordsForModel(lookupField.lookup_model_id, ctx);
      const targetRecord = targetRecords.find((r) => r.id === targetId);
      if (!targetRecord) return null;
      const raw = targetRecord.data[dest.target_phone_field_name];
      return typeof raw === 'string' ? normalizePhone(raw) : null;
    }
    case 'prev_action_output': {
      const rec = prevActionOutputs[dest.action_id];
      if (!rec) return null;
      const raw = rec.data[dest.phone_field_name];
      return typeof raw === 'string' ? normalizePhone(raw) : null;
    }
    default:
      return null;
  }
}

// Suppress unused-warning for the model-type helper — kept for future
// validation that mappings target known fields. No-op until then.
void getTargetFieldType;
