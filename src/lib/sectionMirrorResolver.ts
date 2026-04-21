import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';

export type SectionMirrorStatus =
  | 'ok'
  | 'not_mirrored' // Section isn't flagged as mirrored — caller should render normally.
  | 'sibling_missing'
  | 'sibling_not_lookup'
  | 'sibling_not_selected'
  | 'target_model_missing'
  | 'target_section_missing'
  | 'target_record_missing';

export interface SectionMirrorResolution {
  status: SectionMirrorStatus;
  sourceSection: ModelSection | null;
  targetRecord: AppRecord | null;
  targetModel: AppModel | null;
  sibling: ModelField | null;
}

/**
 * Resolve a mirrored section to the record + source section that should feed its
 * fields at render time. Mirrored sections render from a linked record: pick the
 * sibling lookup, read its value off the current record, load the referenced
 * record from `allRecords`, then fetch the named section off that model.
 *
 * Single-select siblings contribute one source record. Multi-select siblings are
 * NOT supported here (section mirroring needs a single source) — the first ID is
 * used, which matches the plan's documented constraint.
 */
export function resolveSectionMirror(
  section: ModelSection,
  currentRecordData: Record<string, unknown> | null | undefined,
  currentModel: AppModel,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): SectionMirrorResolution {
  const empty: SectionMirrorResolution = {
    status: 'ok',
    sourceSection: null,
    targetRecord: null,
    targetModel: null,
    sibling: null,
  };

  if (!section.is_mirrored) {
    return { ...empty, status: 'not_mirrored' };
  }
  if (!section.mirror_via_lookup_field_id || !section.mirror_source_section_id) {
    return { ...empty, status: 'sibling_missing' };
  }

  const sibling =
    currentModel.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.id === section.mirror_via_lookup_field_id) ?? null;

  if (!sibling) return { ...empty, status: 'sibling_missing' };
  if (sibling.type !== 'lookup' || !sibling.lookup_model_id) {
    return { ...empty, status: 'sibling_not_lookup', sibling };
  }

  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id) ?? null;
  if (!targetModel) return { ...empty, status: 'target_model_missing', sibling };

  const sourceSection =
    targetModel.schema.sections.find((s) => s.id === section.mirror_source_section_id) ?? null;
  if (!sourceSection) {
    return { ...empty, status: 'target_section_missing', targetModel, sibling };
  }

  const siblingValue = currentRecordData?.[sibling.name];
  // Multi-select siblings: use first non-empty ID.
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
    return { ...empty, status: 'sibling_not_selected', sourceSection, targetModel, sibling };
  }

  const targetRecord = allRecords[targetModel.id]?.find((r) => r.id === targetId) ?? null;
  if (!targetRecord) {
    return { ...empty, status: 'target_record_missing', sourceSection, targetModel, sibling };
  }

  return {
    status: 'ok',
    sourceSection,
    targetRecord,
    targetModel,
    sibling,
  };
}
