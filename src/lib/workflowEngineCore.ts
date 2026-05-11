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

import type { Workflow, WorkflowBranch, WorkflowCondition } from '@/types';

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
