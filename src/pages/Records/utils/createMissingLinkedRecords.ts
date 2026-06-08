import { v4 as uuid } from 'uuid';
import { normalizePhone } from '@/lib/phone';
import type { AppModel, AppRecord, SaveRecordOpts, SaveResult } from '@/types';

/** One record that was created (or matched) so the form can link + announce it. */
export interface CreatedLinkedRecord {
  /** id of the newly-created target record */
  id: string;
  /** human label for the confirmation popup (the copied name, else the matched value) */
  label: string;
  /** target model id the record was created in */
  modelId: string;
}

export interface CreateMissingResult {
  /** lookup-field slug → resolved record id. Merge into the saved record's data. */
  patch: Record<string, unknown>;
  /** records actually CREATED (not pre-existing matches) — drives the popup. */
  created: CreatedLinkedRecord[];
}

type SaveRecordFn = (record: AppRecord, opts?: SaveRecordOpts) => Promise<SaveResult>;

interface CreateMissingArgs {
  model: AppModel;
  /** the final form values being saved */
  formData: Record<string, unknown>;
  /** in-memory store records keyed by model id (hydrated on init) */
  records: Record<string, AppRecord[]>;
  /** the store's saveRecord action */
  saveRecord: SaveRecordFn;
}

/** Normalize a value for comparison the same way the field's auto_link_normalize asks. */
function normalizeFor(value: unknown, normalize: 'phone' | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (normalize === 'phone') return normalizePhone(String(value));
  const t = String(value).trim();
  return t || null;
}

/**
 * Save-time companion to the `useAutoLink` hook. For every field on `model`
 * configured with `auto_link_create_if_missing` + `auto_link_create_timing:'on_save'`,
 * this resolves the sibling lookup at COMMIT time rather than while typing:
 *
 *   1. If the lookup field is already set (the user picked one, or useAutoLink
 *      matched an existing record while typing) → do nothing.
 *   2. Otherwise normalize the source value (e.g. phone) and search the target
 *      model's in-memory records for an exact normalized match. The store is
 *      fully hydrated on init, so this is the same record set the picker sees.
 *      - Match found → link it (no create).
 *      - No match AND the value clears `auto_link_create_min_length` → CREATE a
 *        new target record carrying the matched value PLUS any
 *        `auto_link_create_copy_fields` (e.g. visit `name` → client `client_name`),
 *        link it, and report it for the popup.
 *
 * Returns the lookup patch to merge into the record being saved and the list of
 * created records. Creating BEFORE the parent save means the link is attached in
 * a single write — and because creation only happens here (not on keystroke), a
 * half-typed phone never spawns a stray client.
 */
export async function createMissingLinkedRecords({
  model,
  formData,
  records,
  saveRecord,
}: CreateMissingArgs): Promise<CreateMissingResult> {
  const patch: Record<string, unknown> = {};
  const created: CreatedLinkedRecord[] = [];

  const allFields = model.schema.sections
    .filter((s) => !s.is_mirrored)
    .flatMap((s) => s.fields);
  const fieldsById = new Map(allFields.map((f) => [f.id, f]));

  for (const f of allFields) {
    if (!f.auto_link_create_if_missing || f.auto_link_create_timing !== 'on_save') continue;
    if (!f.auto_link_lookup_field_id || !f.auto_link_target_field_name) continue;

    const lookupField = fieldsById.get(f.auto_link_lookup_field_id);
    if (!lookupField || lookupField.type !== 'lookup' || !lookupField.lookup_model_id) continue;
    if (lookupField.is_multi) continue; // single-link only (e.g. client_id)

    // Already linked (user pick or while-typing match) → nothing to create.
    const currentLookup = formData[lookupField.name];
    if (typeof currentLookup === 'string' && currentLookup) continue;

    const needle = normalizeFor(formData[f.name], f.auto_link_normalize);
    if (!needle) continue;
    const minLen = f.auto_link_create_min_length ?? 0;
    if (needle.length < minLen) continue;

    const targetModelId = lookupField.lookup_model_id;
    const targetField = f.auto_link_target_field_name;
    const targetRecords = records[targetModelId] ?? [];

    // Exact normalized match against the hydrated store — dup-safe.
    const match = targetRecords.find(
      (r) => normalizeFor(r.data[targetField], f.auto_link_normalize) === needle,
    );
    if (match) {
      patch[lookupField.name] = match.id;
      continue;
    }

    // No match → create a new minimal target record.
    const data: Record<string, unknown> = { [targetField]: needle };
    for (const cp of f.auto_link_create_copy_fields ?? []) {
      const sv = formData[cp.from];
      if (sv !== undefined && sv !== null && sv !== '') data[cp.to] = sv;
    }
    const newId = uuid();
    const nowIso = new Date().toISOString();
    const newRecord: AppRecord = {
      id: newId,
      model_id: targetModelId,
      data,
      created_at: nowIso,
      updated_at: nowIso,
    };
    // saveRecord surfaces its own failures (toast) and persists to the retry
    // queue on 'queued'/'conflict' — in every outcome the in-memory store now
    // holds the new id, so linking to it is correct. We do NOT swallow errors:
    // saveRecord never throws, it returns a status.
    await saveRecord(newRecord);
    patch[lookupField.name] = newId;

    // Prefer a copied human field (e.g. client_name) for the popup label.
    const labelTarget = (f.auto_link_create_copy_fields ?? [])[0]?.to;
    const labelVal = labelTarget ? data[labelTarget] : undefined;
    const label = typeof labelVal === 'string' && labelVal.trim() ? labelVal : needle;
    created.push({ id: newId, label, modelId: targetModelId });
  }

  return { patch, created };
}
