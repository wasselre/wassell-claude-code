import { normalizeBasic, normalizePhone } from '@/lib/similarity';
import type { AppModel, AppRecord, ModelField } from '@/types';

/** A record that already carries the same duplicate-check value as the one being saved. */
export interface DuplicateMatch {
  /** the pre-existing record that collides */
  record: AppRecord;
  /** the model's duplicate-check field (the one configured in the Builder) */
  field: ModelField;
  /** the existing record's raw value for that field — shown to the user */
  existingValue: string;
}

/**
 * Resolve a model's duplicate-check field (set in the Builder as
 * `schema.duplicate_check_field_id`). Returns null when none is configured or
 * the referenced field no longer exists. Skips mirrored (computed) sections —
 * the dedup key is always a real, stored field, mirroring the candidate set the
 * Builder offers (`duplicateCheckCandidates`).
 */
export function getDuplicateCheckField(model: AppModel): ModelField | null {
  const id = model.schema.duplicate_check_field_id;
  if (!id) return null;
  const field = model.schema.sections
    .filter((s) => !s.is_mirrored)
    .flatMap((s) => s.fields)
    .find((f) => f.id === id);
  return field ?? null;
}

/**
 * Normalize a value the same way the Import wizard's exact-duplicate path does
 * (`ImportModal` → `similarity.ts`): phone fields collapse to their last 9
 * digits (so `05x`, `5x`, `966…`, `+966…` all match), everything else lower-
 * cases + trims + collapses whitespace. Keeping this identical to import means
 * the duplicate-check field behaves the same whether a record arrives via
 * import or is typed into the form.
 */
export function normalizeForDedup(value: unknown, field: ModelField): string {
  return field.type === 'phone' ? normalizePhone(value) : normalizeBasic(value);
}

/**
 * If `model` has a duplicate-check field configured AND `data` carries a value
 * for it that exactly matches (after type-aware normalization) an existing
 * record, return the first such match. Otherwise null.
 *
 * This is the save-path counterpart to the Import wizard's exact-skip logic.
 * It is consulted before creating a record on every create path so the
 * duplicate-check field stops duplicates everywhere — not just on import.
 *
 * @param excludeId  id of the record being edited, so an in-place save of an
 *                   existing record never matches itself.
 */
export function findDuplicateRecord(
  model: AppModel,
  data: Record<string, unknown>,
  existing: AppRecord[],
  excludeId?: string,
): DuplicateMatch | null {
  const field = getDuplicateCheckField(model);
  if (!field) return null;

  const key = normalizeForDedup(data[field.name], field);
  if (!key) return null; // no value to compare → nothing to dedup against

  for (const rec of existing) {
    if (excludeId && rec.id === excludeId) continue;
    if (normalizeForDedup(rec.data[field.name], field) === key) {
      const raw = rec.data[field.name];
      return {
        record: rec,
        field,
        existingValue: raw === null || raw === undefined ? '' : String(raw),
      };
    }
  }
  return null;
}
