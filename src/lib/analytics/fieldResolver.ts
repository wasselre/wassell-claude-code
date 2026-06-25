/**
 * Per-field-type analytics capability matrix. Drives both the builder (which
 * combos to offer) and the engine (which combos to defend against with a loud
 * `not_aggregatable` warning for stale configs).
 *
 * `aggregatable`:
 *  - 'numeric'       → sum / avg / min / max (+ count_distinct + count)
 *  - 'date'          → min / max (earliest / latest) (+ count)
 *  - 'distinct_only' → count_distinct (+ count); no sum/avg
 *  - 'none'          → count of records only
 */
import type { AppModel, FieldType, ModelField } from '../../types';
import type { AggregationType } from './types';

export interface FieldRole {
  filterable: boolean;
  groupable: boolean;
  aggregatable: 'numeric' | 'date' | 'distinct_only' | 'none';
}

const NUMERIC: ReadonlySet<FieldType> = new Set(['number', 'currency', 'formula', 'range']);
const DATE: ReadonlySet<FieldType> = new Set(['date', 'datetime']);
const CATEGORICAL: ReadonlySet<FieldType> = new Set([
  'dropdown', 'multiselect', 'lookup', 'unit_picker', 'assignee', 'checkbox', 'section_selector',
]);
const TEXTUAL: ReadonlySet<FieldType> = new Set([
  'text', 'textarea', 'email', 'phone', 'url', 'auto_id', 'multi_link',
]);
const MIRRORS: ReadonlySet<FieldType> = new Set(['mirror', 'section_mirror']);
// Display-only / binary blobs — never grouped or aggregated (count of records only).
const NON_ANALYTIC: ReadonlySet<FieldType> = new Set([
  'image', 'multi_image', 'video', 'multi_video', 'file', 'multi_file', 'attachment',
  'whatsapp_history', 'call_history', 'templates_picker', 'template_variables', 'generations_gallery',
  'notes', 'table',
]);

export function analyticsRoleFor(type: FieldType): FieldRole {
  if (NON_ANALYTIC.has(type)) return { filterable: true, groupable: false, aggregatable: 'none' };
  if (NUMERIC.has(type)) return { filterable: true, groupable: true, aggregatable: 'numeric' };
  if (DATE.has(type)) return { filterable: true, groupable: true, aggregatable: 'date' };
  if (CATEGORICAL.has(type)) return { filterable: true, groupable: true, aggregatable: 'distinct_only' };
  if (TEXTUAL.has(type)) return { filterable: true, groupable: true, aggregatable: 'distinct_only' };
  if (MIRRORS.has(type)) return { filterable: true, groupable: true, aggregatable: 'distinct_only' };
  return { filterable: true, groupable: false, aggregatable: 'none' };
}

/** Whether an aggregation TYPE can target a field of this type. `count`,
 *  `percentage`, and `ratio` are field-independent (true regardless). */
export function canAggregateFieldType(agg: AggregationType, type: FieldType): boolean {
  if (agg === 'count' || agg === 'percentage' || agg === 'ratio') return true;
  const role = analyticsRoleFor(type);
  if (agg === 'count_distinct') return role.aggregatable !== 'none';
  if (agg === 'sum' || agg === 'avg') return role.aggregatable === 'numeric';
  if (agg === 'min' || agg === 'max') return role.aggregatable === 'numeric' || role.aggregatable === 'date';
  return false;
}

// ── Schema helpers (shared by engine, adapters, builder) ────────────────────

export function flattenFields(model: AppModel): ModelField[] {
  return model.schema.sections.flatMap((s) => s.fields);
}

export function fieldMapById(model: AppModel): Map<string, ModelField> {
  const map = new Map<string, ModelField>();
  for (const f of flattenFields(model)) map.set(f.id, f);
  return map;
}

export function findFieldById(model: AppModel, fieldId: string): ModelField | undefined {
  return flattenFields(model).find((f) => f.id === fieldId);
}
