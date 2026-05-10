import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, ModelField } from '@/types';

interface UseAutoFillArgs {
  model: AppModel | null | undefined;
  formData: Record<string, unknown>;
  /** React useState dispatcher; used in functional form to avoid clobbering concurrent edits. */
  setFormData: Dispatch<SetStateAction<Record<string, unknown>>>;
}

/**
 * Wires the `auto_fill_from_lookup_field_id` primitive. For every field
 * declaring an auto-fill source, this hook watches the referenced lookup
 * field's value and copies the linked record's
 * `auto_fill_source_field_name` value into THIS field — but only when:
 *
 *   1. the lookup id is set, AND
 *   2. either this field is empty OR we previously filled it from a
 *      DIFFERENT lookup id (so the user's manual override on the same
 *      linked record survives until they pick a different record).
 *
 * Different from `mirror`: mirror is read-only and re-resolves at render
 * time. Auto-fill writes once per lookup change and the user can edit
 * the value freely afterwards.
 *
 * Reads the linked record from the in-memory store (`records[modelId]`)
 * — no Supabase call. The store is hydrated on init via the
 * `unified_records` view, so frozen and unfrozen target models work
 * the same way without a branch.
 */
export function useAutoFill({ model, formData, setFormData }: UseAutoFillArgs): void {
  const records = useAppStore((s) => s.records);

  // Per-target-field memory of which lookup id last filled it. If the
  // current lookup id matches what we recorded, we leave the user's
  // edits alone; if it changed, we re-fill.
  const lastFilledFromLookupId = useRef<Map<string, string>>(new Map());

  const allFields = model
    ? model.schema.sections.filter((s) => !s.is_mirrored).flatMap((s) => s.fields)
    : [];
  const fieldsById = new Map<string, ModelField>(allFields.map((f) => [f.id, f]));

  // Stable signature over only the lookup values referenced as sources.
  const lookupValuesSig = JSON.stringify(
    allFields
      .filter((f) => f.auto_fill_from_lookup_field_id)
      .map((f) => {
        const src = fieldsById.get(f.auto_fill_from_lookup_field_id ?? '');
        return [f.id, src ? formData[src.name] ?? null : null] as const;
      }),
  );

  useEffect(() => {
    if (!model) return;
    // Compute the diff using the closure-captured formData first; if any
    // assignment is needed, apply it via the functional updater so unrelated
    // edits the user made between effect-fire and state-commit are preserved.
    const fieldsToFill: Array<{ name: string; sourceVal: unknown; lookupId: string; fieldId: string }> = [];

    for (const f of allFields) {
      if (!f.auto_fill_from_lookup_field_id || !f.auto_fill_source_field_name) continue;
      const lookupField = fieldsById.get(f.auto_fill_from_lookup_field_id);
      if (!lookupField || lookupField.type !== 'lookup' || !lookupField.lookup_model_id) continue;

      const linkedId = formData[lookupField.name];
      if (typeof linkedId !== 'string' || !linkedId) {
        // Lookup cleared — forget the last-fill record so a future re-pick
        // of the same id will refill correctly.
        lastFilledFromLookupId.current.delete(f.id);
        continue;
      }

      const lastFromId = lastFilledFromLookupId.current.get(f.id);
      const currentValue = formData[f.name];
      const isEmpty = currentValue === undefined || currentValue === null || currentValue === '';

      if (!isEmpty && lastFromId === linkedId) {
        // User has edited the field for THIS linked record — leave alone.
        continue;
      }

      const linkedRecord = (records[lookupField.lookup_model_id] ?? []).find(
        (r) => r.id === linkedId,
      );
      if (!linkedRecord) continue;

      const sourceVal = linkedRecord.data[f.auto_fill_source_field_name];
      if (sourceVal === undefined || sourceVal === null) continue;

      if (currentValue === sourceVal) {
        // Already in sync — just record provenance so subsequent edits stick.
        lastFilledFromLookupId.current.set(f.id, linkedId);
        continue;
      }

      fieldsToFill.push({ name: f.name, sourceVal, lookupId: linkedId, fieldId: f.id });
    }

    if (fieldsToFill.length === 0) return;
    setFormData((prev) => {
      const out = { ...prev };
      for (const f of fieldsToFill) {
        out[f.name] = f.sourceVal;
        lastFilledFromLookupId.current.set(f.fieldId, f.lookupId);
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupValuesSig, model?.id]);
}
