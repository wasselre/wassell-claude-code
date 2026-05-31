import type { AppModel, AppRecord, ModelField } from '@/types';

export type MirrorStatus =
  | 'ok'
  | 'sibling_missing'
  | 'sibling_not_lookup'
  | 'target_model_missing'
  | 'target_field_missing'
  | 'target_record_missing'
  | 'sibling_not_selected'
  | 'chained_not_allowed';

export interface MirrorResolution {
  status: MirrorStatus;
  value: unknown;
  targetField: ModelField | null;
  targetRecord: AppRecord | null;
}

/**
 * Resolve a `mirror` field's live value by hopping through a sibling `lookup` field
 * on the same record. Returns a structured result so callers can format / warn.
 *
 * Scope: NO data is stored for mirror fields — everything is derived at call time.
 * Chained mirrors (mirror → mirror) are forbidden.
 */
export function resolveMirror(
  field: ModelField,
  recordData: Record<string, unknown> | null | undefined,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): MirrorResolution {
  const empty: MirrorResolution = { status: 'ok', value: undefined, targetField: null, targetRecord: null };

  if (!field.mirror_via_lookup_field_id || !field.mirror_target_field_name) {
    return { ...empty, status: 'sibling_missing' };
  }

  const currentModel = allModels.find((m) =>
    m.schema.sections.some((s) => s.fields.some((f) => f.id === field.id)),
  );
  const sibling = currentModel?.schema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.id === field.mirror_via_lookup_field_id);

  if (!sibling) return { ...empty, status: 'sibling_missing' };
  if (sibling.type !== 'lookup' || !sibling.lookup_model_id) {
    return { ...empty, status: 'sibling_not_lookup' };
  }

  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id);
  if (!targetModel) return { ...empty, status: 'target_model_missing' };

  const targetField =
    targetModel.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.name === field.mirror_target_field_name) ?? null;
  if (!targetField) return { ...empty, status: 'target_field_missing' };
  if (targetField.type === 'mirror') {
    return { ...empty, status: 'chained_not_allowed', targetField };
  }

  const siblingValue = recordData?.[sibling.name];

  // Multi-select sibling lookup: resolve each ID → array of target values.
  if (sibling.is_multi) {
    const ids = Array.isArray(siblingValue) ? (siblingValue as string[]).filter((v) => typeof v === 'string' && v) : [];
    if (ids.length === 0) return { ...empty, status: 'sibling_not_selected', targetField };
    const linkedRecords = allRecords[targetModel.id] ?? [];
    const resolved = ids.map((id) => linkedRecords.find((r) => r.id === id) ?? null);
    // If every referenced record is missing, flag target_record_missing; otherwise return what we have.
    if (resolved.every((r) => !r)) {
      return { ...empty, status: 'target_record_missing', targetField };
    }
    return {
      status: 'ok',
      value: resolved.map((r) => (r ? r.data[targetField.name] : undefined)),
      targetField,
      targetRecord: resolved.find((r) => !!r) ?? null,
    };
  }

  // Single-select sibling lookup: one target record.
  if (!siblingValue || typeof siblingValue !== 'string') {
    return { ...empty, status: 'sibling_not_selected', targetField };
  }

  const targetRecord = allRecords[targetModel.id]?.find((r) => r.id === siblingValue) ?? null;
  if (!targetRecord) {
    return { ...empty, status: 'target_record_missing', targetField };
  }

  return {
    status: 'ok',
    value: targetRecord.data[targetField.name],
    targetField,
    targetRecord,
  };
}

/**
 * Schema-only resolution of a `mirror` field's target field definition — no
 * record needed. Walks mirror → sibling lookup → lookup's target model → the
 * named field, and returns that `ModelField` (or null if the mirror is
 * misconfigured / the sibling isn't a lookup / the target field is gone).
 *
 * Used by the Map Builder to decide whether a mirror field can serve as a
 * location source (i.e. it ultimately surfaces a url/text field holding a
 * Google Maps link). Kept separate from `resolveMirror` because that one needs
 * a record's data to read the live value; here we only care about the type.
 */
export function resolveMirrorTargetField(
  field: ModelField,
  currentModel: AppModel,
  allModels: AppModel[],
): ModelField | null {
  if (field.type !== 'mirror' || !field.mirror_via_lookup_field_id || !field.mirror_target_field_name) {
    return null;
  }
  const sibling = currentModel.schema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.id === field.mirror_via_lookup_field_id);
  if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) return null;
  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id);
  if (!targetModel) return null;
  return (
    targetModel.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.name === field.mirror_target_field_name) ?? null
  );
}
