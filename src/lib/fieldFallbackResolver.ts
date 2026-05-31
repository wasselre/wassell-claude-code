// Field "fallback when empty" resolver.
//
// Users configure `fallback_source_field_id` on a target field in the Model
// Builder. At save time, if the target field's value is empty, the system
// copies the referenced source field's current value into it. The copied
// value becomes real data on the record — the user can edit it later.
//
// Runs in `appStore.saveRecord` BETWEEN auto_id assignment and formula
// compute, so:
//   - auto_id → fallback  means fallbacks can target a just-assigned `CLT-0001`
//   - fallback → formula  means formulas that reference the target see the
//                          filled-in value, not the original empty
//
// Lookup sources: the stored value is a UUID (or array of UUIDs for multi).
// Copying raw UUIDs into a text field would just move the UUID problem, so
// lookup sources resolve to the linked record's `lookup_display_field` value.
// If that value is also empty or the linked record is missing, the fallback
// skips (leave target empty rather than write a UUID).
//
// Single pass — no chain resolution. If the source field is ALSO a fallback
// target and still empty, we skip rather than recurse. Keeps semantics
// predictable and avoids cycle handling.

import type { AppModel, ModelField } from '@/types';

/** Minimal record shape needed by the lookup-source resolver. */
export interface FallbackResolverRecord {
  id: string;
  data: Record<string, unknown>;
}

/** Reader the caller provides to look up records in OTHER models for lookup-source resolution. */
export type RecordDataReader = (modelId: string) => FallbackResolverRecord[];

function allFieldsOf(model: AppModel): ModelField[] {
  return model.schema.sections.flatMap((s) => s.fields);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// Source field types that resolve in a different phase of the save pipeline
// (formula) or at render time (mirror / section_mirror). Allowing these as
// fallback sources creates ordering issues — formula snapshots haven't been
// computed yet when fallbacks run, and mirror values aren't stored at all.
const DISALLOWED_SOURCE_TYPES = new Set<ModelField['type']>([
  'formula',
  'mirror',
  'section_mirror',
]);

/** Resolve a lookup source's stored UUID(s) to the linked record's display value.
 *
 * If the lookup's `lookup_display_field` is itself a `mirror` on the target model,
 * its value is computed at render time and not stored, so the raw read below is
 * empty and the fallback safely SKIPS (leaves the target empty — never writes a
 * UUID or junk). Resolving a mirror here would need the full models list + records
 * map, which this save-time pass deliberately doesn't carry; skipping is the safe
 * v1 behavior for this niche combination. */
function resolveLookupDisplay(
  sourceField: ModelField,
  sourceValue: unknown,
  getRecords: RecordDataReader,
): unknown {
  if (!sourceField.lookup_model_id || !sourceField.lookup_display_field) return undefined;
  const linked = getRecords(sourceField.lookup_model_id);
  const displayFieldName = sourceField.lookup_display_field;

  const resolveOne = (id: unknown): unknown => {
    if (typeof id !== 'string' || !id) return undefined;
    const rec = linked.find((r) => r.id === id);
    if (!rec) return undefined;
    const dv = rec.data[displayFieldName];
    return isEmpty(dv) ? undefined : dv;
  };

  if (Array.isArray(sourceValue)) {
    const resolved = sourceValue.map(resolveOne).filter((v) => v !== undefined);
    return resolved.length > 0 ? resolved : undefined;
  }
  return resolveOne(sourceValue);
}

/**
 * Walk every field on the model with `fallback_source_field_id` set. For each
 * target whose current value is empty, resolve the source field's value and
 * copy it in. Returns new data — does not mutate input.
 */
export function applyFieldFallbacks(
  model: AppModel,
  recordData: Record<string, unknown>,
  getRecords: RecordDataReader,
): Record<string, unknown> {
  const fields = allFieldsOf(model);
  const targets = fields.filter((f) => !!f.fallback_source_field_id);
  if (targets.length === 0) return recordData;

  const working: Record<string, unknown> = { ...recordData };

  for (const target of targets) {
    if (!isEmpty(working[target.name])) continue;

    const source = fields.find((f) => f.id === target.fallback_source_field_id);
    if (!source) continue;
    if (source.id === target.id) continue;
    if (DISALLOWED_SOURCE_TYPES.has(source.type)) continue;

    const rawSourceValue = working[source.name];
    if (isEmpty(rawSourceValue)) continue;

    const resolvedValue = source.type === 'lookup'
      ? resolveLookupDisplay(source, rawSourceValue, getRecords)
      : rawSourceValue;

    if (isEmpty(resolvedValue)) continue;

    working[target.name] = resolvedValue;
  }

  return working;
}
