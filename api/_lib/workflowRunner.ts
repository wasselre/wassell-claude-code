/**
 * Server-authoritative workflow runner (Phase 1).
 *
 * Executes the workflows eligible for ONE captured event (a `workflow_jobs`
 * row). Invoked only by `/api/internal/run-workflow-job` after that endpoint
 * has loaded + validated the job (status='processing', lease fresh, locked by
 * the caller). The runner OWNS execution; it NEVER touches the queue lifecycle
 * (no workflow_job_complete/_fail — that's the worker's job).
 *
 * Scope (v1, deliberately narrow — fail loudly outside it):
 *   - Action types: create_record, update_record ONLY (SUPPORTED_ACTION_TYPES).
 *     Any other action in a winning branch FAILS the whole run with NO actions
 *     executed (pre-flight) — a partially-executed workflow is worse than a
 *     failed one.
 *   - Field-mapping sources: full parity — static, trigger_field, current_date,
 *     current_user, record_id, date_expression, formula (the SAME formulaEngine
 *     the client uses), role_variable (deterministic, see below).
 *
 * Idempotency (protects BUSINESS EFFECTS, not just runs):
 *   - Per-workflow TRANSITION key over the workflow's full dependency-field set
 *     + a config hash. completed/skipped ⇒ skip; processing|failed SAME job ⇒
 *     reuse run_id; failed OTHER job ⇒ not revived.
 *   - Action-level create dedup via workflow_action_emit_reserve (reserve BEFORE
 *     create; one winner under race), filled after the create succeeds.
 *
 * role_variable: deterministic. workload_strategy = "total_assigned_records"
 * (count of records in the mapping's target model whose assignee field = the
 * candidate). NOT active-workload — there is no status filter; named honestly.
 * Selection: least_workload → min, tie-break user_id asc; first_match → user_id
 * asc. The candidate set + per-candidate workload + the pick are written to the
 * action trace so an assignment is always explainable.
 *
 * Recursion: all record writes go through record_save_workflow(depth+1, origin,
 * parent) so the capture trigger stamps lineage and the depth cap holds.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AppModel, AppRecord, User, Workflow, WorkflowBranch, WorkflowAction,
  WorkflowActionCreateRecord, WorkflowActionUpdateRecord, FieldMapping,
  WorkflowConditionTrace, WorkflowBranchTrace,
} from '../../src/types/index.js';
import {
  applyDateExpression, evaluateCondition, formatDateForField, getWorkflowBranches,
  roleVariableCandidates, pickRoleVariableUser,
} from '../../src/lib/workflowEngineCore.js';
import { evaluateFormula } from '../../src/lib/formulaEngine.js';

export const SUPPORTED_ACTION_TYPES = new Set<WorkflowAction['type']>(['create_record', 'update_record']);

/** The DB-authoritative captured event. Source of truth is the workflow_jobs row. */
export interface CapturedJob {
  job_id: string;
  model_id: string;
  record_id: string;
  trigger_event: 'create' | 'update' | 'delete';
  previous_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_fields: string[];
  actor_user_id: string | null;
  depth: number;
}

export interface RunnerWorkflowResult {
  workflow_id: string;
  workflow_label: string;
  run_id: string | null;
  status: 'success' | 'partial_success' | 'failed' | 'skipped';
  reason?: string;
}

export interface RunnerResult {
  job_id: string;
  eligible: number;
  results: RunnerWorkflowResult[];
}

/* ── hashing / config fingerprint ─────────────────────────────────────── */

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Deterministic JSON (sorted keys) so a config / value fingerprint is stable. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

function workflowConfigHash(w: Workflow): string {
  return sha(stableStringify({
    trigger_event: w.trigger_event,
    trigger_model_id: w.trigger_model_id,
    trigger_webhook_slug_id: w.trigger_webhook_slug_id ?? null,
    branches: w.branches ?? null,
    conditions: w.conditions ?? null,
    actions: w.actions ?? null,
  }));
}

/* ── dependency fields (drives the transition key) ────────────────────── */

function formulaTokens(expr: string): string[] {
  const out: string[] = [];
  const re = /\{([a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.push(m[1]!);
  return out;
}

/**
 * EVERY trigger-record field the workflow reads — conditions, branch
 * conditions, only_on_change, formula tokens, action source mappings, date
 * bases, role_variable conditions, update filter. NOT just condition fields, so
 * an action-driving field that changes between two otherwise-identical
 * condition transitions yields a DIFFERENT key (no false skip).
 */
function collectDependencyFields(w: Workflow): string[] {
  const s = new Set<string>();
  const addConds = (conds?: { field_id: string }[]) => conds?.forEach((c) => { if (c.field_id) s.add(c.field_id); });
  const addActions = (actions?: WorkflowAction[]) => actions?.forEach((a) => {
    if (a.type === 'update_record' && a.filter_trigger_field_id) s.add(a.filter_trigger_field_id);
    if (a.type === 'create_record' || a.type === 'update_record') {
      for (const fm of a.field_mappings ?? []) {
        if (fm.trigger_field_id) s.add(fm.trigger_field_id);
        if (fm.date_base_field_id) s.add(fm.date_base_field_id);
        if (fm.formula_expression) for (const t of formulaTokens(fm.formula_expression)) s.add(t);
        for (const rc of fm.role_conditions ?? []) if (rc.trigger_field_id) s.add(rc.trigger_field_id);
      }
    }
  });
  for (const b of getWorkflowBranches(w)) { addConds(b.conditions); addActions(b.actions); }
  addConds(w.conditions);
  addActions(w.actions);
  return [...s].sort();
}

function transitionKey(w: Workflow, configHash: string, job: CapturedJob, depFields: string[]): string {
  const prev = job.previous_data ?? {};
  const next = job.new_data ?? {};
  return sha([
    w.id, configHash, job.model_id, job.record_id, job.trigger_event,
    [...job.changed_fields].sort().join(','),
    depFields.map((f) => f + '=' + stableStringify(prev[f])).join('|'),
    depFields.map((f) => f + '=' + stableStringify(next[f])).join('|'),
  ].join('::'));
}

/* ── field-type lookup ────────────────────────────────────────────────── */

function fieldType(models: AppModel[], modelId: string, fieldName: string): string | undefined {
  const m = models.find((x) => x.id === modelId);
  for (const sec of m?.schema.sections ?? []) for (const f of sec.fields) if (f.name === fieldName) return f.type;
  return undefined;
}

/* ── role_variable workload (total assigned records) ──────────────────── */

async function totalAssignedWorkload(
  supabase: SupabaseClient, targetModelId: string, assigneeField: string, userId: string,
): Promise<number> {
  // Reads through unified_records so frozen + unfrozen models both count.
  const { count, error } = await supabase
    .from('unified_records')
    .select('id', { count: 'exact', head: true })
    .eq('model_id', targetModelId)
    .eq(`data->>${assigneeField}`, userId);
  if (error) throw new Error(`workload count failed: ${error.message}`);
  return count ?? 0;
}

/* ── mapping resolution (full source parity) ──────────────────────────── */

interface ResolveCtx {
  supabase: SupabaseClient;
  models: AppModel[];
  users: User[];
  triggerData: Record<string, unknown>;
  recordId: string;
  actorUserId: string | null;
  targetModelId: string;       // the action's target model
  roleVarDebug: unknown[];     // collected per-run for the action trace
}

async function resolveMapping(mapping: FieldMapping, ctx: ResolveCtx): Promise<unknown> {
  const targetType = fieldType(ctx.models, ctx.targetModelId, mapping.target_field_id);
  switch (mapping.source_type) {
    case 'static':
      return mapping.static_value ?? null;
    case 'trigger_field':
      return mapping.trigger_field_id ? (ctx.triggerData[mapping.trigger_field_id] ?? null) : null;
    case 'current_date':
      return formatDateForField(new Date(), targetType);
    case 'current_user':
      // DB-authoritative actor; null for system/cron/webhook writes. Never fabricated.
      return ctx.actorUserId ?? null;
    case 'record_id':
      return ctx.recordId;
    case 'date_expression': {
      const baseVal = mapping.date_base === 'trigger_field' && mapping.date_base_field_id
        ? ctx.triggerData[mapping.date_base_field_id]
        : new Date();
      const baseDate = baseVal instanceof Date ? baseVal : new Date(String(baseVal ?? ''));
      if (isNaN(baseDate.getTime())) return null;
      return formatDateForField(applyDateExpression(baseDate, mapping.date_expression ?? ''), targetType);
    }
    case 'formula': {
      const expr = mapping.formula_expression?.trim();
      if (!expr) return null;
      const raw = evaluateFormula(expr, ctx.triggerData);
      if (typeof raw === 'string' && ['#ERR', '#DIV0', '#REF', '#CYCLE'].includes(raw)) return null;
      if ((targetType === 'number' || targetType === 'currency') && typeof raw === 'string') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      return raw;
    }
    case 'current_user' as never:
      return ctx.actorUserId ?? null;
    case 'role_variable': {
      const candidates = roleVariableCandidates(mapping, ctx.triggerData, ctx.users);
      const assigneeField = mapping.target_field_id;
      const loads = new Map<string, number>();
      for (const c of candidates) {
        loads.set(c.id, await totalAssignedWorkload(ctx.supabase, ctx.targetModelId, assigneeField, c.id));
      }
      const selected = pickRoleVariableUser(candidates, mapping.selection_strategy, (id) => loads.get(id) ?? 0);
      ctx.roleVarDebug.push({
        role_variable: assigneeField,
        strategy: mapping.selection_strategy ?? 'first_match',
        workload_strategy: 'total_assigned_records',
        target_model_id: ctx.targetModelId,
        assignment_field: assigneeField,
        candidates: candidates
          .map((c) => ({ user_id: c.id, workload: loads.get(c.id) ?? 0, matched_conditions: true }))
          .sort((a, b) => a.user_id.localeCompare(b.user_id)),
        selected_user_id: selected?.id ?? null,
        tie_break: 'user_id_asc',
      });
      return selected?.id ?? null;
    }
    default:
      return null;
  }
}

/* ── record loads ─────────────────────────────────────────────────────── */

async function loadRecordsForModel(supabase: SupabaseClient, modelId: string): Promise<AppRecord[]> {
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, model_id, data, created_by_user_id, created_at, updated_at')
    .eq('model_id', modelId);
  if (error) throw new Error(`load records (${modelId}) failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    model_id: r.model_id as string,
    data: (r.data as Record<string, unknown>) ?? {},
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    created_by_user_id: (r.created_by_user_id as string | null) ?? undefined,
  }));
}

/* ── action execution ─────────────────────────────────────────────────── */

interface ActionResult {
  action_id: string;
  type: WorkflowAction['type'];
  status: 'executed' | 'skipped' | 'failed';
  reason?: string;
  detail?: Record<string, unknown>;
}

async function execCreate(
  action: WorkflowActionCreateRecord, job: CapturedJob, runId: string, workflowId: string, ctx: ResolveCtx,
): Promise<ActionResult> {
  const data: Record<string, unknown> = {};
  for (const m of action.field_mappings) data[m.target_field_id] = await resolveMapping(m, { ...ctx, targetModelId: action.target_model_id });

  // skip_if_exists — business-intended "don't duplicate" against EXISTING records.
  // This is a legitimate skip (not an unsupported-action skip): the run stays
  // healthy. Distinct from the emission-based retry dedup below.
  if (action.skip_if_exists && action.dedup_target_field_id) {
    const existing = await loadRecordsForModel(ctx.supabase, action.target_model_id);
    const dup = existing.find((r) => r.data[action.dedup_target_field_id!] === data[action.dedup_target_field_id!]);
    if (dup) return { action_id: action.id, type: 'create_record', status: 'skipped', reason: 'duplicate_exists', detail: { matched_record_id: dup.id } };
  }

  const businessKey = action.skip_if_exists && action.dedup_target_field_id
    ? String(data[action.dedup_target_field_id] ?? '')
    : null;

  // Reserve BEFORE create — one winner under race across both unique indexes.
  const { data: resRows, error: resErr } = await ctx.supabase.rpc('workflow_action_emit_reserve', {
    p_workflow_run_id: runId, p_workflow_id: workflowId, p_workflow_job_id: job.job_id,
    p_action_id: action.id, p_source_record_id: job.record_id,
    p_target_model_id: action.target_model_id, p_business_key: businessKey,
  });
  if (resErr) return { action_id: action.id, type: 'create_record', status: 'failed', reason: 'emit_reserve_error', detail: { message: resErr.message } };
  const res = (resRows as Array<{ emission_id: string; created_record_id: string | null; is_new: boolean; deduped_by: string | null }>)[0]!;

  if (!res.is_new) {
    // Dedup hit — reuse, never create a second record.
    return { action_id: action.id, type: 'create_record', status: 'skipped', reason: `deduped:${res.deduped_by}`, detail: { created_record_id: res.created_record_id } };
  }

  const newId = randomUUID();
  const { error: saveErr } = await ctx.supabase.rpc('record_save_workflow', {
    p_model_id: action.target_model_id, p_id: newId, p_data: data,
    p_created_by: ctx.actorUserId, p_expected_version: null,
    p_depth: job.depth + 1, p_origin_run: runId, p_parent_job: job.job_id,
  });
  if (saveErr) return { action_id: action.id, type: 'create_record', status: 'failed', reason: 'record_save_error', detail: { message: saveErr.message } };
  await ctx.supabase.rpc('workflow_action_emit_fill', { p_emission_id: res.emission_id, p_created_record_id: newId });
  return { action_id: action.id, type: 'create_record', status: 'executed', detail: { created_record_id: newId, business_key: businessKey } };
}

async function execUpdate(
  action: WorkflowActionUpdateRecord, job: CapturedJob, runId: string, ctx: ResolveCtx,
): Promise<ActionResult> {
  const src = action.filter_value_source ?? 'static';
  const filterValue = src === 'trigger_field' && action.filter_trigger_field_id
    ? ctx.triggerData[action.filter_trigger_field_id]
    : action.filter_value;

  const targets = await loadRecordsForModel(ctx.supabase, action.target_model_id);
  let target: AppRecord | undefined;
  // Lookup-aware: a single lookup trigger field pointing at the target model
  // stores the target's id.
  if (src === 'trigger_field' && action.filter_trigger_field_id && typeof filterValue === 'string') {
    const tf = fieldType(ctx.models, job.model_id, action.filter_trigger_field_id);
    if (tf === 'lookup') target = targets.find((r) => r.id === filterValue);
  }
  if (!target && action.filter_field_id === 'id' && typeof filterValue === 'string') target = targets.find((r) => r.id === filterValue);
  if (!target) target = targets.find((r) => r.data[action.filter_field_id] === filterValue);
  if (!target) return { action_id: action.id, type: 'update_record', status: 'skipped', reason: 'no_matching_record' };

  const merged = { ...target.data };
  for (const m of action.field_mappings) merged[m.target_field_id] = await resolveMapping(m, { ...ctx, targetModelId: action.target_model_id });

  // Version-UNAWARE (expected_version null): system writes must not lose to a
  // trigger-bumped version (see memory: workflow client write version race).
  const { error } = await ctx.supabase.rpc('record_save_workflow', {
    p_model_id: action.target_model_id, p_id: target.id, p_data: merged,
    p_created_by: target.created_by_user_id ?? null, p_expected_version: null,
    p_depth: job.depth + 1, p_origin_run: runId, p_parent_job: job.job_id,
  });
  if (error) return { action_id: action.id, type: 'update_record', status: 'failed', reason: 'record_save_error', detail: { message: error.message } };
  return { action_id: action.id, type: 'update_record', status: 'executed', detail: { matched_record_id: target.id } };
}

/* ── branch evaluation (before-image only_on_change) ──────────────────── */

function evaluateBranches(w: Workflow, triggerData: Record<string, unknown>, prevData: Record<string, unknown> | null, event: string) {
  const branches = getWorkflowBranches(w);
  const branchesTrace: WorkflowBranchTrace[] = [];
  let winner: WorkflowBranch | null = null;
  for (const branch of branches) {
    if (winner) { branchesTrace.push({ branch_id: branch.id, branch_label_ar: branch.label_ar, branch_label_en: branch.label_en, is_else: branch.is_else ?? false, conditions_trace: [], conditions_passed: false, evaluated: false, was_selected: false }); continue; }
    if (branch.is_else) { winner = branch; branchesTrace.push({ branch_id: branch.id, branch_label_ar: branch.label_ar, branch_label_en: branch.label_en, is_else: true, conditions_trace: [], conditions_passed: true, evaluated: true, was_selected: true }); continue; }
    const condTraces: WorkflowConditionTrace[] = branch.conditions.map((c) => {
      const passesNow = evaluateCondition(c, triggerData);
      const passedBefore = (c.only_on_change && event === 'update' && prevData) ? evaluateCondition(c, prevData) : undefined;
      const result = !c.only_on_change ? passesNow : (event !== 'update' || !prevData) ? passesNow : (passesNow && !passedBefore);
      return { id: c.id, field_id: c.field_id, operator: c.operator, expected_value: c.value, actual_value: triggerData[c.field_id], only_on_change: !!c.only_on_change, passes_now: passesNow, passed_before: passedBefore, result };
    });
    const mode = branch.condition_mode ?? 'all';
    const passed = condTraces.length === 0 ? true : (mode === 'any' ? condTraces.some((t) => t.result) : condTraces.every((t) => t.result));
    if (passed) winner = branch;
    branchesTrace.push({ branch_id: branch.id, branch_label_ar: branch.label_ar, branch_label_en: branch.label_en, is_else: false, conditions_trace: condTraces, conditions_passed: passed, evaluated: true, was_selected: passed });
  }
  return { winner, branchesTrace };
}

/* ── the runner ───────────────────────────────────────────────────────── */

export async function runWorkflowJob(supabase: SupabaseClient, job: CapturedJob): Promise<RunnerResult> {
  // Eligible = active workflows for this model + event.
  const { data: wfRows, error: wfErr } = await supabase
    .from('workflows').select('*').eq('is_active', true)
    .eq('trigger_model_id', job.model_id).eq('trigger_event', job.trigger_event);
  if (wfErr) throw new Error(`load workflows failed: ${wfErr.message}`);
  const workflows = (wfRows ?? []) as unknown as Workflow[];

  const results: RunnerWorkflowResult[] = [];
  if (workflows.length === 0) return { job_id: job.job_id, eligible: 0, results };

  // Shared lookups loaded once.
  const { data: modelRows, error: mErr } = await supabase.from('models').select('*');
  if (mErr) throw new Error(`load models failed: ${mErr.message}`);
  const models = (modelRows ?? []) as unknown as AppModel[];
  const { data: userRows, error: uErr } = await supabase
    .from('users').select('id, name_ar, name_en, email, profile_id, role_assignments, is_active, auth_uid');
  if (uErr) throw new Error(`load users failed: ${uErr.message}`);
  const users = (userRows ?? []) as unknown as User[];

  const triggerData = job.new_data ?? job.previous_data ?? {};
  const triggerModel = models.find((m) => m.id === job.model_id);

  for (const w of workflows) {
    const configHash = workflowConfigHash(w);
    const depFields = collectDependencyFields(w);
    const key = transitionKey(w, configHash, job, depFields);

    // ── idempotency: skip / reuse / new ──────────────────────────────
    const { data: priorRows } = await supabase
      .from('workflow_runs').select('id, status, workflow_job_id')
      .eq('workflow_id', w.id).eq('idempotency_key', key)
      .order('started_at', { ascending: false }).limit(1);
    const prior = (priorRows ?? [])[0] as { id: string; status: string; workflow_job_id: string | null } | undefined;

    let runId: string;
    if (prior && (prior.status === 'success' || prior.status === 'partial_success' || prior.status === 'skipped')) {
      results.push({ workflow_id: w.id, workflow_label: w.label_en || w.label_ar, run_id: prior.id, status: 'skipped', reason: 'idempotent:already_done' });
      continue;
    } else if (prior && (prior.status === 'processing' || prior.status === 'failed') && prior.workflow_job_id === job.job_id) {
      runId = prior.id; // same-job retry → reuse the run row.
    } else if (prior && (prior.status === 'processing' || prior.status === 'failed')) {
      // Non-terminal run from ANOTHER job — do not casually revive.
      results.push({ workflow_id: w.id, workflow_label: w.label_en || w.label_ar, run_id: prior.id, status: 'skipped', reason: `idempotent:non_terminal_other_job:${prior.status}` });
      continue;
    } else {
      runId = randomUUID();
    }

    const startedAt = new Date();
    const { winner, branchesTrace } = evaluateBranches(w, triggerData, job.previous_data, job.trigger_event);
    const winningTrace = branchesTrace.find((b) => b.was_selected);

    const baseRow = {
      id: runId, workflow_id: w.id, workflow_label_ar: w.label_ar, workflow_label_en: w.label_en,
      trigger_event: job.trigger_event, trigger_model_id: job.model_id,
      trigger_model_label_ar: triggerModel?.label_ar, trigger_model_label_en: triggerModel?.label_en,
      trigger_record_id: job.record_id, trigger_record_snapshot: triggerData,
      previous_record_snapshot: job.previous_data ?? undefined,
      triggered_by_user_id: job.actor_user_id, depth: job.depth,
      started_at: startedAt.toISOString(), branches_trace: branchesTrace.length > 1 ? branchesTrace : undefined,
      conditions_trace: winningTrace?.conditions_trace ?? [], idempotency_key: key,
      workflow_config_hash: configHash, workflow_job_id: job.job_id,
    };

    if (!winner) {
      await supabase.from('workflow_runs').upsert({ ...baseRow, status: 'skipped', conditions_passed: false, actions_trace: [], finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt.getTime(), selected_branch_id: undefined });
      results.push({ workflow_id: w.id, workflow_label: w.label_en || w.label_ar, run_id: runId, status: 'skipped', reason: 'no_branch_matched' });
      continue;
    }

    // ── PRE-FLIGHT: any unsupported action ⇒ fail the whole run, run NOTHING.
    const unsupported = winner.actions.find((a) => !SUPPORTED_ACTION_TYPES.has(a.type));
    if (unsupported) {
      const reason = `unsupported_in_runner_v1:${unsupported.type}`;
      await supabase.from('workflow_runs').upsert({
        ...baseRow, status: 'failed', conditions_passed: true,
        actions_trace: [{ id: unsupported.id, order: 0, status: 'failed', skip_reason: reason, type: unsupported.type, error: `Action type "${unsupported.type}" is not supported by the server runner v1 — the workflow cannot be faithfully executed server-side. NOT partially executed.` }],
        selected_branch_id: winner.id, finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt.getTime(),
        error: reason,
      });
      results.push({ workflow_id: w.id, workflow_label: w.label_en || w.label_ar, run_id: runId, status: 'failed', reason });
      continue;
    }

    // Insert the run as processing BEFORE executing any action.
    await supabase.from('workflow_runs').upsert({ ...baseRow, status: 'processing', conditions_passed: true, actions_trace: [], selected_branch_id: winner.id });

    const roleVarDebug: unknown[] = [];
    const ctx: ResolveCtx = { supabase, models, users, triggerData, recordId: job.record_id, actorUserId: job.actor_user_id, targetModelId: '', roleVarDebug };
    const actionsTrace: ActionResult[] = [];
    let anyFailed = false, anyExecuted = false, topErr: string | undefined;
    try {
      for (const action of winner.actions) {
        const r = action.type === 'create_record'
          ? await execCreate(action as WorkflowActionCreateRecord, job, runId, w.id, ctx)
          : await execUpdate(action as WorkflowActionUpdateRecord, job, runId, ctx);
        actionsTrace.push(r);
        if (r.status === 'failed') anyFailed = true;
        if (r.status === 'executed') anyExecuted = true;
      }
    } catch (err) { anyFailed = true; topErr = err instanceof Error ? err.message : String(err); }

    const status = topErr ? 'failed' : anyFailed ? (anyExecuted ? 'partial_success' : 'failed') : 'success';
    await supabase.from('workflow_runs').upsert({
      ...baseRow, status, conditions_passed: true, selected_branch_id: winner.id,
      actions_trace: roleVarDebug.length ? [...actionsTrace, { id: '__role_variable_debug__', order: 999, status: 'executed', type: 'update_record', role_variable_debug: roleVarDebug }] : actionsTrace,
      finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt.getTime(), error: topErr,
    });
    results.push({ workflow_id: w.id, workflow_label: w.label_en || w.label_ar, run_id: runId, status });
  }

  return { job_id: job.job_id, eligible: workflows.length, results };
}
