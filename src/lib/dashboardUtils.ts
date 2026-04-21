import type { AppRecord, ModelField, WidgetFilterCondition } from '@/types';

export interface GroupedData {
  label_ar: string;
  label_en: string;
  value: string;
  count: number;
  color: string;
}

export interface TimeSeriesData {
  label: string;
  count: number;
}

/**
 * Evaluate a single filter condition against a record value
 */
function evaluateCondition(
  recordValue: unknown,
  operator: WidgetFilterCondition['operator'],
  conditionValue: unknown,
): boolean {
  switch (operator) {
    case 'equals':
      return recordValue == conditionValue;
    case 'not_equals':
      return recordValue != conditionValue;
    case 'contains':
      return String(recordValue ?? '').toLowerCase().includes(String(conditionValue ?? '').toLowerCase());
    case 'greater_than':
      return Number(recordValue) > Number(conditionValue);
    case 'less_than':
      return Number(recordValue) < Number(conditionValue);
    case 'is_empty':
      return recordValue === undefined || recordValue === null || recordValue === '';
    case 'is_not_empty':
      return recordValue !== undefined && recordValue !== null && recordValue !== '';
    default:
      return true;
  }
}

/**
 * Resolve the scalar a condition should compare against. Handles structured
 * field values (currently: `range` → `{ min?: number; max?: number }`).
 *
 * Returns `{ skip: true }` when the condition can't be sensibly evaluated
 * against the given field shape (e.g. a range-typed field condition saved
 * before dot-path support, targeting a numeric operator without a path).
 * Callers should treat skipped conditions as a pass (don't filter the row out).
 */
function resolveConditionValue(
  field: ModelField,
  recordValue: unknown,
  cond: WidgetFilterCondition,
): { skip: true } | { skip: false; value: unknown } {
  if (field.type === 'range') {
    // Emptiness checks are meaningful against the whole stored value.
    if (cond.operator === 'is_empty' || cond.operator === 'is_not_empty') {
      return { skip: false, value: recordValue };
    }
    if (cond.field_path === 'min' || cond.field_path === 'max') {
      if (recordValue && typeof recordValue === 'object') {
        const scalar = (recordValue as Record<string, unknown>)[cond.field_path];
        return { skip: false, value: scalar };
      }
      return { skip: false, value: undefined };
    }
    // Range-typed condition with no path and a non-emptiness operator —
    // saved before range support existed. Skip rather than filter every row
    // out (Number({...}) would be NaN and every comparison would fail).
    return { skip: true };
  }
  return { skip: false, value: recordValue };
}

/**
 * Filter records by multiple conditions (AND logic).
 * Each condition references a field by ID -- we resolve the field name from allFields.
 */
export function applyConditions(
  records: AppRecord[],
  conditions: WidgetFilterCondition[] | undefined,
  allFields: ModelField[],
): AppRecord[] {
  if (!conditions || conditions.length === 0) return records;

  return records.filter((rec) =>
    conditions.every((cond) => {
      const field = allFields.find((f) => f.id === cond.field_id);
      if (!field) return true; // skip unknown fields
      const raw = rec.data[field.name];
      const resolved = resolveConditionValue(field, raw, cond);
      if (resolved.skip) return true;
      return evaluateCondition(resolved.value, cond.operator, cond.value);
    }),
  );
}

/**
 * Legacy single-filter compat -- kept for old widgets that might still have filter_field_id
 */
export function filterRecords(
  records: AppRecord[],
  filterField: ModelField | undefined,
  filterValue: unknown,
): AppRecord[] {
  if (!filterField || filterValue === undefined || filterValue === null || filterValue === '') {
    return records;
  }
  return records.filter((r) => r.data[filterField.name] === filterValue);
}

export function groupRecordsByField(
  records: AppRecord[],
  field: ModelField,
  conditions?: WidgetFilterCondition[],
  allFields?: ModelField[],
): GroupedData[] {
  const filtered = applyConditions(records, conditions, allFields ?? []);
  const counts = new Map<string, number>();

  for (const rec of filtered) {
    const val = rec.data[field.name];
    if (Array.isArray(val)) {
      for (const v of val as string[]) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    } else if (val !== undefined && val !== null) {
      const key = String(val);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return (field.options ?? []).map((opt) => ({
    label_ar: opt.label_ar,
    label_en: opt.label_en,
    value: opt.value,
    count: counts.get(opt.value) ?? 0,
    color: opt.color ?? '#6B7280',
  }));
}

export function groupRecordsByDate(
  records: AppRecord[],
  dateField: ModelField,
  period: 'day' | 'week' | 'month',
  conditions?: WidgetFilterCondition[],
  allFields?: ModelField[],
): TimeSeriesData[] {
  const filtered = applyConditions(records, conditions, allFields ?? []);
  const buckets = new Map<string, number>();

  for (const rec of filtered) {
    const val = rec.data[dateField.name];
    if (!val) continue;
    const date = new Date(String(val));
    if (isNaN(date.getTime())) continue;

    let key: string;
    if (period === 'day') {
      key = date.toISOString().slice(0, 10);
    } else if (period === 'week') {
      const d = new Date(date);
      d.setDate(d.getDate() - d.getDay());
      key = d.toISOString().slice(0, 10);
    } else {
      key = date.toISOString().slice(0, 7);
    }
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => ({ label, count }));
}
