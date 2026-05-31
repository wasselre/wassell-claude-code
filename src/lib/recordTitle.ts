import type { AppModel, AppRecord, ModelField } from '@/types';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';

/**
 * Resolve a human-readable title for a record, handling the same field types
 * the Builder exposes as a title candidate: text, textarea, number, and
 * lookup. Lookup fields store a UUID pointing at another model's record —
 * this helper follows the reference and returns the display field's value.
 *
 * Returns `null` when nothing readable can be produced. Callers supply the
 * full records map so the helper can dereference lookups.
 *
 * Fallback strategy (in order):
 *   1. `model.card_config.title_field_id` if the field still exists and
 *      resolves to a non-empty value (most common case).
 *   2. First field in the model whose type is text/textarea/number/lookup
 *      and resolves to a non-empty value. This covers the Builder-drift
 *      case where title_field_id references a deleted field.
 *   3. null — caller renders an "(untitled)" placeholder.
 */
export function resolveRecordTitle(
  model: AppModel,
  rec: AppRecord,
  records: Record<string, AppRecord[]>,
  allModels?: AppModel[],
): string | null {
  const allFields = model.schema.sections.flatMap((s) => s.fields);

  const titleId = model.card_config.title_field_id;
  const titleField = titleId ? allFields.find((f) => f.id === titleId) ?? null : null;
  if (titleField) {
    const v = readField(titleField, rec, records, allModels);
    if (v !== null) return v;
  }

  for (const f of allFields) {
    if (f.type !== 'text' && f.type !== 'textarea' && f.type !== 'number' && f.type !== 'lookup') continue;
    const v = readField(f, rec, records, allModels);
    if (v !== null) return v;
  }

  return null;
}

function readField(
  field: ModelField,
  rec: AppRecord,
  records: Record<string, AppRecord[]>,
  allModels?: AppModel[],
): string | null {
  const raw = rec.data[field.name];
  if (raw === undefined || raw === null || raw === '') return null;

  if (field.type === 'text' || field.type === 'textarea') {
    return typeof raw === 'string' && raw.trim() ? raw : null;
  }

  if (field.type === 'number') {
    if (typeof raw === 'number') return String(raw);
    if (typeof raw === 'string' && raw.trim()) return raw;
    return null;
  }

  if (field.type === 'lookup') {
    // is_multi lookups store an array of ids; pick the first.
    const targetId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof targetId !== 'string' || !targetId) return null;
    const targetModelId = field.lookup_model_id;
    const displaySlug = field.lookup_display_field;
    if (!targetModelId || !displaySlug) return null;
    const target = (records[targetModelId] ?? []).find((r) => r.id === targetId);
    if (!target) return null;
    // `displaySlug` may name a mirror field on the target model (computed at
    // runtime); resolve it when the full models list is available, else read raw.
    const v = resolveLookupDisplayValue(target, displaySlug, {
      targetModel: allModels?.find((m) => m.id === targetModelId),
      allModels,
      allRecords: records,
    });
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
    return null;
  }

  return null;
}
