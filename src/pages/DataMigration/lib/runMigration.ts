import type { AppModel, AppRecord, ModelField } from '@/types';
import { mapImportedRows } from '@/lib/excelUtils';
import { applyStandardization, modelWithNewOptions } from './applyStandardization';
import type { ColumnStandardization, CountRowResult, MigrationResult, RawTable } from './types';

interface SaveResultLike {
  status?: string;
}

/** Inputs that fully + deterministically define the records to import. */
export interface BuildPlanArgs {
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization>;
  countFields?: string[];
  countResults?: Record<string, CountRowResult[]>;
  allModels: AppModel[];
  allRecords: Record<string, AppRecord[]>;
  makeId: () => string;
}

export interface RunMigrationArgs extends BuildPlanArgs {
  createdBy: string | null;
  /** Source row indices the user un-approved in the preview step — not saved. */
  excludedRows?: number[];
  saveModel: (m: AppModel) => unknown;
  saveRecord: (r: AppRecord) => Promise<SaveResultLike> | SaveResultLike;
  onProgress?: (done: number, total: number) => void;
}

/** One record about to be created, tagged with the source row it came from
 * (so the preview can show/exclude it by row). */
export interface BuiltRecord {
  rowIndex: number;
  data: Record<string, unknown>;
}

export interface MigrationPlan {
  /** Model with any approved new options added (must be saved before import). */
  model2: AppModel;
  /** The records that would be created (after dup-skip), each with its row index. */
  records: BuiltRecord[];
  /** Lookup-target records auto-created by the importer. */
  newLookupRecords: AppRecord[];
  /** How many rows were skipped as exact duplicates of existing records. */
  skipped: number;
}

const normalize = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).trim().toLowerCase();

/**
 * Build the records that WOULD be imported — pure, no writes. Shared by the
 * preview step (to show + approve) and the migrate step (to save), so what the
 * user approves is exactly what gets written. Deterministic given the same
 * inputs (lookup-record UUIDs differ per call but are internally consistent
 * within one plan; the preview only displays values, never the UUIDs).
 */
export function buildMigrationPlan(args: BuildPlanArgs): MigrationPlan {
  const { model, table, mappings, standardization, allRecords } = args;

  // 1 + 2 — standardize cells, collect approved new options.
  const applied = applyStandardization(model, table, mappings, standardization, allRecords);
  const model2 = modelWithNewOptions(model, applied.newOptions, args.makeId);

  // 2.5 — AI-counted fields: drop any column mapping to a counted field, then
  // append one column carrying each unit's computed count (mapped to the field).
  const countFields = args.countFields ?? [];
  const countResults = args.countResults ?? {};
  if (countFields.length > 0) {
    for (const [k, v] of Object.entries(applied.mappings)) {
      if (v && countFields.includes(v)) applied.mappings[Number(k)] = null;
    }
    let nextCol = Math.max(
      table.headers.length,
      ...applied.rows.map((r) => r.length),
      ...Object.keys(applied.mappings).map((k) => Number(k) + 1),
      0,
    );
    for (const slug of countFields) {
      const results = countResults[slug];
      if (!results || results.length === 0) continue;
      const idx = nextCol++;
      const byIdx = new Map(results.map((r) => [r.rowIndex, r.count]));
      applied.rows.forEach((row, r) => {
        while (row.length <= idx) row.push('');
        const c = byIdx.get(r);
        row[idx] = c !== undefined && c !== null ? String(c) : '';
      });
      applied.mappings[idx] = slug;
    }
  }

  const allFields: ModelField[] = model2.schema.sections.flatMap((s) => s.fields).filter((f) => f.type !== 'mirror');
  const allModels2 = args.allModels.map((m) => (m.id === model.id ? model2 : m));

  // 3 — map rows to record data (+ auto-created lookup target records).
  // mapImportedRows internally drops all-empty rows; replicate that predicate
  // so we can pair each produced record back to its source row index.
  const surviving = applied.rows.map((_, i) => i).filter((i) => applied.rows[i]!.some((c) => c !== ''));
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

  const records: BuiltRecord[] = [];
  let skipped = 0;
  for (let k = 0; k < mappedData.length; k++) {
    const data = mappedData[k]!;
    const rowIndex = surviving[k] ?? k;
    if (Object.keys(data).length === 0) continue;
    if (dupSlug) {
      const key = normalize(data[dupSlug]);
      if (key) {
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key); // also guards within-file duplicates
      }
    }
    records.push({ rowIndex, data });
  }

  return { model2, records, newLookupRecords, skipped };
}

/**
 * The migrate step. Builds the plan, then saves the model (new options) +
 * auto-created lookup records + the APPROVED records (those whose source row
 * wasn't excluded in the preview). Reuses the proven `saveRecord` write path
 * (auto_id, formulas, frozen dispatch, pending-sync retry). Per-row failures
 * are captured into `result.errors`, never silently dropped (CLAUDE.md).
 */
export async function runMigration(args: RunMigrationArgs): Promise<MigrationResult> {
  const plan = buildMigrationPlan(args);
  if (plan.model2 !== args.model) await args.saveModel(plan.model2);

  const excluded = new Set(args.excludedRows ?? []);
  const approved = plan.records.filter((r) => !excluded.has(r.rowIndex));

  const result: MigrationResult = {
    imported: 0,
    skipped: plan.skipped,
    new_lookup_records: plan.newLookupRecords.length,
    errors: [],
  };

  const total = plan.newLookupRecords.length + approved.length;
  let done = 0;
  const tick = () => {
    done++;
    args.onProgress?.(done, total);
  };

  // New lookup records first (so links resolve), then the approved rows. Sequential.
  for (const rec of plan.newLookupRecords) {
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
  for (const { data } of approved) {
    const rec: AppRecord = {
      id: args.makeId(),
      model_id: args.model.id,
      data,
      created_by_user_id: args.createdBy,
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
