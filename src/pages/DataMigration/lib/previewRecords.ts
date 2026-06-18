import type { AppRecord, ModelField } from '@/types';

/**
 * Resolve a stored record value to a human-readable display string for the
 * preview table — dropdown → option label, lookup → target record's display,
 * multiselect → joined labels, range → lo–hi, checkbox → yes/no. So the user
 * reviews recognizable values, not slugs/UUIDs.
 *
 * `pendingLabels` maps a not-yet-created lookup record's temp id → its display
 * label, so a "create new developer" decision shows the real name in preview
 * even though the record doesn't exist yet.
 */
export function resolveDisplay(
  field: ModelField,
  value: unknown,
  allRecords: Record<string, AppRecord[]>,
  pendingLabels: Map<string, string>,
  isAr: boolean,
): string {
  if (value === null || value === undefined || value === '') return '';
  switch (field.type) {
    case 'dropdown': {
      const opt = field.options?.find((o) => o.value === value);
      return opt ? (isAr ? opt.label_ar : opt.label_en) : String(value);
    }
    case 'multiselect':
    case 'section_selector': {
      if (!Array.isArray(value)) return String(value);
      return value
        .map((v) => {
          const opt = field.options?.find((o) => o.value === v);
          return opt ? (isAr ? opt.label_ar : opt.label_en) : String(v);
        })
        .join('، ');
    }
    case 'lookup': {
      const ids = Array.isArray(value) ? value : [value];
      const modelId = field.lookup_model_id;
      const disp = field.lookup_display_field;
      const pool = modelId ? allRecords[modelId] ?? [] : [];
      return ids
        .map((id) => {
          const rec = pool.find((r) => r.id === id);
          const d = rec && disp ? rec.data[disp] : undefined;
          if (d) return String(d);
          const pending = pendingLabels.get(String(id));
          return pending ?? String(id);
        })
        .join('، ');
    }
    case 'range': {
      const r = value as { min?: number; max?: number } | null;
      if (r && typeof r === 'object') {
        const lo = r.min ?? '';
        const hi = r.max ?? '';
        return lo !== '' || hi !== '' ? `${lo}–${hi}` : '';
      }
      return String(value);
    }
    case 'checkbox':
      return value ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No');
    case 'table': {
      if (!Array.isArray(value)) return String(value);
      const cols = field.table_columns ?? [];
      const first = cols[0]?.name;
      const vals = first
        ? value.map((r) => (r && typeof r === 'object' ? String((r as Record<string, unknown>)[first] ?? '') : '')).filter(Boolean)
        : [];
      if (vals.length > 0) return vals.join('، ');
      return `${value.length} ${isAr ? 'صف' : 'rows'}`;
    }
    default:
      return String(value);
  }
}
