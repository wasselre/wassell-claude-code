import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  extractRawTable,
  discoverUnits,
  fuseUnitBatch,
  type MigrationUpload,
  type DiscoverResult,
} from './client';
import { runMigration } from './runMigration';
import { targetFieldLites, type TargetFieldLite } from './targetFields';
import {
  DATA_MIGRATION_MODEL_NAME,
  isProjectProfileTarget,
  readMigrationData,
  type MigrationData,
  type DiscoveredUnit,
  type RawCellConflict,
} from './types';

/** Units per fusion batch. Sized so a batch's tool output stays well under the
 * model's max_tokens; a batch that still truncates is auto-split (see
 * `fuseResolved`), so this is a throughput knob, not a correctness one. */
const FUSE_BATCH_SIZE = 20;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Module-level runner for the wizard's two long jobs — AI extraction and the
 * row-by-row import. Jobs MUST NOT live inside step components: the wizard is
 * `key={recordId}`, so opening another migration unmounts the running step and
 * (before this runner existed) the job's state died with it — and remounting
 * `StepMigrating` restarted the import loop a second time, duplicating rows.
 *
 * Here a job is keyed by its `data_migration` record id, runs detached from
 * React, and writes every outcome (status flips, errors, results) onto the
 * record via the store — so any number of migrations run concurrently, the
 * list pills stay live, and navigating away/back just re-subscribes to
 * progress. Starting a job for a record that already has one is a no-op.
 *
 * In-tab only: a page reload kills running jobs. The steps detect that
 * (status says running but no job exists) and offer an explicit retry/resume.
 */

export type MigrationJobKind = 'extract' | 'migrate';

export interface MigrationJob {
  recordId: string;
  kind: MigrationJobKind;
  /** migrate: saved rows out of planned writes. extract (source-fusion):
   * resolved units out of discovered units. */
  done: number;
  total: number;
  /** extract (records-mode source-fusion) sub-phase, for the spinner copy. */
  phase?: 'discover' | 'fuse';
}

interface MigrationJobsState {
  /** Running jobs keyed by `data_migration` record id. */
  jobs: Record<string, MigrationJob>;
}

export const useMigrationJobs = create<MigrationJobsState>(() => ({ jobs: {} }));

function registerJob(job: MigrationJob): void {
  useMigrationJobs.setState((s) => ({ jobs: { ...s.jobs, [job.recordId]: job } }));
}

function updateJob(recordId: string, partial: Partial<MigrationJob>): void {
  useMigrationJobs.setState((s) => {
    const job = s.jobs[recordId];
    if (!job) return s;
    return { jobs: { ...s.jobs, [recordId]: { ...job, ...partial } } };
  });
}

function unregisterJob(recordId: string): void {
  useMigrationJobs.setState((s) => {
    const rest = { ...s.jobs };
    delete rest[recordId];
    return { jobs: rest };
  });
}

/** The freshest record + typed data, read straight from the store (never a
 * render-time closure — the component that started the job may be long gone). */
function readFresh(recordId: string): { record: AppRecord; data: MigrationData } | null {
  const state = useAppStore.getState();
  const model = state.models.find((m) => m.name === DATA_MIGRATION_MODEL_NAME);
  const record = model
    ? (state.records[model.id] ?? []).find((r) => r.id === recordId)
    : undefined;
  if (!record) return null;
  return { record, data: readMigrationData(record) };
}

/** Per-record chain so patches apply in call order. Without it, a job that
 * finishes near-instantly (e.g. every row dup-skipped) could land its "done"
 * patch before the "migrating" start patch, regressing the record for good. */
const patchQueues = new Map<string, Promise<void>>();

/** Same merge-and-save as MigrationWizard's `patch`, store-sourced so it works
 * after the wizard unmounts. Reads the freshest record only when its turn in
 * the queue comes, so each patch builds on the previous one's result. */
function patchMigrationRecord(recordId: string, partial: Partial<MigrationData>): Promise<void> {
  const prev = patchQueues.get(recordId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const fresh = readFresh(recordId);
      if (!fresh) return;
      const rec: AppRecord = {
        ...fresh.record,
        data: { ...fresh.record.data, ...partial },
        updated_at: new Date().toISOString(),
      };
      // expectedVersion: null — same single-record/single-writer posture as the
      // wizard's `patch` (see MigrationWizard.tsx). The job-driven status flips
      // race the wizard's own patches on the SAME record; routing them through
      // the optimistic-version check is what wedged the local version behind the
      // server and triggered the conflict→breaker→reload-overwrite data loss.
      await useAppStore.getState().saveRecord(rec, { expectedVersion: null });
    })
    .catch((err: unknown) => {
      // saveRecord reports + queues its own failures and resolves with a
      // status; a rejection here is unexpected. Log it and keep the queue
      // alive so later patches for this record still apply.
      console.error('[migration] record patch failed', recordId, err);
    });
  patchQueues.set(recordId, next);
  return next;
}

/**
 * Resolve ONE batch of units by fusing facts across every source. On a
 * max_tokens truncation (the thrown Error carries `code:'max_tokens'`) the batch
 * is split in half and each half retried recursively — so the pipeline's output
 * can never overflow, no matter how dense a unit or how big a batch. A genuine
 * non-truncation error still propagates (loud failure). Conflicts are re-keyed
 * from the unit key to the row key for the raw table.
 */
async function fuseResolved(
  uploads: MigrationUpload[],
  language: 'ar' | 'en',
  fields: TargetFieldLite[],
  headers: string[],
  units: DiscoveredUnit[],
): Promise<{ rows: { key: string; values: string[] }[]; conflicts: RawCellConflict[] }> {
  try {
    const res = await fuseUnitBatch(uploads, language, fields, headers, units);
    return {
      rows: res.rows,
      conflicts: res.conflicts.map((c) => ({
        rowKey: c.unitKey,
        header: c.header,
        candidates: c.candidates,
        chosen: c.chosen,
        note: c.note,
      })),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'max_tokens' && units.length > 1) {
      const mid = Math.ceil(units.length / 2);
      const a = await fuseResolved(uploads, language, fields, headers, units.slice(0, mid));
      const b = await fuseResolved(uploads, language, fields, headers, units.slice(mid));
      return { rows: [...a.rows, ...b.rows], conflicts: [...a.conflicts, ...b.conflicts] };
    }
    throw err;
  }
}

/** The Arabic/English extraction summary that seeds the review-step discussion:
 * how many sources were fused, how many units discovered/resolved, how many
 * conflicts flagged — plus the discovery phase's own notes. */
function buildFusionSummary(
  isAr: boolean,
  disc: DiscoverResult,
  resolved: number,
  conflictCount: number,
): string {
  const srcList = disc.sources.map((s) => s.name).filter(Boolean).join('، ');
  const head = isAr
    ? `حلّلت ${disc.files_processed} ملف${srcList ? ` (${srcList})` : ''} وربطت الحقائق لكل وحدة من جميع المصادر. اكتُشفت ${disc.units.length} وحدة، تم حلّ ${resolved} منها. ${conflictCount} تعارض/تنبيه بحاجة لمراجعة.`
    : `Analyzed ${disc.files_processed} file(s)${srcList ? ` (${srcList})` : ''} and fused facts per unit across all sources. Discovered ${disc.units.length} units, resolved ${resolved}. ${conflictCount} conflict(s)/warning(s) flagged for review.`;
  return disc.notes ? `${head}\n\n${disc.notes}` : head;
}

/**
 * Run AI extraction over the record's persisted `source_files`. Flips the
 * record to status='extracting', then writes the raw table + project extras
 * and advances to review_raw — or status='failed' + error_message. No-op if
 * this record already has a running job.
 *
 * Two extraction strategies, picked by target:
 *   - PROJECT-PROFILE (all_projects): one aggregated row + the Arabic marketing
 *     document, in a single model call (output is small — see extractRawTable).
 *   - RECORDS (units / clients / …): SOURCE FUSION — discover every unit across
 *     all files, then resolve units in batches (merging facts from sheet + PDFs
 *     + brochure + floor plans + images per unit, flagging conflicts). Batched
 *     so no single model response can overflow and silently bank zero rows.
 */
export async function startExtractionJob(recordId: string): Promise<void> {
  if (useMigrationJobs.getState().jobs[recordId]) return;
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const lang: 'ar' | 'en' = isAr ? 'ar' : 'en';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  const targetModel = state.models.find((m) => m.id === fresh.data.target_model_id);
  const uploads: MigrationUpload[] = fresh.data.source_files ?? [];
  if (!targetModel || uploads.length === 0) {
    state.addToast(isAr ? 'لا توجد ملفات للاستخراج.' : 'No files to extract.', 'error');
    return;
  }
  const fields = targetFieldLites(targetModel);

  registerJob({ recordId, kind: 'extract', done: 0, total: 0 });
  patchMigrationRecord(recordId, { status: 'extracting', error_message: null });
  try {
    if (isProjectProfileTarget(targetModel)) {
      // ── PROJECT-PROFILE: one aggregated row + Arabic knowledge document ──
      const result = await extractRawTable(uploads, lang, fields, 'project');
      const addToast = useAppStore.getState().addToast;
      if (result.files_skipped.length > 0) {
        addToast(
          (isAr ? 'تم تخطي: ' : 'Skipped: ') +
            result.files_skipped.map((s) => `${s.name} (${s.reason})`).join('، '),
          'info',
        );
      }
      if (result.truncated) {
        addToast(
          isAr
            ? 'البيانات كبيرة — تم استخراج جزء منها فقط. راجع وأكمل، أو قسّم الملف.'
            : 'Large input — only part was extracted. Review, or split the file and retry.',
          'info',
        );
      }
      await patchMigrationRecord(recordId, {
        raw_table: {
          headers: result.headers,
          rows: result.rows,
          notes: result.notes,
          summary: result.summary,
          truncated: result.truncated,
          source: 'ai_extract',
        },
        step: 'review_raw',
        status: 'draft',
        project_document: result.document,
        project_intelligence: result.intelligence,
      });
      return; // finally unregisters the job
    }

    // ── RECORDS: SOURCE FUSION (discover → batched fuse → assemble) ──
    updateJob(recordId, { phase: 'discover' });
    const disc = await discoverUnits(uploads, lang, fields);
    const addToast = useAppStore.getState().addToast;
    if (disc.files_skipped.length > 0) {
      addToast(
        (isAr ? 'تم تخطي: ' : 'Skipped: ') +
          disc.files_skipped.map((s) => `${s.name} (${s.reason})`).join('، '),
        'info',
      );
    }

    const headers = disc.headers;
    updateJob(recordId, { phase: 'fuse', done: 0, total: disc.units.length });
    const rows: string[][] = [];
    const rowKeys: string[] = [];
    const conflicts: RawCellConflict[] = [];
    const seen = new Set<string>();
    let resolved = 0;

    for (const batch of chunk(disc.units, FUSE_BATCH_SIZE)) {
      const fused = await fuseResolved(uploads, lang, fields, headers, batch);
      const byKey = new Map(fused.rows.map((r) => [r.key, r.values]));
      for (const u of batch) {
        if (seen.has(u.key)) continue; // de-dup defensively across batches
        seen.add(u.key);
        rowKeys.push(u.key);
        const vals = byKey.get(u.key);
        if (vals && vals.length > 0) {
          rows.push(vals.length === headers.length ? vals : headers.map((_, i) => vals[i] ?? ''));
          resolved += 1;
        } else {
          // Never silently drop a discovered unit — emit a blank row + loud note.
          rows.push(headers.map(() => ''));
          conflicts.push({
            rowKey: u.key,
            header: '',
            candidates: [],
            chosen: '',
            note: isAr
              ? `لم تُرجع المعالجة بيانات للوحدة ${u.key} — تحقّق يدويًا.`
              : `Fusion returned no data for unit ${u.key} — verify manually.`,
          });
        }
      }
      conflicts.push(...fused.conflicts);
      updateJob(recordId, { done: rows.length, total: disc.units.length });
    }

    // A header set with zero resolved rows means something went wrong upstream —
    // surface it, never bank an empty table as a success.
    if (rows.length === 0) {
      throw new Error(isAr ? 'لم يتم العثور على وحدات في الملفات.' : 'No units were found in the files.');
    }
    if (disc.truncated) {
      addToast(
        isAr
          ? 'كان الإدخال كبيرًا — قد لا تظهر كل الوحدات. راجع، أو قسّم الملف وأعد المحاولة.'
          : 'Large input — some units may be missing. Review, or split the file and retry.',
        'info',
      );
    }

    await patchMigrationRecord(recordId, {
      raw_table: {
        headers,
        rows,
        row_keys: rowKeys,
        conflicts,
        sources: disc.sources,
        notes: disc.notes,
        summary: buildFusionSummary(isAr, disc, resolved, conflicts.length),
        truncated: disc.truncated,
        source: 'ai_extract',
      },
      step: 'review_raw',
      status: 'draft',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchMigrationRecord(recordId, { status: 'failed', error_message: msg });
    useAppStore.getState().addToast(msg, 'error');
  } finally {
    unregisterJob(recordId);
  }
}

/**
 * Run the import. Flips the record to step='migrating'/status='migrating',
 * streams progress into the job store (the list + StepMigrating render it),
 * then writes the result + status='done' — or status='failed' + error_message
 * (step stays 'migrating' so the step machine shows the retry view). No-op if
 * this record already has a running job.
 */
export async function startMigrationJob(recordId: string): Promise<void> {
  if (useMigrationJobs.getState().jobs[recordId]) return;
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  const { data } = fresh;
  const targetModel = state.models.find((m) => m.id === data.target_model_id);
  if (!targetModel || !data.raw_table || !data.mappings) {
    state.addToast(isAr ? 'بيانات الترحيل غير مكتملة.' : 'Migration data is incomplete.', 'error');
    return;
  }

  registerJob({ recordId, kind: 'migrate', done: 0, total: 0 });
  patchMigrationRecord(recordId, { step: 'migrating', status: 'migrating', error_message: null });
  try {
    const result = await runMigration({
      model: targetModel,
      table: data.raw_table,
      mappings: data.mappings,
      standardization: data.standardization ?? {},
      projectDocument: data.project_document,
      excludedRows: data.excluded_rows,
      allModels: state.models,
      allRecords: state.records,
      isAr,
      createdBy: state.currentUserId,
      saveModel: state.saveModel,
      saveRecord: state.saveRecord,
      makeId: uuid,
      onProgress: (done, total) => updateJob(recordId, { done, total }),
    });
    // Awaited for the same no-flash reason as the extraction job above.
    await patchMigrationRecord(recordId, { result, step: 'done', status: 'done' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchMigrationRecord(recordId, { status: 'failed', error_message: msg });
    useAppStore.getState().addToast(msg, 'error');
  } finally {
    unregisterJob(recordId);
  }
}
