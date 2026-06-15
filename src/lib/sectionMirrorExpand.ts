import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';

export const VIRTUAL_FIELD_SEPARATOR = '::';

/**
 * A unified view of a "column" or "form field" that may be either a real field
 * on the current model OR a virtual mirrored child field sourced from another
 * model via a `section_mirror` container.
 */
export interface ExpandedField {
  /** Stable id — equals the underlying field.id for local, or `${containerId}::${childSlug}` for mirrored. */
  id: string;
  /** Display field: for mirrored children this is the SOURCE field (so type, options, etc. are correct). */
  field: ModelField;
  kind: 'local' | 'mirrored';
  /** For mirrored: the section_mirror field on the current model that brought this child in. */
  container?: ModelField;
  /** For mirrored: the source model that owns the child field. */
  sourceModel?: AppModel;
  /** For mirrored: whether the container's config marks this child editable. */
  editable?: boolean;
  /** For mirrored: whether edits sync back to the source record (vs. local overrides). */
  syncsBack?: boolean;
}

/**
 * Apply the container's edit_mode + sync_mode config to a filtered list of
 * included child fields. Shared by all section_mirror consumers so the rules
 * stay consistent between single-target and multi-target rendering.
 */
export function computeEditAndSync(
  container: ModelField,
  includedFields: ModelField[],
): { editable: Set<string>; sync: Set<string> } {
  const editMode = container.section_mirror_edit_mode ?? 'none';
  const editablePicked = new Set(container.section_mirror_editable_field_names ?? []);
  const editable = new Set<string>();
  if (editMode === 'all') includedFields.forEach((f) => editable.add(f.name));
  else if (editMode === 'custom') {
    includedFields.forEach((f) => { if (editablePicked.has(f.name)) editable.add(f.name); });
  }

  const syncMode = container.section_mirror_sync_mode ?? 'all';
  const syncPicked = new Set(container.section_mirror_sync_field_names ?? []);
  const sync = new Set<string>();
  if (editMode !== 'none') {
    if (syncMode === 'all') editable.forEach((n) => sync.add(n));
    else if (syncMode === 'custom') {
      editable.forEach((n) => { if (syncPicked.has(n)) sync.add(n); });
    }
  }

  return { editable, sync };
}

function computeInclusion(
  container: ModelField,
  sourceFields: ModelField[],
): { included: ModelField[]; editable: Set<string>; sync: Set<string> } {
  const candidates = sourceFields.filter((f) => f.type !== 'section_mirror' && f.type !== 'section_selector');
  const fieldMode = container.section_mirror_field_mode ?? 'all';
  const picked = new Set(container.section_mirror_field_names ?? []);
  const included = fieldMode === 'all' ? candidates : candidates.filter((f) => picked.has(f.name));
  const { editable, sync } = computeEditAndSync(container, included);
  return { included, editable, sync };
}

/**
 * Expand one section_mirror container into its virtual children, given the set
 * of source fields it's pointing at. Preserves source order.
 */
export function expandContainer(container: ModelField, sourceFields: ModelField[], sourceModel: AppModel): ExpandedField[] {
  const { included, editable, sync } = computeInclusion(container, sourceFields);
  return included
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((child) => ({
      id: `${container.id}${VIRTUAL_FIELD_SEPARATOR}${child.name}`,
      field: child,
      kind: 'mirrored' as const,
      container,
      sourceModel,
      editable: editable.has(child.name),
      syncsBack: sync.has(child.name),
    }));
}

/**
 * Look up the source section + source model for a section_mirror container, given
 * the current model and all models. Returns null if the config is incomplete.
 */
export function resolveContainerSource(
  container: ModelField,
  currentModel: AppModel,
  allModels: AppModel[],
): { sourceModel: AppModel; sourceFields: ModelField[] } | null {
  const viaId = container.section_mirror_via_lookup_field_id;
  const sourceSectionId = container.section_mirror_source_section_id;
  if (!viaId || !sourceSectionId) return null;
  const sibling = currentModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === viaId);
  if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) return null;
  const sourceModel = allModels.find((m) => m.id === sibling.lookup_model_id);
  if (!sourceModel) return null;
  const sourceSection = sourceModel.schema.sections.find((s) => s.id === sourceSectionId);
  if (!sourceSection) return null;
  return { sourceModel, sourceFields: sourceSection.fields };
}

/**
 * Produce a flat list of columns for views / tables: local fields (with
 * section_mirror containers themselves filtered out) plus expanded mirrored
 * children as virtual columns.
 */
export function collectViewFields(model: AppModel, allModels: AppModel[]): ExpandedField[] {
  const all = model.schema.sections.flatMap((s) => s.fields);
  const out: ExpandedField[] = [];
  for (const f of all) {
    if (f.type === 'section_mirror') {
      // Replace the container with its virtual children.
      const src = resolveContainerSource(f, model, allModels);
      if (!src) continue;
      out.push(...expandContainer(f, src.sourceFields, src.sourceModel));
    } else {
      out.push({ id: f.id, field: f, kind: 'local' });
    }
  }
  return out;
}

export type SectionMirrorMultiStatus =
  | 'ok'
  | 'not_section_mirror'
  | 'not_multi'
  | 'sibling_missing'
  | 'sibling_not_lookup'
  | 'sibling_not_selected'
  | 'target_model_missing'
  | 'target_section_missing';

export interface SectionMirrorMultiResolution {
  status: SectionMirrorMultiStatus;
  sourceSection: ModelSection | null;
  sourceModel: AppModel | null;
  sibling: ModelField | null;
  includedFields: ModelField[];
  /** Child field slugs that are editable per the container's edit_mode + editable_field_names config. */
  editableFieldNames: Set<string>;
  /** Child field slugs whose edits sync back to the target record on save (subset of editable). */
  syncFieldNames: Set<string>;
  /** One entry per ID in the sibling's value array; missing target records surface as `targetRecord: null` so the UI can render a placeholder column. */
  targets: Array<{ id: string; targetRecord: AppRecord | null }>;
}

const EMPTY_MULTI: SectionMirrorMultiResolution = {
  status: 'ok',
  sourceSection: null,
  sourceModel: null,
  sibling: null,
  includedFields: [],
  editableFieldNames: new Set(),
  syncFieldNames: new Set(),
  targets: [],
};

/**
 * Multi-project variant of the single-target section_mirror resolver used in
 * SectionBlock. Resolves every ID in the sibling lookup's value array to a
 * target record and returns them in order so callers can render one column per
 * linked project. Uses the same inclusion / edit / sync filtering as the
 * single-target path, but edit/sync aren't meaningful for multi-target (the
 * renderer is read-only).
 */
export function resolveSectionMirrorFieldMulti(
  field: ModelField,
  currentRecordData: Record<string, unknown> | null | undefined,
  currentModel: AppModel,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): SectionMirrorMultiResolution {
  if (field.type !== 'section_mirror') {
    return { ...EMPTY_MULTI, status: 'not_section_mirror' };
  }
  const viaId = field.section_mirror_via_lookup_field_id ?? null;
  const sourceSectionId = field.section_mirror_source_section_id ?? null;
  if (!viaId || !sourceSectionId) {
    return { ...EMPTY_MULTI, status: 'sibling_missing' };
  }

  const sibling =
    currentModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === viaId) ?? null;
  if (!sibling) return { ...EMPTY_MULTI, status: 'sibling_missing' };
  if (sibling.type !== 'lookup' || !sibling.lookup_model_id) {
    return { ...EMPTY_MULTI, status: 'sibling_not_lookup', sibling };
  }
  if (!sibling.is_multi) {
    return { ...EMPTY_MULTI, status: 'not_multi', sibling };
  }

  const sourceModel = allModels.find((m) => m.id === sibling.lookup_model_id) ?? null;
  if (!sourceModel) return { ...EMPTY_MULTI, status: 'target_model_missing', sibling };

  const sourceSection =
    sourceModel.schema.sections.find((s) => s.id === sourceSectionId) ?? null;
  if (!sourceSection) {
    return { ...EMPTY_MULTI, status: 'target_section_missing', sourceModel, sibling };
  }

  const includedFields = (() => {
    const candidates = [...sourceSection.fields]
      .filter((f) => f.type !== 'section_mirror' && f.type !== 'section_selector')
      .sort((a, b) => a.order - b.order);
    const fieldMode = field.section_mirror_field_mode ?? 'all';
    if (fieldMode === 'all') return candidates;
    const picked = new Set(field.section_mirror_field_names ?? []);
    return candidates.filter((f) => picked.has(f.name));
  })();

  const { editable: editableFieldNames, sync: syncFieldNames } = computeEditAndSync(field, includedFields);

  const raw = currentRecordData?.[sibling.name];
  const ids = Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string' && !!v) : [];
  if (ids.length === 0) {
    return {
      status: 'sibling_not_selected',
      sourceSection,
      sourceModel,
      sibling,
      includedFields,
      editableFieldNames,
      syncFieldNames,
      targets: [],
    };
  }

  const linked = allRecords[sourceModel.id] ?? [];
  const targets = ids.map((id) => ({ id, targetRecord: linked.find((r) => r.id === id) ?? null }));

  return {
    status: 'ok',
    sourceSection,
    sourceModel,
    sibling,
    includedFields,
    editableFieldNames,
    syncFieldNames,
    targets,
  };
}

/**
 * Read the effective value of an expanded field for a given record.
 * - local: record.data[field.name]
 * - mirrored: resolve the sibling lookup on the record → load target record →
 *   take local override if present, otherwise the target's value.
 */
export function readExpandedValue(
  rvf: ExpandedField,
  record: AppRecord,
  allRecords: Record<string, AppRecord[]>,
  currentModel: AppModel,
  // Deprecated: project rollups are STORED on the record now (DB trigger), so
  // this arg is no longer used to resolve them. Kept for positional-arg/caller
  // compatibility until callers are cleaned up.
  _allModels?: AppModel[],
): unknown {
  if (rvf.kind === 'local') return record.data[rvf.field.name];
  const container = rvf.container;
  if (!container) return undefined;
  const viaId = container.section_mirror_via_lookup_field_id;
  if (!viaId) return undefined;
  const sibling = currentModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === viaId);
  if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) return undefined;

  // Find linked record id.
  const siblingValue = record.data[sibling.name];
  let targetId: string | null = null;
  if (sibling.is_multi) {
    if (Array.isArray(siblingValue)) {
      const first = (siblingValue as unknown[]).find((v) => typeof v === 'string' && v);
      targetId = typeof first === 'string' ? first : null;
    }
  } else if (typeof siblingValue === 'string' && siblingValue) {
    targetId = siblingValue;
  }
  if (!targetId) return undefined;

  const localOverrides = (record.data[container.name] as Record<string, unknown> | undefined) ?? {};
  if (rvf.field.name in localOverrides) return localOverrides[rvf.field.name];

  const rawTarget = allRecords[sibling.lookup_model_id]?.find((r) => r.id === targetId);
  if (!rawTarget) return undefined;
  // Project rollups are STORED on the source record now (DB trigger), so a raw
  // read already returns the live value.
  return rawTarget.data[rvf.field.name];
}
