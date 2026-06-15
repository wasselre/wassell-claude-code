import type { AppModel, AppRecord, ModelField } from '@/types';
import { collectViewFields, readExpandedValue, VIRTUAL_FIELD_SEPARATOR } from './sectionMirrorExpand';

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
    // Rollups are STORED on the source record now (DB trigger) — raw read is live.
    const resolved = ids.map((id) => linkedRecords.find((rec) => rec.id === id) ?? null);
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

  const rawTarget = allRecords[targetModel.id]?.find((r) => r.id === siblingValue) ?? null;
  if (!rawTarget) {
    return { ...empty, status: 'target_record_missing', targetField };
  }
  // Rollups are STORED on the source record now (DB trigger) — raw read is live.
  const targetRecord = rawTarget;

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
      const firstId = ids[0];
      return firstId === undefined ? undefined : targetIndex.get(firstId)?.data[target.targetField.name];
    }
    return ids.map((id) => targetIndex.get(id)?.data[target.targetField.name]);
  }
  if (typeof siblingValue !== 'string' || !siblingValue) return undefined;
  return targetIndex.get(siblingValue)?.data[target.targetField.name];
}

/** Extra context a {@link resolveLookupDisplayValue} caller supplies so a `mirror`
 *  display field can be resolved. All three are required to resolve a mirror;
 *  when any is missing the helper degrades to the raw stored read. */
export interface LookupDisplayContext {
  /** The model the lookup points at — i.e. the model that owns the display field. */
  targetModel?: AppModel | null;
  /** Full models list, needed only to follow a mirror display field's sibling-lookup hop. */
  allModels?: AppModel[];
  /** Full records map keyed by model id, needed only to follow a mirror display field's hop. */
  allRecords?: Record<string, AppRecord[]>;
}

/**
 * Resolve the value a lookup field should DISPLAY for one linked record.
 *
 * For an ordinary (stored) display field this returns `targetRecord.data[displaySlug]`
 * — byte-for-byte the same as the old direct read every call site used to do.
 *
 * Two kinds of display field are computed, not stored, and are resolved here:
 *
 * 1. A `mirror` field (single-hop): resolved through {@link resolveMirror}, hopping
 *    the mirror's sibling lookup on the *target* model.
 * 2. A `section_mirror` CHILD field: selected in the Builder as the compound id
 *    `${containerId}::${childSlug}` (see {@link VIRTUAL_FIELD_SEPARATOR}). Resolved
 *    by expanding the target model's view fields and reading through the container's
 *    sibling lookup with {@link readExpandedValue} — e.g. a lookup → Our Projects can
 *    display `unit_count`, which Our Projects itself mirrors from All Projects.
 *
 * A multi-valued result is collapsed to a ", "-joined string so it renders as a single
 * label (display surfaces expect a scalar). A misconfigured / empty / chained source
 * yields `undefined`, letting each caller apply its own empty handling.
 *
 * Degrades gracefully: resolving either computed kind needs `targetModel` + `allModels`
 * + `allRecords` in `ctx`. When any is absent — or the display field is an ordinary
 * stored field — we fall back to the raw stored read, so callers that lack full scope
 * keep working exactly as before.
 */
export function resolveLookupDisplayValue(
  targetRecord: { data: Record<string, unknown> },
  displaySlug: string,
  ctx: LookupDisplayContext = {},
): unknown {
  const { targetModel, allModels, allRecords } = ctx;
  if (targetModel && allModels && allRecords) {
    // (2) section_mirror child — compound `${containerId}::${childSlug}` id.
    if (displaySlug.includes(VIRTUAL_FIELD_SEPARATOR)) {
      const expanded = collectViewFields(targetModel, allModels).find((ef) => ef.id === displaySlug);
      if (!expanded) return undefined;
      // readExpandedValue only reads `.data`, so the minimal targetRecord shape suffices.
      // Pass allModels (5th arg) so a child pointing at a COMPUTED rollup field (e.g.
      // all_projects.unit_count, never stored) is rolled up before it's read.
      const v = readExpandedValue(expanded, targetRecord as unknown as AppRecord, allRecords, targetModel, allModels);
      if (Array.isArray(v)) {
        return v
          .filter((x) => x !== null && x !== undefined && typeof x !== 'object')
          .map((x) => String(x))
          .join(', ');
      }
      return v;
    }
    // (1) mirror field — single-hop via the sibling lookup.
    const displayField = targetModel.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.name === displaySlug);
    if (displayField?.type === 'mirror') {
      const res = resolveMirror(displayField, targetRecord.data, allRecords, allModels);
      if (res.status !== 'ok') return undefined;
      if (Array.isArray(res.value)) {
        return res.value
          .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
          .map((v) => String(v))
          .join(', ');
      }
      return res.value;
    }
  }
  return targetRecord.data[displaySlug];
}
