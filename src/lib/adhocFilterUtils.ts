import type { AppRecord, ModelField } from '@/types';

/**
 * Ad-hoc (faceted) per-field filters shown in the Advanced Filter panel above the table.
 *
 * Semantics:
 * - Within a single field with multi-value picks, records pass if the field matches ANY of the
 *   picked values (OR).
 * - Across different fields, records must pass ALL field filters (AND).
 *
 * This is a different shape than the saved-view `WidgetFilterCondition[]` because the
 * view filters are AND-only and can't express "status in {A, B}" in one row.
 * The two layer together: view conditions apply first, then ad-hoc on top.
 */
export type AdhocFieldFilter =
  // dropdown, multiselect, lookup, assignee, section_selector
  // mode 'is' (default): record passes if ANY picked value is in the field.
  // mode 'is_not': record passes if NONE of the picked values is in the field
  // (records with no value for the field also pass — they have none of the picked values).
  | { kind: 'values'; values: string[]; mode?: 'is' | 'is_not' }
  | { kind: 'checkbox'; value: 'true' | 'false' }
  | { kind: 'date_range'; from?: string; to?: string }
  | { kind: 'number_range'; min?: number; max?: number }
  | { kind: 'contains'; query: string };

/** Full ad-hoc state for one (user, model, view) scope: keyed by field ID. */
export type AdhocFilterState = Record<string, AdhocFieldFilter>;

/** Which ad-hoc filter shape a given field type uses. Null = field type isn't filterable this way. */
export function adhocKindFor(fieldType: ModelField['type']): AdhocFieldFilter['kind'] | null {
  switch (fieldType) {
    case 'dropdown':
    case 'multiselect':
    case 'section_selector':
    case 'lookup':
    case 'assignee':
      return 'values';
    case 'checkbox':
      return 'checkbox';
    case 'date':
    case 'datetime':
      return 'date_range';
    case 'number':
    case 'currency':
      return 'number_range';
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'url':
      return 'contains';
    // notes and range are structured — not exposed in the simple ad-hoc panel.
    case 'notes':
    case 'range':
      return null;
    default:
      return null;
  }
}

/** True if the filter has any meaningful selection (affects the result set). */
export function isAdhocActive(filter: AdhocFieldFilter | undefined): boolean {
  if (!filter) return false;
  switch (filter.kind) {
    case 'values':
      return filter.values.length > 0;
    case 'checkbox':
      return true;
    case 'date_range':
      return !!(filter.from || filter.to);
    case 'number_range':
      return filter.min != null || filter.max != null;
    case 'contains':
      return filter.query.trim().length > 0;
  }
}

function evaluateAdhoc(recordValue: unknown, filter: AdhocFieldFilter): boolean {
  switch (filter.kind) {
    case 'values': {
      if (filter.values.length === 0) return true;
      const isNot = filter.mode === 'is_not';
      let matched: boolean;
      if (Array.isArray(recordValue)) {
        // multiselect / section_selector — "is" passes when ANY picked value is in the array
        matched = (recordValue as unknown[]).some((v) => filter.values.includes(String(v)));
      } else if (recordValue === undefined || recordValue === null) {
        // no value: doesn't match any picked value → fail under "is", pass under "is_not"
        matched = false;
      } else {
        matched = filter.values.includes(String(recordValue));
      }
      return isNot ? !matched : matched;
    }
    case 'checkbox':
      return String(!!recordValue) === filter.value;
    case 'date_range': {
      if (!filter.from && !filter.to) return true;
      if (recordValue === undefined || recordValue === null || recordValue === '') return false;
      const t = new Date(String(recordValue)).getTime();
      if (Number.isNaN(t)) return false;
      if (filter.from && t < new Date(filter.from).getTime()) return false;
      if (filter.to) {
        // Inclusive: treat to as end-of-day if the string is a date only
        const toRaw = filter.to.length <= 10 ? `${filter.to}T23:59:59.999` : filter.to;
        if (t > new Date(toRaw).getTime()) return false;
      }
      return true;
    }
    case 'number_range': {
      if (filter.min == null && filter.max == null) return true;
      const n = Number(recordValue);
      if (Number.isNaN(n)) return false;
      if (filter.min != null && n < filter.min) return false;
      if (filter.max != null && n > filter.max) return false;
      return true;
    }
    case 'contains': {
      if (!filter.query.trim()) return true;
      return String(recordValue ?? '').toLowerCase().includes(filter.query.toLowerCase());
    }
  }
}

/** Filter records by ad-hoc per-field filters (AND between fields). */
export function applyAdhocFilters(
  records: AppRecord[],
  state: AdhocFilterState,
  allFields: ModelField[],
): AppRecord[] {
  const activeEntries = Object.entries(state).filter(([, f]) => isAdhocActive(f));
  if (activeEntries.length === 0) return records;
  return records.filter((rec) =>
    activeEntries.every(([fieldId, filter]) => {
      const field = allFields.find((f) => f.id === fieldId);
      if (!field) return true;
      return evaluateAdhoc(rec.data[field.name], filter);
    }),
  );
}

/** localStorage key for a (user, model, view) scope. */
export function adhocStorageKey(modelId: string, userId: string, viewId: string | null): string {
  return `wassell_adhoc_${modelId}_${userId}_${viewId ?? 'default'}`;
}

export function loadAdhocFilters(key: string): AdhocFilterState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function saveAdhocFilters(key: string, state: AdhocFilterState): void {
  try {
    // Drop inactive entries so the stored state stays clean.
    const clean: AdhocFilterState = {};
    for (const [fieldId, filter] of Object.entries(state)) {
      if (isAdhocActive(filter)) clean[fieldId] = filter;
    }
    if (Object.keys(clean).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(clean));
    }
  } catch {
    // full / unavailable — ignore
  }
}

/** Short human summary of an active filter, e.g. "A, B, +2" or "≥ 100" or "contains foo". */
export function summarizeAdhoc(
  filter: AdhocFieldFilter,
  field: ModelField,
  isAr: boolean,
  lookup?: {
    records: AppRecord[];
    displayField: string | null;
  },
  users?: { id: string; name_ar: string; name_en: string }[],
): string {
  switch (filter.kind) {
    case 'values': {
      if (filter.values.length === 0) return '';
      const labels = filter.values.map((v) => {
        if (field.type === 'lookup' && lookup) {
          const rec = lookup.records.find((r) => r.id === v);
          if (rec && lookup.displayField) {
            return String(rec.data[lookup.displayField] ?? v);
          }
          return v;
        }
        if (field.type === 'assignee' && users) {
          const u = users.find((x) => x.id === v);
          if (u) return isAr ? u.name_ar : u.name_en;
        }
        const opt = field.options?.find((o) => o.value === v);
        if (opt) return isAr ? opt.label_ar : opt.label_en;
        return v;
      });
      const joined = labels.length <= 2
        ? labels.join(isAr ? '، ' : ', ')
        : `${labels.slice(0, 2).join(isAr ? '، ' : ', ')} +${labels.length - 2}`;
      return filter.mode === 'is_not' ? `≠ ${joined}` : joined;
    }
    case 'checkbox':
      return filter.value === 'true' ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No');
    case 'date_range': {
      if (filter.from && filter.to) return `${filter.from} → ${filter.to}`;
      if (filter.from) return `≥ ${filter.from}`;
      if (filter.to) return `≤ ${filter.to}`;
      return '';
    }
    case 'number_range': {
      if (filter.min != null && filter.max != null) return `${filter.min} – ${filter.max}`;
      if (filter.min != null) return `≥ ${filter.min}`;
      if (filter.max != null) return `≤ ${filter.max}`;
      return '';
    }
    case 'contains':
      return filter.query;
  }
}
