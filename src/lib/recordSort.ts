// Shared, type-aware record sorting for every table surface (the Records
// list page, the Units tab, and the read-only Related-Records tables).
//
// The whole point: sort by the value the cell DISPLAYS, not the raw stored
// value — because for several field types the stored value is an opaque id
// the user never reads (lookup/assignee → a UUID, dropdown → an option slug),
// or a structured object (range → { min, max }). Sorting those raw produces
// the "random-looking" order users complain about.
//
// Computed / rollup fields (e.g. All Projects' Project-Details fields, which
// aren't stored but are injected into `record.data` at read time by
// `useRolledUpRecordList`) sort correctly too: the caller must pass records
// whose `data` already carries the computed value, and `buildSortKey` keys
// each by its declared field type (range → lower bound, currency → numeric…).

import type { AppModel, AppRecord, ModelField, User } from '@/types';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';

export interface SortCtx {
  isAr: boolean;
  allRecords: Record<string, AppRecord[]>;
  models: AppModel[];
  users: User[];
}

/**
 * Derive a comparable key that mirrors what `DynamicCell` renders. Returns a
 * number for numeric / date / ordinal types (compared numerically), a
 * locale-comparable string otherwise, or null for blanks (always sorted last).
 */
export function buildSortKey(field: ModelField, value: unknown, ctx: SortCtx): number | string | null {
  if (value === undefined || value === null || value === '') return null;
  const { isAr, allRecords, models, users } = ctx;

  switch (field.type) {
    case 'number':
    case 'currency': {
      const n = Number(value);
      return Number.isNaN(n) ? String(value) : n;
    }

    case 'formula': {
      // Formula values are stored pre-computed. Numeric output types sort as
      // numbers; text output sorts as a string.
      if (field.formula_output_type && field.formula_output_type !== 'text') {
        const n = Number(value);
        if (!Number.isNaN(n)) return n;
      }
      return String(value);
    }

    case 'date':
    case 'datetime': {
      const t = Date.parse(String(value));
      return Number.isNaN(t) ? String(value) : t;
    }

    case 'checkbox':
      return value ? 1 : 0;

    case 'range': {
      // Sort by the lower bound (fall back to the upper bound). Also the shape
      // the All Projects *_range rollups produce.
      const r = value as { min?: number; max?: number };
      const lo = typeof r?.min === 'number' ? r.min : typeof r?.max === 'number' ? r.max : NaN;
      return Number.isNaN(lo) ? null : lo;
    }

    case 'dropdown': {
      // Sort by the option's position in the schema so status / priority
      // pipelines (Low → Medium → High) sort logically rather than by slug.
      const idx = field.options?.findIndex((o) => o.value === value) ?? -1;
      return idx >= 0 ? idx : String(value);
    }

    case 'multiselect':
    case 'section_selector': {
      const vals = Array.isArray(value) ? (value as unknown[]) : [];
      if (vals.length === 0) return null;
      const idx = field.options?.findIndex((o) => o.value === vals[0]) ?? -1;
      return idx >= 0 ? idx : String(vals[0]);
    }

    case 'lookup': {
      // Resolve the linked record's display value (the same text the cell shows)
      // and sort by that, not the stored record UUID.
      if (!field.lookup_model_id || !field.lookup_display_field) return null;
      const linked = allRecords[field.lookup_model_id] ?? [];
      const targetModel = models.find((m) => m.id === field.lookup_model_id);
      const dctx = { targetModel, allModels: models, allRecords };
      const ids = Array.isArray(value) ? (value as unknown[]) : [value];
      const labels = ids
        .map((id) => {
          const rec = linked.find((r) => r.id === id);
          if (!rec) return '';
          const dv = resolveLookupDisplayValue(rec, field.lookup_display_field!, dctx);
          return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : '';
        })
        .filter(Boolean);
      return labels.length ? labels.join(', ') : null;
    }

    case 'assignee': {
      // Sort by the assignee's name, not their UUID.
      const u = users.find((x) => x.id === value);
      return u ? (isAr ? u.name_ar : u.name_en) : null;
    }

    case 'notes':
      // Sort by entry count.
      return Array.isArray(value) ? value.length : 0;

    case 'unit_picker': {
      // Sort by the linked units' codes (same text the cell shows), not UUIDs.
      const unitModelId = field.unit_picker_unit_model_id ?? models.find((m) => m.name === 'units')?.id ?? null;
      if (!unitModelId) return null;
      const units = allRecords[unitModelId] ?? [];
      const ids = Array.isArray(value) ? (value as unknown[]) : [value];
      const labels = ids
        .map((id) => {
          const rec = units.find((r) => r.id === id);
          const dv = rec?.data['unit_code'] ?? rec?.data['unit_number'];
          return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : '';
        })
        .filter(Boolean);
      return labels.length ? labels.join(', ') : null;
    }

    default:
      // text, textarea, email, phone, url, auto_id, multi_link, etc. — natural
      // string compare (numeric:true on the comparator gives "PRJ-2" < "PRJ-10").
      return String(value);
  }
}

function findFieldByName(model: AppModel, name: string): ModelField | null {
  return model.schema.sections.flatMap((s) => s.fields).find((f) => f.name === name) ?? null;
}

/**
 * Sort records by a field SLUG, type-aware, blanks last in both directions.
 * Returns the input array UNCHANGED (same reference) when `fieldName` is null
 * or unknown — so callers keep referential stability when no sort is active.
 *
 * Uses a decorate-sort-undecorate: each row's key is built once (resolving a
 * lookup/assignee key touches other records/users — too costly to redo on
 * every O(n log n) comparison), then the cheap precomputed keys are compared.
 */
export function sortRecordsByFieldName(
  records: readonly AppRecord[],
  model: AppModel,
  fieldName: string | null | undefined,
  dir: 'asc' | 'desc',
  ctx: SortCtx,
): AppRecord[] {
  if (!fieldName) return records as AppRecord[];
  const field = findFieldByName(model, fieldName);
  // `mirror` columns aren't sortable — resolving them per-row on every compare
  // is too expensive and the UX is unclear (v1 limitation). Leave order as-is.
  if (!field || field.type === 'mirror') return records as AppRecord[];

  const decorated = records.map((r) => ({ r, key: buildSortKey(field, r.data[fieldName], ctx) }));
  decorated.sort((a, b) => {
    if (a.key === null && b.key === null) return 0;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    const cmp =
      typeof a.key === 'number' && typeof b.key === 'number'
        ? a.key - b.key
        : String(a.key).localeCompare(String(b.key), ctx.isAr ? 'ar' : 'en', { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
  return decorated.map((d) => d.r);
}
