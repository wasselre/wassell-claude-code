import type { AppModel, AppRecord, FieldOption } from '@/types';
import { buildMigrationPlan, type BuildPlanArgs, type MigrationPlan } from './buildRecords';
import type { BuiltRecord, MigrationResult, PendingNewLookupRecord, PendingNewOption } from './types';

export { buildMigrationPlan } from './buildRecords';
export type { BuildPlanArgs, MigrationPlan } from './buildRecords';

interface SaveResultLike {
  status?: string;
}

export interface RunMigrationArgs extends BuildPlanArgs {
  createdBy: string | null;
  /** Source row indices the user un-approved in the preview step — not saved. */
  excludedRows?: number[];
  saveModel: (m: AppModel) => unknown;
  saveRecord: (r: AppRecord) => Promise<SaveResultLike> | SaveResultLike;
  onProgress?: (done: number, total: number) => void;
}

// Rotating palette for newly-created options — matches the record-form inline
// palette so migration-created options look the same as hand-added ones.
const OPTION_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1',
];

/** A built record may migrate only when it has NO blocking (error) issue. */
export function isRecordValid(rec: BuiltRecord): boolean {
  return !rec.issues.some((i) => i.severity === 'error');
}

/** Add approved new options to the model's schema (deterministic value already
 * computed in the plan). Returns a new model; caller persists via saveModel.
 * Safe for frozen models — options live in the JSONB schema, not as columns,
 * so no DDL is involved (mirrors the record-form inline-create path). */
export function applyNewOptionsToModel(
  model: AppModel,
  options: PendingNewOption[],
  makeId: () => string,
): AppModel {
  if (options.length === 0) return model;
  const byField = new Map<string, PendingNewOption[]>();
  for (const o of options) {
    const list = byField.get(o.fieldId) ?? [];
    list.push(o);
    byField.set(o.fieldId, list);
  }
  return {
    ...model,
    schema: {
      ...model.schema,
      sections: model.schema.sections.map((s) => ({
        ...s,
        fields: s.fields.map((f) => {
          const adds = byField.get(f.id);
          if (!adds || adds.length === 0) return f;
          const existing = f.options ?? [];
          const have = new Set(existing.map((o) => o.value));
          const newOpts: FieldOption[] = adds
            .filter((a) => !have.has(a.value))
            .map((a, i) => ({
              id: makeId(),
              label_ar: a.label,
              label_en: a.label,
              value: a.value,
              color: OPTION_COLORS[(existing.length + i) % OPTION_COLORS.length],
            }));
          return newOpts.length > 0 ? { ...f, options: [...existing, ...newOpts] } : f;
        }),
      })),
    },
    updated_at: new Date().toISOString(),
  };
}

/** Collect every scalar/array string value present across the saved records —
 * used to prune pending creates down to the ones actually referenced (so a new
 * developer for a row the user EXCLUDED in preview is never created). */
function collectUsedValues(records: BuiltRecord[]): Set<string> {
  const used = new Set<string>();
  for (const rec of records) {
    for (const v of Object.values(rec.data)) {
      if (typeof v === 'string') used.add(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') used.add(x);
    }
  }
  return used;
}

/**
 * The migrate step. Builds the plan, then — for the APPROVED + VALID rows only —
 * creates the referenced new options (in the model schema) + the referenced new
 * lookup records, then saves the records. Reuses the proven `saveRecord` write
 * path (auto_id, formulas, frozen dispatch, pending-sync retry). Per-row
 * failures are captured into `result.errors`, never silently dropped.
 */
export async function runMigration(args: RunMigrationArgs): Promise<MigrationResult> {
  const plan: MigrationPlan = buildMigrationPlan(args);
  const excluded = new Set(args.excludedRows ?? []);

  // Approved = not excluded. Of those, only valid rows are actually saved.
  const approved = plan.records.filter((r) => !excluded.has(r.rowIndex));
  const toSave = approved.filter(isRecordValid);
  const invalidSkipped = approved.length - toSave.length;

  // Prune pending creates to those referenced by rows we will actually save.
  const usedValues = collectUsedValues(toSave);
  const optionsToCreate = plan.newOptions.filter((o) => usedValues.has(o.value));
  const lookupsToCreate = plan.newLookupRecords.filter((l) => usedValues.has(l.tempId));

  const result: MigrationResult = {
    imported: 0,
    skipped: plan.skipped,
    new_lookup_records: lookupsToCreate.length,
    new_options: optionsToCreate.length,
    invalid_skipped: invalidSkipped,
    errors: [],
  };

  const total = lookupsToCreate.length + toSave.length;
  let done = 0;
  const tick = () => {
    done++;
    args.onProgress?.(done, total);
  };
  // Offline saves resolve in microtasks; a long uninterrupted run would hog the
  // main thread. A macrotask yield every few rows keeps the tab responsive;
  // online, the per-row network await dwarfs it.
  const YIELD_EVERY = 20;
  const breathe = async () => {
    if (done % YIELD_EVERY === 0) await new Promise<void>((r) => setTimeout(r, 0));
  };

  // 1 — new options into the model schema (so saved records validate against them).
  if (optionsToCreate.length > 0) {
    const model2 = applyNewOptionsToModel(args.model, optionsToCreate, args.makeId);
    if (model2 !== args.model) await args.saveModel(model2);
  }

  // 2 — new lookup-target records (id = the plan's temp id, so links resolve).
  const now = new Date().toISOString();
  for (const pending of lookupsToCreate) {
    const rec = pendingLookupToRecord(pending, args.createdBy, now);
    try {
      const res = await args.saveRecord(rec);
      if (res && res.status && res.status !== 'saved' && res.status !== 'queued') {
        result.errors.push({ id: rec.id, error: `lookup record: ${res.status}` });
      }
    } catch (err) {
      result.errors.push({ id: rec.id, error: err instanceof Error ? err.message : String(err) });
    }
    tick();
    await breathe();
  }

  // 3 — the approved + valid records.
  for (const built of toSave) {
    const rec: AppRecord = {
      id: args.makeId(),
      model_id: args.model.id,
      data: built.data,
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
    await breathe();
  }

  return result;
}

function pendingLookupToRecord(
  pending: PendingNewLookupRecord,
  createdBy: string | null,
  now: string,
): AppRecord {
  return {
    id: pending.tempId,
    model_id: pending.targetModelId,
    data: { [pending.displayField]: pending.label },
    created_by_user_id: createdBy,
    created_at: now,
    updated_at: now,
  };
}
