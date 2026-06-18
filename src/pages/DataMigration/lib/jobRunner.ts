import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { extractRawTable, type MigrationUpload } from './client';
import { runMigration } from './runMigration';
import { targetFieldLites } from './targetFields';
import {
  DATA_MIGRATION_MODEL_NAME,
  isProjectProfileTarget,
  readMigrationData,
  type MigrationData,
} from './types';

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
  /** migrate only — saved rows out of total planned writes. */
  done: number;
  total: number;
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
 * Run AI extraction over the record's persisted `source_files`. Flips the
 * record to status='extracting', then writes the raw table + project extras
 * and advances to review_raw — or status='failed' + error_message. No-op if
 * this record already has a running job.
 */
export async function startExtractionJob(recordId: string): Promise<void> {
  if (useMigrationJobs.getState().jobs[recordId]) return;
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  const targetModel = state.models.find((m) => m.id === fresh.data.target_model_id);
  const uploads: MigrationUpload[] = fresh.data.source_files ?? [];
  if (!targetModel || uploads.length === 0) {
    state.addToast(isAr ? 'لا توجد ملفات للاستخراج.' : 'No files to extract.', 'error');
    return;
  }

  registerJob({ recordId, kind: 'extract', done: 0, total: 0 });
  patchMigrationRecord(recordId, { status: 'extracting', error_message: null });
  try {
    const result = await extractRawTable(
      uploads,
      isAr ? 'ar' : 'en',
      targetFieldLites(targetModel),
      isProjectProfileTarget(targetModel) ? 'project' : 'records',
    );
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
    // Await the final patch so the job stays registered until the record
    // reflects the outcome — otherwise the steps see a no-job/stale-status
    // frame and flash the "interrupted" view.
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
