import { computeEditAndSync } from './sectionMirrorExpand';
import { rollupRecordForMirror } from './ourProjectsRollup';
import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';

export type SectionMirrorFieldStatus =
  | 'ok'
  | 'not_section_mirror'
  | 'sibling_missing'
  | 'sibling_not_lookup'
  | 'sibling_not_selected'
  | 'target_model_missing'
  | 'target_section_missing'
  | 'target_record_missing';

export interface SectionMirrorFieldResolution {
  status: SectionMirrorFieldStatus;
  sourceSection: ModelSection | null;
  targetRecord: AppRecord | null;
  targetModel: AppModel | null;
  sibling: ModelField | null;
  /** Child fields filtered by the field_mode + field_names config. In source order. */
  includedFields: ModelField[];
  /** Set of field slugs that are editable per the edit_mode + editable_field_names config. */
  editableFieldNames: Set<string>;
  /** Set of field slugs whose edits sync back to the source record on save. */
  syncFieldNames: Set<string>;
}

const EMPTY: SectionMirrorFieldResolution = {
  status: 'ok',
  sourceSection: null,
  targetRecord: null,
  targetModel: null,
  sibling: null,
  includedFields: [],
  editableFieldNames: new Set(),
  syncFieldNames: new Set(),
};

/**
 * Resolve a `section_mirror` field against the current record: follow the sibling
 * lookup to the source record, load the named source section from the linked model,
 * and apply the field-mode / edit-mode / sync-mode filters to produce the list of
 * child fields to render plus their editability and sync-back rules.
 *
 * Child fields whose type is itself `section_mirror` or `section_selector` are
 * always excluded (they're model-local concepts that don't make sense mirrored).
 */
export function resolveSectionMirrorField(
  field: ModelField,
  currentRecordData: Record<string, unknown> | null | undefined,
  currentModel: AppModel,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): SectionMirrorFieldResolution {
  if (field.type !== 'section_mirror') {
    return { ...EMPTY, status: 'not_section_mirror' };
  }

  const viaId = field.section_mirror_via_lookup_field_id ?? null;
  const sourceSectionId = field.section_mirror_source_section_id ?? null;
  if (!viaId || !sourceSectionId) {
    return { ...EMPTY, status: 'sibling_missing' };
  }

  const sibling = currentModel.schema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.id === viaId) ?? null;
  if (!sibling) return { ...EMPTY, status: 'sibling_missing' };
  if (sibling.type !== 'lookup' || !sibling.lookup_model_id) {
    return { ...EMPTY, status: 'sibling_not_lookup', sibling };
  }

  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id) ?? null;
  if (!targetModel) return { ...EMPTY, status: 'target_model_missing', sibling };

  const sourceSection = targetModel.schema.sections.find((s) => s.id === sourceSectionId) ?? null;
  if (!sourceSection) {
    return { ...EMPTY, status: 'target_section_missing', targetModel, sibling };
  }

  // Figure out the linked record id from the sibling value.
  const siblingValue = currentRecordData?.[sibling.name];
  let targetId: string | null = null;
  if (sibling.is_multi) {
    if (Array.isArray(siblingValue)) {
      const first = (siblingValue as unknown[]).find((v) => typeof v === 'string' && v);
      targetId = typeof first === 'string' ? first : null;
    }
  } else if (typeof siblingValue === 'string' && siblingValue) {
    targetId = siblingValue;
  }

  if (!targetId) {
    return { ...EMPTY, status: 'sibling_not_selected', sourceSection, targetModel, sibling };
  }

  const rawTarget = allRecords[targetModel.id]?.find((r) => r.id === targetId) ?? null;
  if (!rawTarget) {
    return { ...EMPTY, status: 'target_record_missing', sourceSection, targetModel, sibling };
  }
  // Roll up the source record so mirrored COMPUTED fields (e.g. all_projects'
  // unit rollups) surface their live values — they're never stored, so a raw
  // read would show empty. Identity for non-rollup source models.
  const targetRecord = rollupRecordForMirror(rawTarget, targetModel, allModels, allRecords);

  // Apply field-mode filter.
  const candidates = [...sourceSection.fields]
    .filter((f) => f.type !== 'section_mirror' && f.type !== 'section_selector')
    .sort((a, b) => a.order - b.order);
  const fieldMode = field.section_mirror_field_mode ?? 'all';
  const pickedNames = new Set(field.section_mirror_field_names ?? []);
  const includedFields = fieldMode === 'all'
    ? candidates
    : candidates.filter((f) => pickedNames.has(f.name));

  // Apply edit-mode + sync-mode filters via the shared helper.
  const { editable: editableFieldNames, sync: syncFieldNames } = computeEditAndSync(field, includedFields);

  return {
    status: 'ok',
    sourceSection,
    targetRecord,
    targetModel,
    sibling,
    includedFields,
    editableFieldNames,
    syncFieldNames,
  };
}
