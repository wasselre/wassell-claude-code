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

/** Schema-only resolution of a mirror field's hop: the sibling lookup, the target model, and the target field. */
export interface MirrorTarget {
  /** The sibling `lookup` field on the current model that the mirror hops through. */
  sibling: ModelField;
  /** The model the sibling lookup points at. */
  targetModel: AppModel;
  /** The field on the target model whose value the mirror surfaces. */
  targetField: ModelField;
  /**
   * How to collapse a multi-valued sibling lookup when reading the mirrored value:
   * - 'all' (default): return an array of every linked record's value — matches the scalar
   *   `mirror` field, which renders all linked values.
   * - 'first': return only the first linked record's value — matches mirrored sections and
   *   `section_mirror` fields, which render the first linked record inline.
   */
  multiMode?: 'all' | 'first';
}

/**
 * Resolve a `mirror` field's target from schema alone (no record needed). Returns null when the
 * mirror is misconfigured, the sibling/model/field can't be found, or the target is itself a mirror
 * (chained mirrors are not allowed). Used by the ad-hoc filter system to treat a mirror field as if
 * it were its target field for filtering purposes.
 */
export function resolveMirrorTarget(
  field: ModelField,
  currentModel: AppModel,
  allModels: AppModel[],
): MirrorTarget | null {
  if (field.type !== 'mirror') return null;
  if (!field.mirror_via_lookup_field_id || !field.mirror_target_field_name) return null;

  const sibling = currentModel.schema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.id === field.mirror_via_lookup_field_id);
  if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) return null;

  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id);
  if (!targetModel) return null;

  const targetField = targetModel.schema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.name === field.mirror_target_field_name) ?? null;
  if (!targetField || targetField.type === 'mirror') return null;

  return { sibling, targetModel, targetField };
}

/**
 * Resolve a mirror field's live value for one record using a precomputed {@link MirrorTarget} and a
 * prebuilt id→record index for the target model. Returns an array of values when the sibling lookup
 * is multi-valued (mirroring `resolveMirror`'s multi behavior), or a scalar otherwise. Returns
 * `undefined` when the sibling has no selection. Kept separate from `resolveMirror` so callers that
 * filter thousands of rows resolve the schema hop once and index target records once.
 */
export function resolveMirrorValueWithTarget(
  target: MirrorTarget,
  recordData: Record<string, unknown> | null | undefined,
  targetIndex: Map<string, AppRecord>,
): unknown {
  const siblingValue = recordData?.[target.sibling.name];
  if (target.sibling.is_multi) {
    const ids = Array.isArray(siblingValue)
      ? (siblingValue as unknown[]).filter((v): v is string => typeof v === 'string' && !!v)
      : [];
    if (ids.length === 0) return undefined;
    if (target.multiMode === 'first') {
      return targetIndex.get(ids[0])?.data[target.targetField.name];
    }
    return ids.map((id) => targetIndex.get(id)?.data[target.targetField.name]);
  }
  if (typeof siblingValue !== 'string' || !siblingValue) return undefined;
  return targetIndex.get(siblingValue)?.data[target.targetField.name];
}
