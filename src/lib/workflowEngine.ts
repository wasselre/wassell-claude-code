import type {
  AppRecord,
  Workflow,
  WorkflowBranch,
  WorkflowCondition,
  FieldMapping,
  WorkflowAction,
  WorkflowActionOutboundIvr,
  WorkflowActionSendWhatsAppMessage,
  OutboundIvrDestination,
  AppModel,
  User,
  Role,
  WorkflowRun,
  WorkflowConditionTrace,
  WorkflowActionTrace,
  WorkflowBranchTrace,
  FieldMappingTrace,
} from '@/types';
import { evaluateFormula } from './formulaEngine';
import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import { normalizePhone } from '@/lib/phone';
import { useAppStore } from '@/stores/appStore';

/**
 * Resolve an outbound_ivr action's destination to a normalized E.164 phone.
 * Returns null when the source can't be resolved (missing record, empty field,
 * bad phone format) — callers return `skipped: no_destination_number`.
 *
 * `prevActionOutputs` is a map of prior-action-id → AppRecord the engine
 * populates as it runs each action. Only `create_record` actions currently
 * contribute to this map.
 */
export function resolveIvrDestination(
  dest: OutboundIvrDestination,
  triggerRecord: AppRecord,
  prevActionOutputs: Record<string, AppRecord>,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): { number: string | null; description: string } {
  switch (dest.kind) {
    case 'trigger_field': {
      const raw = triggerRecord.data[dest.field_name];
      const num = typeof raw === 'string' ? normalizePhone(raw) : null;
      return { number: num, description: `trigger.${dest.field_name}` };
    }
    case 'static': {
      return {
        number: normalizePhone(dest.phone),
        description: `static: ${dest.phone}`,
      };
    }
    case 'lookup': {
      const lookupValue = triggerRecord.data[dest.lookup_field_name];
      const targetId = Array.isArray(lookupValue) ? lookupValue[0] : lookupValue;
      if (typeof targetId !== 'string' || !targetId) {
        return { number: null, description: `lookup(trigger.${dest.lookup_field_name}) empty` };
      }
      const triggerModel = allModels.find((m) => m.id === triggerRecord.model_id);
      const lookupField = triggerModel?.schema.sections
        .flatMap((s) => s.fields)
        .find((f) => f.name === dest.lookup_field_name);
      if (!lookupField?.lookup_model_id) {
        return { number: null, description: `lookup field not found: ${dest.lookup_field_name}` };
      }
      const targetRecord = (allRecords[lookupField.lookup_model_id] ?? []).find((r) => r.id === targetId);
      if (!targetRecord) {
        return { number: null, description: `lookup target record ${targetId} not found` };
      }
      const raw = targetRecord.data[dest.target_phone_field_name];
      const num = typeof raw === 'string' ? normalizePhone(raw) : null;
      return { number: num, description: `lookup(${dest.lookup_field_name}).${dest.target_phone_field_name}` };
    }
    case 'prev_action_output': {
      const rec = prevActionOutputs[dest.action_id];
      if (!rec) {
        return { number: null, description: `prev action ${dest.action_id} produced no record` };
      }
      const raw = rec.data[dest.phone_field_name];
      const num = typeof raw === 'string' ? normalizePhone(raw) : null;
      return { number: num, description: `action(${dest.action_id}).${dest.phone_field_name}` };
    }
  }
}

/**
 * Normalize the outbound_ivr action's destination. Old actions stored
 * `to_field_id`; new actions store `to`. This helper returns the new shape
 * regardless, so callers don't branch on storage format.
 */
export function getIvrDestination(action: WorkflowActionOutboundIvr): OutboundIvrDestination {
  if (action.to) return action.to;
  return { kind: 'trigger_field', field_name: action.to_field_id ?? '' };
}

/**
 * Same legacy-bridge as getIvrDestination but for send_whatsapp_message.
 * The action was originally shipped with a bare `to_field_id`; the v2
 * editor writes a full `to` destination. Read both so already-saved
 * workflows keep firing.
 */
export function getWhatsAppMessageDestination(action: WorkflowActionSendWhatsAppMessage): OutboundIvrDestination {
  if (action.to) return action.to;
  return { kind: 'trigger_field', field_name: action.to_field_id ?? '' };
}

// Normalize a workflow into its branch list. Workflows saved by the branched
// editor always carry `branches`. Older saves are wrapped into a single
// implicit branch so the engine has one code path.
export function getWorkflowBranches(workflow: Workflow): WorkflowBranch[] {
  if (workflow.branches && workflow.branches.length > 0) return workflow.branches;
  return [{
    id: `${workflow.id}__legacy`,
    conditions: workflow.conditions ?? [],
    actions: workflow.actions ?? [],
  }];
}

const MAX_DEPTH = 3;

// Replace `{field_slug}` tokens in a template string with the trigger
// record's values. Missing fields substitute to an empty string. Used by the
// `http_request` action for URL, headers, and JSON body templating.
function substituteFieldTokens(template: string, triggerRecord: AppRecord): string {
  return template.replace(/\{([a-zA-Z_][\w]*)\}/g, (_, slug) => {
    const value = triggerRecord.data[slug];
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

function getFieldTypeMap(allModels: AppModel[], modelId: string): Map<string, string> {
  const model = allModels.find((m) => m.id === modelId);
  const map = new Map<string, string>();
  for (const section of model?.schema.sections ?? []) {
    for (const field of section.fields) map.set(field.name, field.type);
  }
  return map;
}

function getFieldLabel(allModels: AppModel[], modelId: string, slug: string): string | undefined {
  const model = allModels.find((m) => m.id === modelId);
  for (const s of model?.schema.sections ?? []) {
    for (const f of s.fields) {
      if (f.name === slug) return f.label_en;
    }
  }
  return undefined;
}

// Format a Date for storage in a record field so that the HTML form inputs will re-hydrate it.
// `<input type="date">` expects `YYYY-MM-DD` and `<input type="datetime-local">` expects
// `YYYY-MM-DDTHH:MM` in local time. A raw ISO string with a `Z` suffix is silently rejected
// by the browser even though the table view (which goes through `new Date(...)`) still displays it.
export function formatDateForField(date: Date, fieldType: string | undefined): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  if (fieldType === 'date') return `${y}-${mo}-${d}`;
  if (fieldType === 'datetime') {
    const hh = pad(date.getHours());
    const mi = pad(date.getMinutes());
    return `${y}-${mo}-${d}T${hh}:${mi}`;
  }
  return date.toISOString();
}

// Parse a date-offset expression like "+5d -2w +3mo +1y +2h -30min" and apply it to `base`.
export function applyDateExpression(base: Date, expression: string): Date {
  const result = new Date(base.getTime());
  const tokens = expression.match(/[+-]\s*\d+\s*(?:mo|min|d|w|y|h)/gi) ?? [];
  for (const raw of tokens) {
    const m = raw.replace(/\s+/g, '').match(/^([+-]\d+)(mo|min|d|w|y|h)$/i);
    if (!m) continue;
    const amount = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    switch (unit) {
      case 'd':   result.setDate(result.getDate() + amount); break;
      case 'w':   result.setDate(result.getDate() + amount * 7); break;
      case 'mo':  result.setMonth(result.getMonth() + amount); break;
      case 'y':   result.setFullYear(result.getFullYear() + amount); break;
      case 'h':   result.setHours(result.getHours() + amount); break;
      case 'min': result.setMinutes(result.getMinutes() + amount); break;
    }
  }
  return result;
}

export async function executeWorkflows(
  event: 'create' | 'update' | 'delete',
  triggerRecord: AppRecord,
  previousRecord: AppRecord | undefined,
  allWorkflows: Workflow[],
  allModels: AppModel[],
  allRecords: Record<string, AppRecord[]>,
  allUsers: User[],
  allRoles: Role[],
  saveRecord: (record: AppRecord) => void,
  showToast: (message: string) => void,
  currentUserId?: string | null,
  depth = 0,
  logRun?: (run: WorkflowRun) => void,
): Promise<void> {
  if (depth >= MAX_DEPTH) return;

  const matching = allWorkflows.filter(
    (w) =>
      w.is_active &&
      w.trigger_model_id === triggerRecord.model_id &&
      w.trigger_event === event,
  );

  const triggerModel = allModels.find((m) => m.id === triggerRecord.model_id);

  for (const workflow of matching) {
    const startedAt = new Date();
    const branches = getWorkflowBranches(workflow);

    // Evaluate each branch in order. First non-else branch whose conditions
    // all pass wins. If none match, the trailing else branch wins (if any).
    const branchesTrace: WorkflowBranchTrace[] = [];
    let winner: WorkflowBranch | undefined;

    for (const branch of branches) {
      // Branch already decided — log as un-evaluated but keep it in the trace
      // so the log UI can show the full tree.
      if (winner) {
        branchesTrace.push({
          branch_id: branch.id,
          branch_label_ar: branch.label_ar,
          branch_label_en: branch.label_en,
          is_else: !!branch.is_else,
          conditions_trace: [],
          conditions_passed: false,
          evaluated: false,
          was_selected: false,
        });
        continue;
      }

      if (branch.is_else) {
        // Else branches only win when nothing preceding matched. We've
        // already checked `winner` above, so reaching here means we're about
        // to pick it.
        winner = branch;
        branchesTrace.push({
          branch_id: branch.id,
          branch_label_ar: branch.label_ar,
          branch_label_en: branch.label_en,
          is_else: true,
          conditions_trace: [],
          conditions_passed: true,
          evaluated: true,
          was_selected: true,
        });
        continue;
      }

      const conditionsTrace: WorkflowConditionTrace[] = [];
      const conditionsPassed = branch.conditions.every((c) => {
        const passesNow = evaluateCondition(c, triggerRecord.data);
        const passedBefore = (c.only_on_change && event === 'update' && previousRecord)
          ? evaluateCondition(c, previousRecord.data)
          : undefined;
        const result = !c.only_on_change
          ? passesNow
          : (event !== 'update' || !previousRecord) ? passesNow : (passesNow && !passedBefore);
        conditionsTrace.push({
          id: c.id,
          field_id: c.field_id,
          operator: c.operator,
          expected_value: c.value,
          actual_value: triggerRecord.data[c.field_id],
          only_on_change: !!c.only_on_change,
          passes_now: passesNow,
          passed_before: passedBefore,
          result,
        });
        return result;
      });

      if (conditionsPassed) winner = branch;

      branchesTrace.push({
        branch_id: branch.id,
        branch_label_ar: branch.label_ar,
        branch_label_en: branch.label_en,
        is_else: false,
        conditions_trace: conditionsTrace,
        conditions_passed: conditionsPassed,
        evaluated: true,
        was_selected: conditionsPassed,
      });
    }

    // Pick a representative trace for the legacy fields (first evaluated
    // branch if nobody won — that's the closest thing to "why did this skip").
    const winningTrace = branchesTrace.find((b) => b.was_selected);
    const representativeTrace = winningTrace ?? branchesTrace.find((b) => b.evaluated);

    if (!winner) {
      const finishedAt = new Date();
      logRun?.({
        id: uuid(),
        workflow_id: workflow.id,
        workflow_label_ar: workflow.label_ar,
        workflow_label_en: workflow.label_en,
        trigger_event: event,
        trigger_model_id: triggerRecord.model_id,
        trigger_model_label_ar: triggerModel?.label_ar,
        trigger_model_label_en: triggerModel?.label_en,
        trigger_record_id: triggerRecord.id,
        trigger_record_snapshot: { ...triggerRecord.data },
        previous_record_snapshot: previousRecord ? { ...previousRecord.data } : undefined,
        triggered_by_user_id: currentUserId ?? null,
        depth,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        status: 'skipped',
        conditions_trace: representativeTrace?.conditions_trace ?? [],
        conditions_passed: false,
        actions_trace: [],
        branches_trace: branchesTrace,
        selected_branch_id: undefined,
      });
      continue;
    }

    const actionsTrace: WorkflowActionTrace[] = [];
    let anyFailed = false;
    let anyExecuted = false;
    let topLevelError: string | undefined;
    // Map of action_id -> the AppRecord that action created. Populated as we
    // go so `outbound_ivr` and future actions can resolve `prev_action_output`
    // destinations against real records.
    const prevActionOutputs: Record<string, AppRecord> = {};

    try {
      for (let i = 0; i < winner.actions.length; i++) {
        const action = winner.actions[i]!;
        const trace = await executeAction(
          action,
          i,
          triggerRecord,
          allModels,
          allRecords,
          allUsers,
          allRoles,
          saveRecord,
          showToast,
          currentUserId,
          prevActionOutputs,
        );
        actionsTrace.push(trace);
        if (trace.status === 'failed') anyFailed = true;
        if (trace.status === 'executed') anyExecuted = true;
      }
    } catch (err) {
      anyFailed = true;
      topLevelError = err instanceof Error ? err.message : String(err);
    }

    const finishedAt = new Date();
    const status: WorkflowRun['status'] = topLevelError
      ? 'failed'
      : anyFailed
        ? (anyExecuted ? 'partial_success' : 'failed')
        : 'success';

    logRun?.({
      id: uuid(),
      workflow_id: workflow.id,
      workflow_label_ar: workflow.label_ar,
      workflow_label_en: workflow.label_en,
      trigger_event: event,
      trigger_model_id: triggerRecord.model_id,
      trigger_model_label_ar: triggerModel?.label_ar,
      trigger_model_label_en: triggerModel?.label_en,
      trigger_record_id: triggerRecord.id,
      trigger_record_snapshot: { ...triggerRecord.data },
      previous_record_snapshot: previousRecord ? { ...previousRecord.data } : undefined,
      triggered_by_user_id: currentUserId ?? null,
      depth,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      status,
      conditions_trace: winningTrace?.conditions_trace ?? [],
      conditions_passed: true,
      actions_trace: actionsTrace,
      branches_trace: branchesTrace,
      selected_branch_id: winner.id,
      error: topLevelError,
    });
  }
}

// Run a pre-filtered list of webhook-triggered workflows against a synthetic
// trigger record built from a webhook_payloads row. The engine treats the
// payload JSON as the trigger record's `data`, so conditions and field
// mappings reference payload fields via the existing `trigger_field` source.
export async function executeWebhookWorkflows(
  workflows: Workflow[],
  triggerRecord: AppRecord,
  allModels: AppModel[],
  allRecords: Record<string, AppRecord[]>,
  allUsers: User[],
  _allRoles: Role[],
  saveRecord: (record: AppRecord) => void,
  showToast: (message: string) => void,
  currentUserId?: string | null,
): Promise<void> {
  for (const workflow of workflows) {
    const branches = getWorkflowBranches(workflow);
    let winner: WorkflowBranch | undefined;

    for (const branch of branches) {
      if (winner) continue;
      if (branch.is_else) { winner = branch; continue; }
      const ok = branch.conditions.every((c) => evaluateCondition(c, triggerRecord.data));
      if (ok) winner = branch;
    }
    if (!winner) continue;

    const webhookPrevOutputs: Record<string, AppRecord> = {};
    for (let i = 0; i < winner.actions.length; i++) {
      try {
        await executeAction(
          winner.actions[i]!,
          i,
          triggerRecord,
          allModels,
          allRecords,
          allUsers,
          _allRoles,
          saveRecord,
          showToast,
          currentUserId,
          webhookPrevOutputs,
        );
      } catch (err) {
        console.error('[executeWebhookWorkflows] action failed:', err);
      }
    }
  }
}

function evaluateCondition(
  condition: WorkflowCondition,
  data: Record<string, unknown>,
): boolean {
  const value = data[condition.field_id];
  const target = condition.value;

  switch (condition.operator) {
    case 'equals':
      if (Array.isArray(value) && Array.isArray(target)) {
        return value.length === target.length && value.every((v) => target.includes(v));
      }
      return value == target;
    case 'not_equals':
      if (Array.isArray(value) && Array.isArray(target)) {
        return !(value.length === target.length && value.every((v) => target.includes(v)));
      }
      return value != target;
    case 'contains':
      if (Array.isArray(value) && Array.isArray(target)) {
        return (target as unknown[]).some((v) => (value as unknown[]).includes(v));
      }
      if (Array.isArray(value)) {
        return (value as unknown[]).includes(target);
      }
      if (Array.isArray(target)) {
        return (target as unknown[]).includes(value);
      }
      return String(value ?? '').includes(String(target ?? ''));
    case 'intersects': {
      const leftArr = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
      const rightArr = Array.isArray(target) ? target : target == null || target === '' ? [] : [target];
      if (leftArr.length === 0 || rightArr.length === 0) return false;
      return leftArr.some((v) => rightArr.includes(v));
    }
    case 'greater_than':
      return Number(value) > Number(target);
    case 'less_than':
      return Number(value) < Number(target);
    case 'is_empty':
      return !value || value === '';
    case 'is_not_empty':
      return !!value && value !== '';
    default:
      return true;
  }
}

const MULTI_VALUE_FIELD_TYPES = new Set(['multiselect', 'section_selector']);

function coerceToFieldShape(value: unknown, targetFieldType?: string): unknown {
  if (!targetFieldType) return value;
  if (MULTI_VALUE_FIELD_TYPES.has(targetFieldType)) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
  }
  return value;
}

function describeMappingSource(mapping: FieldMapping): string {
  switch (mapping.source_type) {
    case 'static': return `static: ${JSON.stringify(mapping.static_value ?? null)}`;
    case 'trigger_field': return `trigger.${mapping.trigger_field_id ?? '?'}`;
    case 'current_date': return 'current_date';
    case 'current_user': return 'current_user';
    case 'record_id': return 'record_id';
    case 'date_expression':
      return `date_expression(${mapping.date_base ?? 'current_date'}${mapping.date_base_field_id ? `.${mapping.date_base_field_id}` : ''}, ${mapping.date_expression ?? ''})`;
    case 'formula': return `formula: ${mapping.formula_expression ?? ''}`;
    case 'role_variable': return `role_variable(${mapping.role_id ?? '?'}, ${mapping.selection_strategy ?? 'first_match'})`;
    default: return mapping.source_type;
  }
}

function resolveFieldMappingWithTrace(
  mapping: FieldMapping,
  triggerRecord: AppRecord,
  allUsers: User[],
  allRecords: Record<string, AppRecord[]>,
  currentUserId: string | null | undefined,
  targetFieldType: string | undefined,
): { value: unknown; trace: FieldMappingTrace } {
  const base: FieldMappingTrace = {
    target_field_id: mapping.target_field_id,
    source_type: mapping.source_type,
    source_description: describeMappingSource(mapping),
    resolved_value: null,
  };

  switch (mapping.source_type) {
    case 'static': {
      const value = coerceToFieldShape(mapping.static_value, targetFieldType);
      return { value, trace: { ...base, resolved_value: value } };
    }
    case 'trigger_field': {
      const value = mapping.trigger_field_id ? triggerRecord.data[mapping.trigger_field_id] : null;
      return { value, trace: { ...base, resolved_value: value, trigger_field_id: mapping.trigger_field_id } };
    }
    case 'current_date': {
      const value = formatDateForField(new Date(), targetFieldType);
      return { value, trace: { ...base, resolved_value: value } };
    }
    case 'current_user': {
      const value = currentUserId ?? null;
      return { value, trace: { ...base, resolved_value: value } };
    }
    case 'record_id': {
      const value = triggerRecord.id;
      return { value, trace: { ...base, resolved_value: value } };
    }
    case 'date_expression': {
      const baseVal = mapping.date_base === 'trigger_field' && mapping.date_base_field_id
        ? triggerRecord.data[mapping.date_base_field_id]
        : new Date();
      const baseDate = baseVal instanceof Date ? baseVal : new Date(String(baseVal ?? ''));
      if (isNaN(baseDate.getTime())) return { value: null, trace: { ...base, resolved_value: null } };
      const value = formatDateForField(applyDateExpression(baseDate, mapping.date_expression ?? ''), targetFieldType);
      return { value, trace: { ...base, resolved_value: value } };
    }
    case 'formula': {
      const expr = mapping.formula_expression?.trim();
      if (!expr) return { value: null, trace: { ...base, resolved_value: null, formula_expression: '' } };
      const rawResult = evaluateFormula(expr, triggerRecord.data);
      if (typeof rawResult === 'string' && (rawResult === '#ERR' || rawResult === '#DIV0' || rawResult === '#REF' || rawResult === '#CYCLE')) {
        return { value: null, trace: { ...base, resolved_value: null, formula_expression: expr, formula_result: rawResult } };
      }
      let value: unknown = rawResult;
      if ((targetFieldType === 'number' || targetFieldType === 'currency') && typeof rawResult === 'string') {
        const n = Number(rawResult);
        value = Number.isFinite(n) ? n : null;
      }
      value = coerceToFieldShape(value, targetFieldType);
      return { value, trace: { ...base, resolved_value: value, formula_expression: expr, formula_result: rawResult } };
    }
    case 'role_variable': {
      if (!mapping.role_id || !mapping.role_conditions) {
        return { value: null, trace: { ...base, resolved_value: null, role_id: mapping.role_id, role_candidates_count: 0 } };
      }
      const candidates = allUsers.filter((u) => {
        if (!u.is_active) return false;
        const roleAssignment = u.role_assignments.find((ra) => ra.role_id === mapping.role_id);
        if (!roleAssignment) return false;
        return mapping.role_conditions!.every((cond) => {
          const fieldValue = roleAssignment.field_values[cond.field_name];
          const compareValue = cond.value_source === 'trigger_field' && cond.trigger_field_id
            ? triggerRecord.data[cond.trigger_field_id]
            : cond.value;
          return evaluateCondition(
            { id: cond.id, field_id: cond.field_name, operator: cond.operator, value: compareValue },
            { [cond.field_name]: fieldValue },
          );
        });
      });
      if (candidates.length === 0) return { value: null, trace: { ...base, resolved_value: null, role_id: mapping.role_id, role_candidates_count: 0 } };
      const strategy = mapping.selection_strategy ?? 'first_match';
      let selected = candidates[0]!;
      if (strategy === 'least_workload') {
        const allRecs = Object.values(allRecords).flat();
        let minCount = Infinity;
        for (const candidate of candidates) {
          const count = allRecs.filter((r) => Object.values(r.data).includes(candidate.id)).length;
          if (count < minCount) { minCount = count; selected = candidate; }
        }
      }
      return { value: selected.id, trace: { ...base, resolved_value: selected.id, role_id: mapping.role_id, role_candidates_count: candidates.length } };
    }
    default:
      return { value: null, trace: base };
  }
}

async function executeAction(
  action: WorkflowAction,
  order: number,
  triggerRecord: AppRecord,
  allModels: AppModel[],
  allRecords: Record<string, AppRecord[]>,
  allUsers: User[],
  _allRoles: Role[],
  saveRecord: (record: AppRecord) => void,
  showToast: (message: string) => void,
  currentUserId?: string | null,
  prevActionOutputs: Record<string, AppRecord> = {},
): Promise<WorkflowActionTrace> {
  const startedAt = Date.now();
  const traceBase = { id: action.id, order, duration_ms: 0 };

  try {
    switch (action.type) {
      case 'create_record': {
        const targetFieldTypes = getFieldTypeMap(allModels, action.target_model_id);
        const data: Record<string, unknown> = {};
        const fieldMappingsTrace: FieldMappingTrace[] = [];
        for (const mapping of action.field_mappings) {
          const { value, trace } = resolveFieldMappingWithTrace(mapping, triggerRecord, allUsers, allRecords, currentUserId, targetFieldTypes.get(mapping.target_field_id));
          data[mapping.target_field_id] = value;
          fieldMappingsTrace.push(trace);
        }
        let dedupMatch: AppRecord | undefined;
        if (action.skip_if_exists && action.dedup_target_field_id) {
          const key = action.dedup_target_field_id;
          const dedupValue = data[key];
          dedupMatch = (allRecords[action.target_model_id] ?? []).find((r) => r.data[key] === dedupValue);
        }
        if (dedupMatch) {
          return {
            ...traceBase,
            type: 'create_record',
            status: 'skipped',
            skip_reason: 'duplicate_exists',
            duration_ms: Date.now() - startedAt,
            target_model_id: action.target_model_id,
            resolved_data: data,
            field_mappings: fieldMappingsTrace,
            dedup_checked: true,
            dedup_field_id: action.dedup_target_field_id,
            dedup_match_record_id: dedupMatch.id,
          };
        }
        const newRecord: AppRecord = {
          id: uuid(),
          model_id: action.target_model_id,
          data,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        saveRecord(newRecord);
        // Make the created record visible to downstream actions referencing it
        // as `prev_action_output` (e.g. outbound_ivr calling the new record's phone).
        prevActionOutputs[action.id] = newRecord;
        return {
          ...traceBase,
          type: 'create_record',
          status: 'executed',
          duration_ms: Date.now() - startedAt,
          target_model_id: action.target_model_id,
          resolved_data: data,
          field_mappings: fieldMappingsTrace,
          created_record_id: newRecord.id,
          dedup_checked: !!action.skip_if_exists,
          dedup_field_id: action.dedup_target_field_id,
        };
      }

      case 'update_record': {
        const targetRecords = allRecords[action.target_model_id] ?? [];
        const filterValueSource = action.filter_value_source ?? 'static';
        const filterValue = (filterValueSource === 'trigger_field' && action.filter_trigger_field_id)
          ? triggerRecord.data[action.filter_trigger_field_id]
          : action.filter_value;

        // When the filter source is a single lookup field pointing to the target model,
        // the stored value is the target record's internal id — match by id directly.
        // Otherwise the UUID would be compared against the user's chosen business-key
        // field (which rarely holds UUIDs), and no match would be found.
        let matchedByRecordId = false;
        let target: AppRecord | undefined;
        if (filterValueSource === 'trigger_field' && action.filter_trigger_field_id && typeof filterValue === 'string') {
          const triggerModel = allModels.find((m) => m.id === triggerRecord.model_id);
          const triggerField = triggerModel?.schema.sections
            .flatMap((s) => s.fields)
            .find((f) => f.name === action.filter_trigger_field_id);
          if (
            triggerField?.type === 'lookup' &&
            !triggerField.is_multi &&
            triggerField.lookup_model_id === action.target_model_id
          ) {
            const byId = targetRecords.find((r) => r.id === filterValue);
            if (byId) { target = byId; matchedByRecordId = true; }
          }
        }
        // Literal 'id' filter — match the target by its top-level record id.
        // Covers the webhook pattern where a payload carries a record_id /
        // operation_id field and the workflow wants to target that exact
        // record. Without this branch, the next line would look for a
        // data.id key on each record, which doesn't exist.
        if (!target && action.filter_field_id === 'id' && typeof filterValue === 'string') {
          const byId = targetRecords.find((r) => r.id === filterValue);
          if (byId) { target = byId; matchedByRecordId = true; }
        }
        if (!target) {
          target = targetRecords.find((r) => r.data[action.filter_field_id] === filterValue);
        }
        if (!target) {
          return {
            ...traceBase,
            type: 'update_record',
            status: 'skipped',
            skip_reason: 'no_matching_record',
            duration_ms: Date.now() - startedAt,
            target_model_id: action.target_model_id,
            filter_field_id: action.filter_field_id,
            filter_value_source: filterValueSource,
            filter_trigger_field_id: action.filter_trigger_field_id,
            resolved_filter_value: filterValue,
            field_mappings: [],
          };
        }
        const targetFieldTypes = getFieldTypeMap(allModels, action.target_model_id);
        const previousData = { ...target.data };
        const updatedData = { ...target.data };
        const fieldMappingsTrace: FieldMappingTrace[] = [];
        for (const mapping of action.field_mappings) {
          const { value, trace } = resolveFieldMappingWithTrace(mapping, triggerRecord, allUsers, allRecords, currentUserId, targetFieldTypes.get(mapping.target_field_id));
          updatedData[mapping.target_field_id] = value;
          fieldMappingsTrace.push(trace);
        }
        const diff: Record<string, { before: unknown; after: unknown }> = {};
        for (const mapping of action.field_mappings) {
          const key = mapping.target_field_id;
          if (JSON.stringify(previousData[key]) !== JSON.stringify(updatedData[key])) {
            diff[key] = { before: previousData[key], after: updatedData[key] };
          }
        }
        saveRecord({ ...target, data: updatedData, updated_at: new Date().toISOString() });
        return {
          ...traceBase,
          type: 'update_record',
          status: 'executed',
          duration_ms: Date.now() - startedAt,
          target_model_id: action.target_model_id,
          filter_field_id: action.filter_field_id,
          filter_value_source: filterValueSource,
          filter_trigger_field_id: action.filter_trigger_field_id,
          resolved_filter_value: filterValue,
          matched_record_id: target.id,
          matched_by_record_id: matchedByRecordId,
          previous_data: previousData,
          new_data: updatedData,
          diff,
          field_mappings: fieldMappingsTrace,
        };
      }

      case 'send_notification': {
        const lang = document.documentElement.lang === 'ar' ? 'ar' : 'en';
        const message = lang === 'ar' ? action.message_ar : action.message_en;
        showToast(message);
        return {
          ...traceBase,
          type: 'send_notification',
          status: 'executed',
          duration_ms: Date.now() - startedAt,
          message_ar: action.message_ar,
          message_en: action.message_en,
          shown_message: message,
          shown_language: lang,
        };
      }

      case 'http_request': {
        const timeoutMs = Math.max(1000, Math.min(120_000, action.timeout_ms ?? 30_000));
        // Resolve templating on URL + header values against the trigger record.
        const resolvedUrl = substituteFieldTokens(action.url, triggerRecord);
        const resolvedHeaders: Record<string, string> = {};
        for (const pair of action.headers ?? []) {
          if (!pair.name.trim()) continue;
          resolvedHeaders[pair.name] = substituteFieldTokens(pair.value, triggerRecord);
        }
        // Build the request body per the selected mode.
        const targetFieldTypes = new Map<string, string>();
        let bodyString: string | undefined;
        if (action.body_mode === 'json_template' && action.body_template) {
          bodyString = substituteFieldTokens(action.body_template, triggerRecord);
        } else if (action.body_mode === 'form_mappings' && action.body_mappings?.length) {
          const bodyObj: Record<string, unknown> = {};
          for (const mapping of action.body_mappings) {
            const { value } = resolveFieldMappingWithTrace(
              mapping, triggerRecord, allUsers, allRecords, currentUserId,
              targetFieldTypes.get(mapping.target_field_id),
            );
            bodyObj[mapping.target_field_id] = value;
          }
          bodyString = JSON.stringify(bodyObj);
        }
        // Default Content-Type when we have a body and the caller didn't set one.
        if (bodyString !== undefined && !Object.keys(resolvedHeaders).some((k) => k.toLowerCase() === 'content-type')) {
          resolvedHeaders['Content-Type'] = 'application/json';
        }

        let responseStatus: number | undefined;
        let responseSnippet: string | undefined;
        let errorMsg: string | undefined;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(resolvedUrl, {
            method: action.method,
            headers: resolvedHeaders,
            body: action.method === 'GET' || action.method === 'DELETE' ? undefined : bodyString,
            signal: controller.signal,
          });
          responseStatus = response.status;
          try {
            const text = await response.text();
            responseSnippet = text.slice(0, 500);
          } catch {
            /* ignore — body unreadable */
          }
        } catch (err) {
          errorMsg = (err as Error).name === 'AbortError'
            ? `Request aborted after ${timeoutMs}ms timeout`
            : (err instanceof Error ? err.message : String(err));
        } finally {
          clearTimeout(timer);
        }

        const base = {
          ...traceBase,
          type: 'http_request' as const,
          duration_ms: Date.now() - startedAt,
          method: action.method,
          resolved_url: resolvedUrl,
          resolved_headers: Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
          body_mode: action.body_mode,
          resolved_body: bodyString?.slice(0, 1000),
          response_status: responseStatus,
          response_snippet: responseSnippet,
          timeout_ms: timeoutMs,
        };

        if (errorMsg) {
          return { ...base, status: 'failed', error: errorMsg };
        }
        // Treat 2xx/3xx as executed; 4xx/5xx as failed (with the error code
        // captured from the response) so the run log clearly flags bad calls.
        if (responseStatus !== undefined && responseStatus >= 400) {
          return { ...base, status: 'failed', error: `HTTP ${responseStatus}` };
        }
        return { ...base, status: 'executed' };
      }

      case 'assign_user': {
        const previousAssignee = triggerRecord.data[action.assignment_field_id];
        let assignedUserId: string | undefined;
        let candidatesCount: number | undefined;

        if (action.mode === 'specific_user') {
          assignedUserId = action.specific_user_id;
        } else if (action.mode === 'role_based' && action.role_id) {
          const candidates = allUsers.filter((u) => {
            if (!u.is_active) return false;
            const roleAssignment = u.role_assignments.find((ra) => ra.role_id === action.role_id);
            if (!roleAssignment) return false;
            return action.role_conditions.every((cond) => {
              const fieldValue = roleAssignment.field_values[cond.field_name];
              const compareValue = cond.value_source === 'trigger_field' && cond.trigger_field_id
                ? triggerRecord.data[cond.trigger_field_id]
                : cond.value;
              return evaluateCondition(
                { id: cond.id, field_id: cond.field_name, operator: cond.operator, value: compareValue },
                { [cond.field_name]: fieldValue },
              );
            });
          });
          candidatesCount = candidates.length;
          if (candidates.length > 0) {
            if (action.selection_strategy === 'least_workload') {
              const allRecs = Object.values(allRecords).flat();
              let minCount = Infinity;
              let selected = candidates[0]!;
              for (const candidate of candidates) {
                const count = allRecs.filter((r) => r.data[action.assignment_field_id] === candidate.id).length;
                if (count < minCount) { minCount = count; selected = candidate; }
              }
              assignedUserId = selected.id;
            } else {
              assignedUserId = candidates[0]!.id;
            }
          }
        }

        if (!assignedUserId || !action.assignment_field_id) {
          return {
            ...traceBase,
            type: 'assign_user',
            status: 'skipped',
            skip_reason: action.mode === 'role_based' ? 'no_eligible_users' : 'no_specific_user',
            duration_ms: Date.now() - startedAt,
            assignment_field_id: action.assignment_field_id,
            mode: action.mode,
            role_id: action.role_id,
            role_conditions_count: action.role_conditions.length,
            candidates_count: candidatesCount,
            selection_strategy: action.selection_strategy,
            previous_assignee_id: previousAssignee,
          };
        }

        saveRecord({
          ...triggerRecord,
          data: { ...triggerRecord.data, [action.assignment_field_id]: assignedUserId },
          updated_at: new Date().toISOString(),
        });
        return {
          ...traceBase,
          type: 'assign_user',
          status: 'executed',
          duration_ms: Date.now() - startedAt,
          assignment_field_id: action.assignment_field_id,
          mode: action.mode,
          role_id: action.role_id,
          role_conditions_count: action.role_conditions.length,
          candidates_count: candidatesCount,
          selection_strategy: action.selection_strategy,
          assigned_user_id: assignedUserId,
          previous_assignee_id: previousAssignee,
        };
      }

      case 'outbound_ivr': {
        // Resolve the destination from whichever source the user picked:
        // trigger_field / lookup / static / prev_action_output.
        const destination = getIvrDestination(action);
        const { number: normalized, description: destDescription } = resolveIvrDestination(
          destination,
          triggerRecord,
          prevActionOutputs,
          allRecords,
          allModels,
        );

        if (!normalized) {
          return {
            ...traceBase,
            type: 'outbound_ivr',
            status: 'skipped',
            skip_reason: 'no_destination_number',
            duration_ms: Date.now() - startedAt,
            destination_kind: destination.kind,
            destination_description: destDescription,
            audio_mode: action.audio_mode,
            options_count: action.options.length,
          };
        }

        if (action.options.length === 0) {
          return {
            ...traceBase,
            type: 'outbound_ivr',
            status: 'failed',
            error: 'outbound_ivr action has no options (Hatif requires at least one)',
            duration_ms: Date.now() - startedAt,
            resolved_to_number: normalized,
            destination_kind: destination.kind,
            destination_description: destDescription,
            audio_mode: action.audio_mode,
            options_count: 0,
          };
        }

        // Resolve TTS tokens + build the proxy payload. The proxy fills in
        // channelId default + webhookUrl server-side, so we send only what
        // the user configured.
        const resolvedTts = action.audio_mode === 'tts' && action.tts_text
          ? substituteFieldTokens(action.tts_text, triggerRecord)
          : undefined;

        // Hatif stores one label per option. We send the action's chosen
        // language so the option text matches the TTS language the customer
        // hears. Both labels stay on the action config for Run-log rendering.
        const useAr = action.language === 'ar';
        const optionsForHatif = action.options.map((o) => ({
          digit: o.digit,
          label: (useAr ? o.label_ar : o.label_en) || o.label_en || o.label_ar,
        }));

        // Attach Supabase JWT so the /api/hatif/outbound-ivr proxy's withAuth
        // gate lets us through. Workflows run under whichever session the
        // current user triggered them.
        let authHeader: Record<string, string> = {};
        if (supabase) {
          try {
            const { data } = await supabase.auth.getSession();
            const token = data.session?.access_token;
            if (token) authHeader = { Authorization: `Bearer ${token}` };
          } catch {
            /* fall through — the proxy returns 401 and we log it as failed */
          }
        }

        let responseStatus: number | undefined;
        let responseSnippet: string | undefined;
        let ivrCallId: string | undefined;
        let errorMsg: string | undefined;

        try {
          const res = await fetch('/api/hatif/outbound-ivr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              destinationNumber: normalized,
              channelId: action.channel_id || undefined,
              ttsText: resolvedTts,
              ttsVoice: action.tts_voice,
              audioFileUrl: action.audio_mode === 'audio' ? action.audio_file_url : undefined,
              options: optionsForHatif,
              // externalId must be unique per *run* — using the action id alone
              // makes Hatif dedupe every workflow firing as a single call and
              // return a cached response without actually ringing. Combine the
              // action id with a fresh uuid so Hatif sees each run as new.
              externalId: `${traceBase.id}:${uuid()}`,
            }),
          });
          responseStatus = res.status;
          const text = await res.text().catch(() => '');
          responseSnippet = text.slice(0, 500);
          if (res.ok) {
            try {
              const parsed = JSON.parse(text) as { ivrCallId?: string | null };
              ivrCallId = parsed.ivrCallId ?? undefined;
            } catch {
              /* non-JSON success body — ignore; ivrCallId stays undefined */
            }
          } else {
            errorMsg = `HTTP ${res.status}`;
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        const traceCommon = {
          ...traceBase,
          type: 'outbound_ivr' as const,
          duration_ms: Date.now() - startedAt,
          resolved_to_number: normalized,
          destination_kind: destination.kind,
          destination_description: destDescription,
          channel_id: action.channel_id,
          audio_mode: action.audio_mode,
          resolved_tts_text: resolvedTts?.slice(0, 500),
          audio_file_url: action.audio_file_url,
          tts_voice: action.tts_voice,
          options_count: action.options.length,
          ivr_call_id: ivrCallId,
          response_status: responseStatus,
          response_snippet: responseSnippet,
        };

        if (errorMsg) return { ...traceCommon, status: 'failed', error: errorMsg };
        return { ...traceCommon, status: 'executed' };
      }

      case 'send_whatsapp_message': {
        // Resolve the destination from whichever source the user picked —
        // same 4-source union as outbound_ivr (trigger_field / lookup /
        // static / prev_action_output). Missing / malformed numbers skip
        // the action rather than failing the whole workflow run.
        const destination = getWhatsAppMessageDestination(action);
        const { number: normalized, description: destDescription } = resolveIvrDestination(
          destination,
          triggerRecord,
          prevActionOutputs,
          allRecords,
          allModels,
        );

        if (!normalized) {
          return {
            ...traceBase,
            type: 'send_whatsapp_message',
            status: 'skipped',
            skip_reason: 'no_destination_number',
            duration_ms: Date.now() - startedAt,
            destination_kind: destination.kind,
            destination_description: destDescription,
            device_id: action.device_id,
          };
        }

        const resolvedBody = substituteFieldTokens(action.body_template ?? '', triggerRecord);
        if (!resolvedBody.trim()) {
          return {
            ...traceBase,
            type: 'send_whatsapp_message',
            status: 'skipped',
            skip_reason: 'empty_body_after_substitution',
            duration_ms: Date.now() - startedAt,
            destination_kind: destination.kind,
            destination_description: destDescription,
            resolved_to_number: normalized,
            device_id: action.device_id,
            resolved_body: '',
          };
        }

        // Same auth dance as outbound_ivr — forward the current session's
        // Supabase JWT so the /api/haberchat/messages proxy's withAuth
        // gate lets us through.
        let authHeader: Record<string, string> = {};
        if (supabase) {
          try {
            const { data } = await supabase.auth.getSession();
            const token = data.session?.access_token;
            if (token) authHeader = { Authorization: `Bearer ${token}` };
          } catch {
            /* ignore — proxy will return 401 and we log it as failed */
          }
        }

        let responseStatus: number | undefined;
        let responseSnippet: string | undefined;
        let messageWid: string | undefined;
        let errorMsg: string | undefined;

        // Resolve the send-from device: explicit action config → the
        // local overlay's default → first active overlay device → first
        // live Haberchat device → let the proxy fall back to
        // HABERCHAT_DEFAULT_DEVICE_ID. Mirrors sendChatMessage's resolver
        // so the workflow path and the manual composer path agree on
        // which number sends.
        const storeState = useAppStore.getState();
        const resolvedDeviceId =
          action.device_id ||
          storeState.waDevices.find((d) => d.is_default && d.is_active)?.device_id ||
          storeState.waDevices.find((d) => d.is_active)?.device_id ||
          storeState.waDevicesLive[0]?.id ||
          undefined;

        try {
          const res = await fetch('/api/haberchat/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              deviceId: resolvedDeviceId,
              phone: normalized,
              body: resolvedBody,
              // Pass the action trace id as the idempotency key. The
              // message:out:new webhook echoes this on the chat_messages
              // row so our Realtime merge path can match a future UI
              // placeholder without creating duplicates.
              reference: traceBase.id,
            }),
          });
          responseStatus = res.status;
          const text = await res.text().catch(() => '');
          responseSnippet = text.slice(0, 500);
          if (res.ok) {
            try {
              const parsed = JSON.parse(text) as { wid?: string | null };
              messageWid = parsed.wid ?? undefined;
            } catch {
              /* non-JSON success body — ignore; messageWid stays undefined */
            }
          } else {
            errorMsg = `HTTP ${res.status}`;
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        const traceCommon = {
          ...traceBase,
          type: 'send_whatsapp_message' as const,
          duration_ms: Date.now() - startedAt,
          resolved_to_number: normalized,
          destination_kind: destination.kind,
          destination_description: destDescription,
          device_id: action.device_id,
          resolved_body: resolvedBody.slice(0, 500),
          message_wid: messageWid,
          response_status: responseStatus,
          response_snippet: responseSnippet,
        };

        if (errorMsg) return { ...traceCommon, status: 'failed', error: errorMsg };
        return { ...traceCommon, status: 'executed' };
      }
    }
  } catch (err) {
    return {
      ...traceBase,
      type: action.type as WorkflowActionTrace['type'],
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
      // Fill in type-required fields with safe defaults — the consumer keys off status === 'failed'.
      ...(action.type === 'create_record' ? { target_model_id: action.target_model_id, resolved_data: {}, field_mappings: [] } : {}),
      ...(action.type === 'update_record' ? { target_model_id: action.target_model_id, filter_field_id: action.filter_field_id, filter_value_source: (action.filter_value_source ?? 'static'), resolved_filter_value: null, field_mappings: [] } : {}),
      ...(action.type === 'send_notification' ? { message_ar: action.message_ar, message_en: action.message_en, shown_message: '', shown_language: 'en' } : {}),
      ...(action.type === 'assign_user' ? { assignment_field_id: action.assignment_field_id, mode: action.mode, role_conditions_count: action.role_conditions.length } : {}),
      ...(action.type === 'http_request' ? { method: action.method, resolved_url: action.url, body_mode: action.body_mode } : {}),
      ...(action.type === 'outbound_ivr' ? { destination_kind: getIvrDestination(action).kind, audio_mode: action.audio_mode, options_count: action.options.length } : {}),
      ...(action.type === 'send_whatsapp_message' ? { destination_kind: getWhatsAppMessageDestination(action).kind, device_id: action.device_id } : {}),
    } as WorkflowActionTrace;
  }

  // Unreachable; all cases above return.
  throw new Error('executeAction: unreachable');
}

// Re-export for backward compat (unused consumers can keep importing this)
export { getFieldLabel };
