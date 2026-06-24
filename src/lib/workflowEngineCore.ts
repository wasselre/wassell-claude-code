/**
 * Pure, environment-agnostic helpers for the workflow engine.
 *
 * Lives separately from `workflowEngine.ts` so the server-side sweeper
 * (`api/_lib/workflowSweeper.ts`) can reuse the same condition evaluator
 * and date-expression parser without dragging in browser-only deps
 * (`@/lib/supabase`, `@/stores/appStore`).
 *
 * **Hard rule:** never add an import here that targets a browser-only
 * module. The whole point is that this file loads cleanly under Node.
 */

import type { AppModel, AppRecord, Workflow, WorkflowBranch, WorkflowCondition, FieldMapping, User, SelectionStrategy } from '@/types';
import { formatDateHumanAr } from './dateFormat.js';

/**
 * Format a Date for storage in a record field so that the HTML form inputs
 * will re-hydrate it. `<input type="date">` expects `YYYY-MM-DD` and
 * `<input type="datetime-local">` expects `YYYY-MM-DDTHH:MM` in local time.
 * A raw ISO string with a `Z` suffix is silently rejected by the browser
 * even though the table view (which goes through `new Date(...)`) still
 * displays it.
 */
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

/**
 * Parse a date-offset expression like `"+5d -2w +3mo +1y +2h -30min"` and
 * apply it to `base`. An optional trailing `@HH:MM` token forces the time
 * of day after offsets are applied — e.g. `"+0d @10:00"` returns the same
 * calendar date as `base` but at 10:00 local, and `"-1d @10:00"` returns
 * yesterday at 10:00. The offsets and the time-of-day token can appear in
 * any order; the time-of-day always applies last so the chosen date keeps it.
 */
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
  const timeMatch = expression.match(/@\s*(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const hours = Math.min(23, Math.max(0, parseInt(timeMatch[1]!, 10)));
    const minutes = Math.min(59, Math.max(0, parseInt(timeMatch[2]!, 10)));
    result.setHours(hours, minutes, 0, 0);
  }
  return result;
}

/**
 * Evaluate a single workflow condition against a record's data. Pure
 * boolean check — same operator semantics as the client-side engine.
 */
export function evaluateCondition(
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

/**
 * Optional context for `substituteFieldTokens` — needed when the template
 * references lookup-traversal tokens like `{project_id.project_name}`.
 * Without context, dot-path tokens substitute to "" with a console.warn.
 */
export interface SubstituteTokensContext {
  /** Model of the trigger record — used to resolve lookup field metadata. */
  triggerModel?: AppModel | undefined;
  /** All records keyed by model_id. Accepts a Map (server sweeper) or a plain object (client store). */
  recordsByModel?: Map<string, AppRecord[]> | Record<string, AppRecord[]>;
}

function getModelRecords(
  byModel: SubstituteTokensContext['recordsByModel'],
  modelId: string,
): AppRecord[] {
  if (!byModel) return [];
  if (byModel instanceof Map) return byModel.get(modelId) ?? [];
  return byModel[modelId] ?? [];
}

function applyFormatter(value: unknown, formatter: string, debugToken: string): string {
  if (value === null || value === undefined) return '';
  switch (formatter) {
    case 'human_ar':
      return formatDateHumanAr(value as string | Date);
    default: {
      // eslint-disable-next-line no-console
      console.warn(`[substituteFieldTokens] unknown formatter "${formatter}" on token "${debugToken}" — falling back to raw value`);
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }
  }
}

/**
 * Replace `{field_slug}` tokens in a template string with the trigger
 * record's values. Used by the `http_request`, `send_whatsapp_message`,
 * and `outbound_ivr` actions for URL / header / body / TTS templating.
 *
 * **Token syntax**
 *
 *   `{slug}`                                  raw field value
 *   `{slug|formatter}`                        formatted value
 *   `{lookup_slug.target_field}`              dereference a lookup — read
 *                                             `target_field` off the linked
 *                                             record in the lookup target
 *                                             model (single hop)
 *   `{lookup_slug.target_field|formatter}`    dereference + format
 *
 * **Formatters (v1):**
 *   `human_ar` — friendly Arabic date+time phrase (see `formatDateHumanAr`)
 *
 * **Dot-path traversal** requires `context.triggerModel` and
 * `context.recordsByModel` so we can resolve the lookup. Without them,
 * a dot-path token substitutes to "" with a console.warn — never a
 * silent skip (CLAUDE.md "Silent Failures").
 *
 * Unknown formatters fall back to the raw value with a console.warn.
 * Missing fields / unresolved lookup targets substitute to "". Object
 * values are JSON-stringified before substitution.
 */
export function substituteFieldTokens(
  template: string,
  triggerRecord: AppRecord,
  context?: SubstituteTokensContext,
): string {
  return template.replace(
    /\{([a-zA-Z_]\w*)(?:\.([a-zA-Z_]\w*))?(?:\|([a-zA-Z_]\w*))?\}/g,
    (match, slug, dotField, formatter) => {
      let value: unknown = triggerRecord.data[slug];

      if (dotField) {
        if (!context?.triggerModel) {
          // eslint-disable-next-line no-console
          console.warn(`[substituteFieldTokens] dot-path token "${match}" needs context.triggerModel — substituting empty`);
          return '';
        }
        const lookupField = context.triggerModel.schema.sections
          .flatMap((s) => s.fields)
          .find((f) => f.name === slug);
        if (!lookupField || lookupField.type !== 'lookup' || !lookupField.lookup_model_id) {
          // eslint-disable-next-line no-console
          console.warn(`[substituteFieldTokens] dot-path token "${match}" but "${slug}" isn't a lookup field — substituting empty`);
          return '';
        }
        const targetId = Array.isArray(value) ? value[0] : value;
        if (typeof targetId !== 'string' || !targetId) return '';
        const candidates = getModelRecords(context.recordsByModel, lookupField.lookup_model_id);
        const targetRecord = candidates.find((r) => r.id === targetId);
        if (!targetRecord) return '';
        value = targetRecord.data[dotField];
      }

      if (value === null || value === undefined) return '';
      if (formatter) return applyFormatter(value, formatter, match);
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    },
  );
}

/**
 * Normalize a workflow into its branch list. Workflows saved by the
 * branched editor always carry `branches`. Older saves are wrapped into a
 * single implicit branch so the engine has one code path.
 */
export function getWorkflowBranches(workflow: Workflow): WorkflowBranch[] {
  if (workflow.branches && workflow.branches.length > 0) return workflow.branches;
  return [{
    id: `${workflow.id}__legacy`,
    conditions: workflow.conditions ?? [],
    actions: workflow.actions ?? [],
  }];
}

/**
 * Candidate users for a `role_variable` assignee mapping: active users assigned
 * the mapping's role whose role field_values satisfy every role_condition. This
 * is the SHARED filter — the same logic the client engine uses inline — so the
 * server runner and the browser agree on who is eligible. The workload count +
 * selection is split out into `pickRoleVariableUser` because the two engines
 * source workload differently (client: in-memory records; server: SQL count).
 */
export function roleVariableCandidates(
  mapping: FieldMapping,
  triggerData: Record<string, unknown>,
  users: User[],
): User[] {
  if (!mapping.role_id || !mapping.role_conditions) return [];
  return users.filter((u) => {
    if (!u.is_active) return false;
    const ra = u.role_assignments.find((r) => r.role_id === mapping.role_id);
    if (!ra) return false;
    return mapping.role_conditions!.every((cond) => {
      const fieldValue = ra.field_values[cond.field_name];
      const compareValue = cond.value_source === 'trigger_field' && cond.trigger_field_id
        ? triggerData[cond.trigger_field_id]
        : cond.value;
      return evaluateCondition(
        { id: cond.id, field_id: cond.field_name, operator: cond.operator, value: compareValue },
        { [cond.field_name]: fieldValue },
      );
    });
  });
}

/**
 * Deterministically pick one candidate. `least_workload` → minimum workload,
 * tie-break by `user.id` ascending; `first_match` → `user.id` ascending. The
 * stable `user.id` tie-break is REQUIRED for server retry-safety: a re-run of
 * the same transition must select the same user, so it can never create a
 * second assignee. (This is a deliberate determinism refinement over the
 * client's historical load-order pick.) `workloadOf` is supplied by the caller.
 */
export function pickRoleVariableUser(
  candidates: User[],
  strategy: SelectionStrategy | undefined,
  workloadOf: (userId: string) => number,
): User | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  if ((strategy ?? 'first_match') === 'least_workload') {
    let best = sorted[0]!;
    let bestLoad = workloadOf(best.id);
    for (const u of sorted.slice(1)) {
      const load = workloadOf(u.id);
      if (load < bestLoad) { best = u; bestLoad = load; }
    }
    return best;
  }
  return sorted[0]!;
}
