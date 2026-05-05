/**
 * Scope filter evaluator — the engine behind per-profile per-model
 * view/edit scopes.
 *
 * A scope is a `ScopeRule` defined on a `ProfileModelPermissions` entry.
 * It answers "of all records in this model, which can this profile reach?"
 * Conditions AND together (matching the dashboard filter behavior). A
 * scope of `{ mode: 'all' }` is a pass-through.
 *
 * The two things a scope condition can refer to that dashboard filters
 * can't:
 *  1. The synthetic `created_by` target — `record.created_by_user_id` —
 *     which lets an admin write "records I created" without forcing
 *     every model to expose a creator field.
 *  2. User-context value sources (`current_user`, `role_field`) — these
 *     resolve at evaluation time against the signed-in user, so a single
 *     profile rule like "Region = my Region" works for every Sales rep
 *     without per-user customization.
 *
 * This file is app-layer only. When we push enforcement into Postgres RLS
 * (the planned next step), the same condition shape needs to translate
 * into SQL — keep this evaluator's semantics deliberate so the SQL port
 * stays a 1:1 mapping.
 */

import type {
  AppRecord,
  ModelField,
  Role,
  ScopeFilterCondition,
  ScopeOperator,
  ScopeRule,
  ScopeValueSource,
  User,
} from '@/types';

// ────────────────────────────────────────────────────────────────────
// User context — what the evaluator needs to resolve user-bound sources.
// Built once per evaluation pass and reused across records to avoid
// re-walking `user.role_assignments` per row.
// ────────────────────────────────────────────────────────────────────
export interface ScopeUserContext {
  /** The signed-in user, or null if no auth (then scopes are pass-through). */
  user: User | null;
  /** All roles in the workspace, indexed for `role_field` resolution. */
  roles: Role[];
}

// Sentinel: a value source that resolves to "user holds no such role / no
// such role field set". An equality check against this returns false (the
// user can't match a role they don't hold), which closes the rule. We pick
// a unique symbol so it can't collide with any real record value.
const UNRESOLVED = Symbol('unresolved-user-context');

/**
 * Resolve a `ScopeValueSource` into the value to compare against the
 * record's field. Returns `UNRESOLVED` when the user-context source
 * can't be satisfied — callers treat this as "condition fails."
 */
function resolveSource(source: ScopeValueSource, ctx: ScopeUserContext): unknown {
  switch (source.kind) {
    case 'literal':
      return source.value;
    case 'current_user':
      return ctx.user?.id ?? UNRESOLVED;
    case 'role_field': {
      if (!ctx.user) return UNRESOLVED;
      const assignment = ctx.user.role_assignments.find((a) => a.role_id === source.role_id);
      if (!assignment) return UNRESOLVED;
      const value = assignment.field_values[source.field_slug];
      return value === undefined ? UNRESOLVED : value;
    }
  }
}

/**
 * Evaluate one operator. Mirrors `dashboardUtils.evaluateCondition` so the
 * two filter pipelines stay semantically aligned. `is_empty` /
 * `is_not_empty` ignore the source value entirely; everything else returns
 * false the moment the source is unresolved.
 */
function evaluateOperator(
  recordValue: unknown,
  operator: ScopeOperator,
  rhs: unknown,
): boolean {
  if (operator === 'is_empty') {
    return recordValue === undefined || recordValue === null || recordValue === '';
  }
  if (operator === 'is_not_empty') {
    return recordValue !== undefined && recordValue !== null && recordValue !== '';
  }
  if (rhs === UNRESOLVED) return false;
  switch (operator) {
    case 'equals':
      // `==` (not `===`) so number→string coercion matches dashboard behavior.
      return recordValue == rhs;
    case 'not_equals':
      return recordValue != rhs;
    case 'contains':
      return String(recordValue ?? '')
        .toLowerCase()
        .includes(String(rhs ?? '').toLowerCase());
    case 'greater_than':
      return Number(recordValue) > Number(rhs);
    case 'less_than':
      return Number(recordValue) < Number(rhs);
  }
}

/**
 * Pull the value the condition compares against from the record. For
 * `created_by` this is `record.created_by_user_id`; for `field` we look
 * up the field's slug on `record.data` (and walk `field_path` for
 * structured types like range).
 */
function resolveRecordValue(
  cond: ScopeFilterCondition,
  record: AppRecord,
  fields: ModelField[],
): unknown {
  const ref = cond.field;
  if (ref.kind === 'created_by') {
    return record.created_by_user_id ?? null;
  }
  const field = fields.find((f) => f.id === ref.field_id);
  if (!field) return undefined;
  const raw = record.data[field.name];
  if (ref.field_path && raw && typeof raw === 'object') {
    return (raw as Record<string, unknown>)[ref.field_path];
  }
  return raw;
}

/**
 * Evaluate one scope condition against one record. Returns true when the
 * record passes (i.e. the condition is satisfied), false otherwise.
 */
function evaluateCondition(
  cond: ScopeFilterCondition,
  record: AppRecord,
  fields: ModelField[],
  ctx: ScopeUserContext,
): boolean {
  const recordValue = resolveRecordValue(cond, record, fields);
  const rhs = resolveSource(cond.source, ctx);
  return evaluateOperator(recordValue, cond.operator, rhs);
}

/**
 * Evaluate a full scope rule against one record. AND across conditions.
 * `{ mode: 'all' }` always passes. An empty conditions array on a
 * `filtered` rule also always passes — the admin started building the
 * rule but didn't add any conditions yet, so we don't lock everyone out.
 */
export function recordPassesScope(
  rule: ScopeRule | undefined,
  record: AppRecord,
  fields: ModelField[],
  ctx: ScopeUserContext,
): boolean {
  if (!rule || rule.mode === 'all') return true;
  if (rule.conditions.length === 0) return true;
  return rule.conditions.every((c) => evaluateCondition(c, record, fields, ctx));
}

/**
 * Filter a list of records by a scope rule. Convenience wrapper around
 * `recordPassesScope` used by the listing pages and lookup pickers.
 */
export function applyScope(
  records: AppRecord[],
  rule: ScopeRule | undefined,
  fields: ModelField[],
  ctx: ScopeUserContext,
): AppRecord[] {
  if (!rule || rule.mode === 'all') return records;
  if (rule.conditions.length === 0) return records;
  return records.filter((r) => recordPassesScope(rule, r, fields, ctx));
}

/**
 * Helper: build the user context once for a scope-evaluation pass.
 * Centralizes the "no user signed in" semantics — the rest of the
 * evaluator treats a null user as "no role-context source can resolve",
 * which makes any role_field condition fail. The CALLER decides whether
 * to skip scope enforcement entirely when the user is null (see
 * `permissions.ts`'s `canViewRecord` admin-bypass for the policy).
 */
export function buildScopeContext(user: User | null, roles: Role[]): ScopeUserContext {
  return { user, roles };
}
