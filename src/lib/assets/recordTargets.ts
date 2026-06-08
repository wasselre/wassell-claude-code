/**
 * Introspection for "Add to Record" (Image Chats v2, Part 4).
 *
 * Finds which models can accept an image (have an image/file/attachment field)
 * and which fields on a chosen model are valid targets. Single home for the
 * "what counts as an image target" predicate.
 *
 * Note: `generations_gallery` / `templates_picker` / `template_variables` are
 * NOT targets — they're marketing-operations fields that store template ids /
 * status maps / variable maps (and render from public marketing-assets URLs),
 * not Files-System `files.id`s. Only these five accept a files.id:
 *   image, multi_image, file, multi_file, attachment.
 */

import type { AppModel, FieldType } from '@/types';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';

const IMAGE_TARGET_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'image',
  'multi_image',
  'file',
  'multi_file',
  'attachment',
]);

export function isImageTargetField(type: FieldType): boolean {
  return IMAGE_TARGET_TYPES.has(type);
}

/** Custom-UI models that don't render the generic record form — never valid
 *  Add-to-Record targets even if their schema technically has a file field. */
const CUSTOM_UI_MODELS: ReadonlySet<string> = new Set(['chats', 'ai_chats', 'image_chats']);

/** Models with at least one image/file/attachment field — the model picker
 *  (Step 1). Cheap `schema.sections` scan (no mirror expansion needed here). */
export function modelsWithImageTargets(models: AppModel[]): AppModel[] {
  return models.filter(
    (m) =>
      !CUSTOM_UI_MODELS.has(m.name) &&
      m.schema.sections.some((s) => s.fields.some((f) => isImageTargetField(f.type))),
  );
}

/**
 * Local (non-mirrored) image/file/attachment fields on a model — the target
 * field picker (Step 3). Uses collectViewFields so the set matches Table View,
 * then keeps only local image targets. Mirrored children are intentionally
 * excluded: writing back through a section_mirror container is out of scope
 * for v1 (the picker shows them disabled, see AddImageToRecordModal).
 */
export function compatibleTargetFields(model: AppModel, allModels: AppModel[]): ExpandedField[] {
  return collectViewFields(model, allModels).filter(
    (ef) => ef.kind === 'local' && isImageTargetField(ef.field.type),
  );
}
