import type { AppModel, AppRecord, ModelField } from '@/types';
import { mapImportedRows } from '@/lib/excelUtils';
import { applyStandardization, modelWithNewOptions } from './applyStandardization';
import type { ColumnStandardization, MigrationResult, RawTable } from './types';

interface SaveResultLike {
  status?: string;
}

export interface RunMigrationArgs {
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization>;
  allModels: AppModel[];
  allRecords: Record<string, AppRecord[]>;
  createdBy: string | null;
  saveModel: (m: AppModel) => unknown;
  saveRecord: (r: AppRecord) => Promise<SaveResultLike> | SaveResultLike;
  makeId: () => string;
  onProgress?: (done: number, total: number) => void;
}

const normalize = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).trim().toLowerCase();

/**
 * The migrate step. Reuses the production import core (`mapImportedRows`) and
 * the proven `saveRecord` write path (auto_id, formulas, frozen dispatch, and
 * the pending-sync retry queue all handled for us). Steps:
 *   1. apply the approved standardization decisions to the raw rows
 *   2. create any approved new options on the model (saveModel)
 *   3. mapImportedRows → record data + auto-created lookup records
 *   4. skip exact duplicates on the model's duplicate-check field
 *   5. save new lookup records first, then each row (sequential — never
 *      parallel; keeps the version/auto-id paths calm)
 * Per-row save failures are captured into `result.errors`, never silently
 * dropped (CLAUDE.md).
 */
export async function runMigration(args: RunMigrationArgs): Promise<MigrationResult> {
  const { model, table, mappings, standardization, allRecords, createdBy } = args;

  // 1 + 2 — standardize cells, create approved new options on the model.
  const applied = applyStandardization(model, table, mappings, standardization, allRecords);
  const model2 = modelWithNewOptions(model, applied.newOptions, args.makeId);
  if (model2 !== model) await args.saveModel(model2);

  const allFields: ModelField[] = model2.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type !== 'mirror');
  const allModels2 = args.allModels.map((m) => (m.id === model.id ? model2 : m));

  // 3 — map rows to record data (+ auto-created lookup target records).
  const { data: mappedData, newLookupRecords } = mapImportedRows(
    applied.rows,
    applied.mappings,
    allFields,
    allRecords,
    allModels2,
  );

  // 4 — exact-duplicate skip on the model's duplicate-check field.
  const dupFieldId = model.schema.duplicate_check_field_id ?? null;
  const dupField = dupFieldId ? allFields.find((f) => f.id === dupFieldId) : null;
  const dupSlug = dupField?.name ?? null;
  const seen = new Set<string>();
  if (dupSlug) {
    for (const rec of allRecords[model.id] ?? []) {
      const k = normalize(rec.data[dupSlug]);
      if (k) seen.add(k);
    }
  }

  const toImport: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const data of mappedData) {
    if (Object.keys(data).length === 0) continue;
    if (dupSlug) {
      const k = normalize(data[dupSlug]);
      if (k) {
        if (seen.has(k)) {
          skipped++;
          continue;
        }
        seen.add(k); // also guards within-file duplicates
      }
    }
    toImport.push(data);
  }

  const result: MigrationResult = {
    imported: 0,
    skipped,
    new_lookup_records: newLookupRecords.length,
    errors: [],
  };

  const total = newLookupRecords.length + toImport.length;
  let done = 0;
  const tick = () => {
    done++;
    args.onProgress?.(done, total);
  };

  // 5 — new lookup records first (so links resolve), then the rows. Sequential.
  for (const rec of newLookupRecords) {
    try {
      const res = await args.saveRecord(rec);
      if (res && res.status && res.status !== 'saved' && res.status !== 'queued') {
        result.errors.push({ id: rec.id, error: `lookup record: ${res.status}` });
      }
    } catch (err) {
      result.errors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) });
    }
    tick();
  }

  const now = new Date().toISOString();
  for (const data of toImport) {
    const rec: AppRecord = {
      id: args.makeId(),
      model_id: model.id,
      data,
      created_by_user_id: createdBy,
      created_at: now,
      updated_at: now,
    };
    try {
      const res = await args.saveRecord(rec);
      if (res && res.status && res.status !== 'saved' && res.status !== 'queued') {
        result.errors.push({ id: rec.id, error: res.status });
      } else {
        result.imported++;
      }
    } catch (err) {
      result.errors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) });
    }
    tick();
  }

  return result;
}
