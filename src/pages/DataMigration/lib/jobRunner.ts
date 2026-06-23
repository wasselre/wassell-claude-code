import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { enqueueExtraction, enqueuePlanTurn } from './client';
import { runMigration } from './runMigration';
import { targetFieldLites } from './targetFields';
import {
  DATA_MIGRATION_MODEL_NAME,
  isProjectProfileTarget,
  readMigrationData,
  type MigrationData,
  type AnsweredQuestion,
} from './types';

/**
 * Module-level runner for the wizard's jobs.
 *
 * The FILE-HEAVY AI steps (extract / plan / discuss) no longer run in the
 * browser at all — `startExtractionJob` / `startPlanJob` just ENQUEUE a worker
 * job (see client.ts) and return; the Fly worker runs the long vision call and
 * writes status / phase / progress / prep_* / raw_table onto the record, which
 * the SPA reads live via Realtime. So closing or reloading the tab no longer
 * interrupts extraction, and a multi-minute brochure can't die on the 300 s
 * Vercel wall. The browser must NOT write the record while a job runs (the
 * enqueue endpoint does the busy/status flip server-side — see CLAUDE.md
 * sole-writer / echo-dedup rule).
 *
 * The LOCAL `import` step (`startMigrationJob`) still runs in-tab — it's a loop
 * of local record writes (not a held-open Anthropic call), so it isn't subject
 * to the wall. It keeps the detached-job machinery below: jobs MUST NOT live
 * inside step components (the wizard is `key={recordId}`, so opening another
 * migration unmounts the running step), so the import job runs detached from
 * React, writes its outcome onto the record via the store, and the steps
 * re-subscribe to progress. In-tab only: a reload mid-import is detected (status
 * says migrating but no job exists) and the step offers an explicit resume.
 */

export type MigrationJobKind = 'migrate' | 'undo';

export interface MigrationJob {
  recordId: string;
  kind: MigrationJobKind;
  /** migrate: saved rows out of planned writes. undo: reversed items out of
   * total created/merged items. */
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
 * Compose the operator-guidance string threaded into the extraction from the
 * prep step's free-text instructions, the clarification chat (Q&A), and the
 * confirmed table structure. Empty string when the operator skipped the prep
 * step. Frozen into the extract job's payload at enqueue. Framing labels are in
 * English (guidance is for the model, not the user); the instruction/answer
 * content is naturally in the operator's own language.
 */
function buildGuidance(data: MigrationData): string {
  const parts: string[] = [];
  const instructions = (data.extraction_instructions ?? '').trim();
  if (instructions) parts.push(`Instructions:\n${instructions}`);

  const chat = data.prep_chat ?? [];
  if (chat.length > 0) {
    const transcript = chat
      .map((m) => `${m.role === 'user' ? 'Operator' : 'You'}: ${m.content}`)
      .join('\n');
    parts.push(`Clarifications resolved with the operator (apply what was agreed):\n${transcript}`);
  }

  const structure = data.prep_structure ?? [];
  if (structure.length > 0) {
    parts.push(
      'Confirmed table structure (produce these columns unless the data clearly demands otherwise):\n' +
        structure.map((c) => `- ${c.header}: ${c.description}`).join('\n'),
    );
  }

  return parts.join('\n\n');
}

/**
 * ENQUEUE the AI extraction onto the worker. Builds the field hunt-list, mode
 * (project-profile vs records), and operator guidance from the record, then
 * POSTs /api/migrate (action=extract) — which flips the record to
 * status='extracting' server-side and inserts a job. The worker does the rest
 * (discover → batched fuse → assemble, OR the project-profile single extract)
 * and writes progress/results onto the record; the SPA renders them live. This
 * returns as soon as the job is queued — no in-tab orchestration, so it survives
 * navigating away / reloading.
 */
export async function startExtractionJob(recordId: string): Promise<void> {
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  // Backstop: a completed migration's prep page is viewable (read-only); never
  // let it re-extract (that would overwrite the migrated raw table). The UI
  // hides Start extraction when done.
  if (fresh.data.status === 'done') {
    state.addToast(isAr ? 'تم ترحيل هذه العملية بالفعل.' : 'This migration already ran.', 'info');
    return;
  }
  const targetModel = state.models.find((m) => m.id === fresh.data.target_model_id);
  const uploads = fresh.data.source_files ?? [];
  if (!targetModel || uploads.length === 0) {
    state.addToast(isAr ? 'لا توجد ملفات للاستخراج.' : 'No files to extract.', 'error');
    return;
  }
  try {
    await enqueueExtraction({
      recordId,
      fields: targetFieldLites(targetModel),
      mode: isProjectProfileTarget(targetModel) ? 'project' : 'records',
      language: isAr ? 'ar' : 'en',
      guidance: buildGuidance(fresh.data),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.addToast(msg, 'error');
  }
}

/**
 * ENQUEUE ONE pre-extraction PLANNING turn. POSTs /api/migrate (action=plan),
 * which appends the operator's message + submitted card answers to the record
 * (so the chat updates via Realtime) and inserts a job; the worker reads the
 * files, returns the reply + open questions + proposed structure, and writes
 * them onto the record. `prep_busy` (set server-side) drives the chat spinner.
 * Returns as soon as the turn is queued — survives navigating away.
 */
export async function startPlanJob(
  recordId: string,
  userText: string,
  instructions: string,
  /** Card answers the operator submitted this turn — logged to prep_answered
   * (server-side) so the Q&A stays viewable after the questions resolve. */
  answeredToAppend: AnsweredQuestion[] = [],
): Promise<void> {
  const text = userText.trim();
  if (!text) return;
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  const targetModel = state.models.find((m) => m.id === fresh.data.target_model_id);
  if (!targetModel) {
    state.addToast(isAr ? 'لم يتم اختيار النموذج الهدف.' : 'No target model selected.', 'error');
    return;
  }
  try {
    await enqueuePlanTurn({
      recordId,
      userText: text,
      instructions,
      answered: answeredToAppend,
      fields: targetFieldLites(targetModel),
      language: isAr ? 'ar' : 'en',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.addToast(msg, 'error');
  }
}

/**
 * Run the import. Flips the record to step='migrating'/status='migrating',
 * streams progress into the job store (the list + StepMigrating render it),
 * then writes the result + status='done' — or status='failed' + error_message
 * (step stays 'migrating' so the step machine shows the retry view). No-op if
 * this record already has a running job.
 *
 * This step stays CLIENT-SIDE: it is a loop of local record writes (create
 * options / lookup records / records), not a held-open Anthropic call, so it is
 * not subject to the 300 s wall the extraction queue exists to escape.
 */
export async function startMigrationJob(recordId: string): Promise<void> {
  if (useMigrationJobs.getState().jobs[recordId]) return;
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  const { data } = fresh;
  // Backstop: a completed migration is browsable (read-only) but must never be
  // re-run — re-importing would duplicate options/lookup records (and re-apply a
  // project update). The UI already replaces the Migrate button with "View
  // result" when done; this guards any other call path.
  if (data.status === 'done') {
    state.addToast(isAr ? 'تم ترحيل هذه العملية بالفعل.' : 'This migration already ran.', 'info');
    return;
  }
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
      projectIntelligence: data.project_intelligence,
      projectUpdateTargetId: data.project_update_target,
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

/**
 * UNDO a completed migration: delete the records it created (+ the lookup
 * records), revert the projects it merged into, then re-open the migration for
 * editing (status='draft', step='preview') so the operator can adjust and
 * re-run. Created dropdown options are intentionally KEPT (shared/deduped).
 *
 * Reads the `undo` ledger captured at migrate time (`result.undo`). Only runs on
 * a `done` migration that HAS that ledger (migrations run before undo support
 * have none — the UI hides the button for them). Like the import, this is an
 * in-tab job of local record deletes/writes (no Anthropic), not a worker job.
 *
 * Idempotent: `deleteRecord` no-ops on an already-deleted id (fire-and-forget +
 * the pending-sync retry queue), so a reload mid-undo and re-run is safe.
 */
export async function undoMigrationJob(recordId: string): Promise<void> {
  if (useMigrationJobs.getState().jobs[recordId]) return;
  const state = useAppStore.getState();
  const isAr = state.language === 'ar';
  const fresh = readFresh(recordId);
  if (!fresh) return;
  const undo = fresh.data.result?.undo;
  if (fresh.data.status !== 'done' || !undo) {
    state.addToast(
      isAr ? 'لا يمكن التراجع عن هذا الترحيل.' : "This migration can't be undone.",
      'info',
    );
    return;
  }

  const total =
    undo.created_record_ids.length +
    undo.created_lookup_records.length +
    undo.updated_projects.length;
  registerJob({ recordId, kind: 'undo', done: 0, total });
  patchMigrationRecord(recordId, { status: 'undoing', error_message: null });
  try {
    let done = 0;
    const tick = () => {
      done += 1;
      updateJob(recordId, { done });
    };
    // 1 — delete the main created records FIRST, so the lookup-record deletes
    //     below don't dangle behind records that still reference them.
    for (const id of undo.created_record_ids) {
      useAppStore.getState().deleteRecord(undo.target_model_id, id);
      tick();
    }
    // 2 — delete the created lookup-target records.
    for (const l of undo.created_lookup_records) {
      useAppStore.getState().deleteRecord(l.model_id, l.id);
      tick();
    }
    // 3 — restore each merged project's pre-merge data (its units/rollups are
    //     separate records, untouched). expectedVersion:null — deliberate
    //     overwrite, same posture as the merge that created the snapshot.
    const now = new Date().toISOString();
    for (const p of undo.updated_projects) {
      const s = useAppStore.getState();
      const current = (s.records[p.model_id] ?? []).find((r) => r.id === p.id);
      if (current) {
        await s.saveRecord(
          { ...current, data: p.data_before, updated_at: now },
          { expectedVersion: null },
        );
      }
      tick();
    }
    // Re-open for editing: back to the preview step, drop the result so the
    // done view + Undo affordance disappear and Migrate returns.
    await patchMigrationRecord(recordId, {
      status: 'draft',
      step: 'preview',
      result: undefined,
      error_message: null,
    });
    state.addToast(isAr ? 'تم التراجع عن الترحيل.' : 'Migration undone — edit and re-run.', 'success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Revert to 'done' (NOT 'failed') so the done view + Undo button return —
    // the undo ledger is untouched and undo is idempotent, so the user can
    // simply retry it. Surface the error via toast.
    await patchMigrationRecord(recordId, { status: 'done', error_message: msg });
    useAppStore.getState().addToast(msg, 'error');
  } finally {
    unregisterJob(recordId);
  }
}
