/**
 * The unified filter evaluator. One place that knows how to read a field ref's
 * value (incl. synthetic created_by/at refs + range min/max sub-paths) and apply
 * an operator with array-aware, numeric-aware, date-aware semantics — merging
 * what `dashboardUtils`, `scopeFilters`, and the workflow engine each did
 * separately. Array semantics follow `scopeFilters` (the correct multiselect
 * behavior): `equals` on an array means membership.
 */
import type { AppRecord, ModelField } from '../../types';
import type { AnalyticsFieldRef, AnalyticsOperator, FilterCondition, FilterGroup } from './types';
import { toNumeric } from './numeric.js';
import { valueRiyadhMs } from './dateWindows.js';

/** Read a record's value for any field ref. Returns undefined for unknown fields. */
export function readRefValue(
  record: AppRecord,
  ref: AnalyticsFieldRef,
  field: ModelField | undefined,
): unknown {
  switch (ref.kind) {
    case 'created_by':
      return record.created_by_user_id ?? null;
    case 'created_at':
      return record.created_at ?? null;
    case 'updated_at':
      return record.updated_at ?? null;
    case 'field': {
      if (!field) return undefined;
      const raw = record.data[field.name];
      if (field.type === 'range' && (ref.field_path === 'min' || ref.field_path === 'max')) {
        if (raw && typeof raw === 'object') return (raw as Record<string, unknown>)[ref.field_path];
        return undefined;
      }
      return raw;
    }
    default:
      return undefined;
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Put both sides on a single comparable numeric scale (number first, then date). */
function asComparablePair(a: unknown, b: unknown): [number, number] | null {
  const an = toNumeric(a);
  const bn = toNumeric(b);
  if (an !== null && bn !== null) return [an, bn];
  const ad = valueRiyadhMs(a);
  const bd = valueRiyadhMs(b);
  if (ad !== null && bd !== null) return [ad, bd];
  return null;
}

function looseEquals(recordValue: unknown, target: unknown): boolean {
  if (Array.isArray(recordValue)) return recordValue.map((x) => String(x)).includes(String(target));
  if (typeof recordValue === 'boolean' || typeof target === 'boolean') {
    return String(recordValue) === String(target);
  }
  const rn = toNumeric(recordValue);
  const tn = toNumeric(target);
  if (rn !== null && tn !== null) return rn === tn;
  return String(recordValue ?? '') === String(target ?? '');
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

export function evaluateOperator(
  recordValue: unknown,
  operator: AnalyticsOperator,
  target: unknown,
): boolean {
  switch (operator) {
    case 'is_empty':
      return isEmptyValue(recordValue);
    case 'is_not_empty':
      return !isEmptyValue(recordValue);
    case 'equals':
      return looseEquals(recordValue, target);
    case 'not_equals':
      return !looseEquals(recordValue, target);
    case 'in': {
      const set = toArray(target).map((x) => String(x));
      return toArray(recordValue).map((x) => String(x)).some((v) => set.includes(v));
    }
    case 'not_in': {
      const set = toArray(target).map((x) => String(x));
      return !toArray(recordValue).map((x) => String(x)).some((v) => set.includes(v));
    }
    case 'contains':
      if (Array.isArray(recordValue)) return recordValue.map((x) => String(x)).includes(String(target));
      return String(recordValue ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'not_contains':
      if (Array.isArray(recordValue)) return !recordValue.map((x) => String(x)).includes(String(target));
      return !String(recordValue ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'greater_than': {
      const p = asComparablePair(recordValue, target);
      return p ? p[0] > p[1] : false;
    }
    case 'greater_or_equal': {
      const p = asComparablePair(recordValue, target);
      return p ? p[0] >= p[1] : false;
    }
    case 'less_than': {
      const p = asComparablePair(recordValue, target);
      return p ? p[0] < p[1] : false;
    }
    case 'less_or_equal': {
      const p = asComparablePair(recordValue, target);
      return p ? p[0] <= p[1] : false;
    }
    case 'between': {
      if (!Array.isArray(target) || target.length < 2) return false;
      const lo = asComparablePair(recordValue, target[0]);
      const hi = asComparablePair(recordValue, target[1]);
      if (!lo || !hi) return false;
      return lo[0] >= lo[1] && hi[0] <= hi[1];
    }
    default:
      return true;
  }
}

export function conditionPasses(
  record: AppRecord,
  cond: FilterCondition,
  fieldsById: Map<string, ModelField>,
): boolean {
  let field: ModelField | undefined;
  if (cond.field.kind === 'field') {
    field = fieldsById.get(cond.field.field_id);
    if (!field) return true; // unknown field → skip (the engine emits the warning once)
  }
  const value = readRefValue(record, cond.field, field);
  return evaluateOperator(value, cond.operator, cond.value);
}

export function recordPassesGroup(
  record: AppRecord,
  group: FilterGroup | undefined,
  fieldsById: Map<string, ModelField>,
): boolean {
  if (!group || !group.conditions || group.conditions.length === 0) return true;
  if (group.mode === 'any') return group.conditions.some((c) => conditionPasses(record, c, fieldsById));
  return group.conditions.every((c) => conditionPasses(record, c, fieldsById));
}
