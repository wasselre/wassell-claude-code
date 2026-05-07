// Auto ID field engine: assigns auto-incrementing IDs to records on create,
// with an optional per-value-of-another-field scope (e.g. per-city counters).
//
// PHASE F.1: counter is now stored server-side in public.auto_id_counters
// (atomic INSERT...ON CONFLICT...UPDATE). The legacy JSONB counter on the
// field definition is kept as a fallback for offline mode and as historical
// record. The async `assignAutoIdsAsync()` is the canonical entry point
// used by the live save path; the sync `assignAutoIds()` is retained for
// tests, the renumber tool, and offline use.

import type { AppModel, AppRecord, ModelField } from '@/types';
import { supabase } from '@/lib/supabase';

export const GLOBAL_SCOPE_KEY = '__global__';
const UNSET_SCOPE_KEY = '__unset__';

/** Turn an arbitrary scope value into a stable, filename-safe counter key. */
function slugifyScope(v: unknown): string {
  if (v === null || v === undefined) return UNSET_SCOPE_KEY;
  if (Array.isArray(v)) {
    const nonEmpty = v.filter((x) => x !== null && x !== undefined && x !== '');
    if (nonEmpty.length === 0) return UNSET_SCOPE_KEY;
    return nonEmpty.map(slugifyScope).join('+');
  }
  const s = String(v).trim().toLowerCase();
  if (!s) return UNSET_SCOPE_KEY;
  // Preserve letters (including Arabic + other Unicode), collapse the rest to '-'.
  return s.replace(/[\s/\\,.;:]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || UNSET_SCOPE_KEY;
}

function allFieldsOf(model: AppModel): ModelField[] {
  return model.schema.sections.flatMap((s) => s.fields);
}

/** Resolve the counter key for a record given the field's scope configuration. */
export function getAutoIdScopeKey(
  field: ModelField,
  recordData: Record<string, unknown>,
  allFields: ModelField[],
): string {
  if (!field.auto_id_scope_field_id) return GLOBAL_SCOPE_KEY;
  const scopeField = allFields.find((f) => f.id === field.auto_id_scope_field_id);
  if (!scopeField) return GLOBAL_SCOPE_KEY;
  return slugifyScope(recordData[scopeField.name]);
}

/** Format a numeric counter into the display string using the field's config. */
export function formatAutoId(field: ModelField, counter: number): string {
  const prefix = field.auto_id_prefix ?? '';
  const padding = Math.max(0, field.auto_id_padding ?? 3);
  const num = padding > 0 ? String(counter).padStart(padding, '0') : String(counter);
  return `${prefix}${num}`;
}

function cloneModelWithFieldPatch(
  model: AppModel,
  fieldId: string,
  patch: Partial<ModelField>,
): AppModel {
  return {
    ...model,
    schema: {
      ...model.schema,
      sections: model.schema.sections.map((s) => ({
        ...s,
        fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)),
      })),
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Walk all `auto_id` fields on the model. For any field whose value isn't yet
 * set on `recordData`, assign the next counter value and bump the counter.
 * Returns `{ data, model }` — the model has updated counters and should be
 * persisted alongside the record.
 *
 * Callers pass `isNew: true` only for record creation. Auto IDs are immutable
 * once assigned — updates never overwrite or reassign them.
 */
export function assignAutoIds(
  model: AppModel,
  recordData: Record<string, unknown>,
  isNew: boolean,
): { data: Record<string, unknown>; model: AppModel } {
  if (!isNew) return { data: recordData, model };
  const fields = allFieldsOf(model);
  const autoIdFields = fields.filter((f) => f.type === 'auto_id');
  if (autoIdFields.length === 0) return { data: recordData, model };

  let workingModel = model;
  const workingData: Record<string, unknown> = { ...recordData };

  for (const field of autoIdFields) {
    const existing = workingData[field.name];
    if (typeof existing === 'string' && existing !== '') continue;
    const scopeKey = getAutoIdScopeKey(field, workingData, allFieldsOf(workingModel));
    const start = field.auto_id_start_value ?? 1;
    const counters = field.auto_id_counters ?? {};
    const next = counters[scopeKey] ?? start;
    workingData[field.name] = formatAutoId(field, next);
    workingModel = cloneModelWithFieldPatch(workingModel, field.id, {
      auto_id_counters: { ...counters, [scopeKey]: next + 1 },
    });
  }

  return { data: workingData, model: workingModel };
}

/**
 * Phase F.1: async assigner that calls the atomic record_assign_auto_id RPC.
 * Use this in the live save path to avoid the read-modify-write race the
 * sync version has. Falls back to the client-side counter if Supabase
 * isn't configured (offline-only mode) — duplicates remain possible there
 * but no worse than the legacy behavior.
 *
 * Returns:
 *   data           — the record data with auto_id fields populated
 *   model          — model with bumped JSONB counters when fallback fired,
 *                    same model otherwise (server-side path doesn't mutate
 *                    the model — the counter lives in auto_id_counters)
 *   usedServerCounter — true when at least one assignment came from the RPC
 */
export async function assignAutoIdsAsync(
  model: AppModel,
  recordData: Record<string, unknown>,
  isNew: boolean,
): Promise<{ data: Record<string, unknown>; model: AppModel; usedServerCounter: boolean }> {
  if (!isNew) return { data: recordData, model, usedServerCounter: false };
  const fields = allFieldsOf(model);
  const autoIdFields = fields.filter((f) => f.type === 'auto_id');
  if (autoIdFields.length === 0) return { data: recordData, model, usedServerCounter: false };

  let workingModel = model;
  const workingData: Record<string, unknown> = { ...recordData };
  let usedServerCounter = false;

  for (const field of autoIdFields) {
    const existing = workingData[field.name];
    if (typeof existing === 'string' && existing !== '') continue;
    const scopeKey = getAutoIdScopeKey(field, workingData, allFieldsOf(workingModel));
    const start = field.auto_id_start_value ?? 1;

    let counterValue: number | null = null;

    // Server-side atomic counter — the right path. Postgres serializes
    // INSERT...ON CONFLICT, so concurrent saves get distinct values.
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('record_assign_auto_id', {
          p_model_id: model.id,
          p_field_id: field.id,
          p_scope_key: scopeKey,
          p_start: start,
        });
        if (!error && typeof data === 'number') {
          counterValue = data;
          usedServerCounter = true;
        } else if (error) {
          // eslint-disable-next-line no-console
          console.warn('[auto_id] record_assign_auto_id RPC failed; falling back to client counter:', error.message);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[auto_id] record_assign_auto_id threw; falling back to client counter:', err);
      }
    }

    // Fallback: client-side counter (legacy, race-prone). Used in offline
    // mode or when the RPC is unreachable. Mutates the model JSONB so
    // saveRecord can persist the bumped counter alongside the record.
    if (counterValue === null) {
      const counters = field.auto_id_counters ?? {};
      counterValue = counters[scopeKey] ?? start;
      workingModel = cloneModelWithFieldPatch(workingModel, field.id, {
        auto_id_counters: { ...counters, [scopeKey]: counterValue + 1 },
      });
    }

    workingData[field.name] = formatAutoId(field, counterValue);
  }

  return { data: workingData, model: workingModel, usedServerCounter };
}

/** Reset counters on a single `auto_id` field without touching existing records. */
export function resetAutoIdCounters(field: ModelField, model: AppModel): AppModel {
  return cloneModelWithFieldPatch(model, field.id, { auto_id_counters: {} });
}

/**
 * Renumber every existing record under `field`, per-scope, in creation-order.
 * Returns the updated records + the model with counters advanced to reflect
 * the post-renumber state (so the NEXT new record continues the sequence).
 */
export function renumberAutoIdField(
  field: ModelField,
  model: AppModel,
  records: AppRecord[],
): { records: AppRecord[]; model: AppModel } {
  const start = field.auto_id_start_value ?? 1;
  const fields = allFieldsOf(model);
  const sorted = [...records].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const perScopeCounter = new Map<string, number>();
  const updatedRecords: AppRecord[] = sorted.map((rec) => {
    const scopeKey = getAutoIdScopeKey(field, rec.data, fields);
    const counter = perScopeCounter.get(scopeKey) ?? start;
    perScopeCounter.set(scopeKey, counter + 1);
    return {
      ...rec,
      data: { ...rec.data, [field.name]: formatAutoId(field, counter) },
      updated_at: new Date().toISOString(),
    };
  });

  const newCounters: Record<string, number> = {};
  perScopeCounter.forEach((v, k) => { newCounters[k] = v; });
  const updatedModel = cloneModelWithFieldPatch(model, field.id, { auto_id_counters: newCounters });

  // Preserve the original model order of records, not the sort-by-created_at order.
  const byId = new Map(updatedRecords.map((r) => [r.id, r]));
  const finalRecords = records.map((r) => byId.get(r.id) ?? r);
  return { records: finalRecords, model: updatedModel };
}
