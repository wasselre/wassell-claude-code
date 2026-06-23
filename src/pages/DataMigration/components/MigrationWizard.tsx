import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { startExtractionJob, startMigrationJob } from '../lib/jobRunner';
import { readMigrationData, type ColumnStandardization, type MigrationData, type MigrationStep } from '../lib/types';
import StepPickModel from './steps/StepPickModel';
import StepUpload from './steps/StepUpload';
import StepPrep from './steps/StepPrep';
import StepReviewRaw from './steps/StepReviewRaw';
import StepMapping from './steps/StepMapping';
import StepStandardize from './steps/StepStandardize';
import StepPreview from './steps/StepPreview';
import StepMigrating from './steps/StepMigrating';
import StepDone from './steps/StepDone';

interface MigrationWizardProps {
  recordId: string;
  modelId: string;
}

/** The pages a COMPLETED migration can be browsed through (read-only review of
 * what was migrated + the result). Shown as a navigator only when status='done'
 * so the operator can revisit the extracted table, mapping, standardization,
 * preview, and result after the import — without being able to re-run it. */
const DONE_NAV: { step: MigrationStep; ar: string; en: string }[] = [
  { step: 'prep', ar: 'الأسئلة', en: 'Q&A' },
  { step: 'review_raw', ar: 'الجدول', en: 'Table' },
  { step: 'mapping', ar: 'الربط', en: 'Mapping' },
  { step: 'standardize', ar: 'التوحيد', en: 'Standardize' },
  { step: 'preview', ar: 'المعاينة', en: 'Preview' },
  { step: 'done', ar: 'النتيجة', en: 'Result' },
];

/**
 * The migration step machine. Reads the `data_migration` record from the store
 * and switches on `record.data.step`. Every step persists its slice back to
 * `record.data` via `patch`, so reload / navigate-away resumes exactly here.
 *
 * Phase 1: pick_model. Phase 3: upload + review_raw. Mapping / standardize /
 * migrate land in later phases (placeholder for now).
 */
export default function MigrationWizard({ recordId, modelId }: MigrationWizardProps) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const record = useAppStore((s) => (s.records[modelId] ?? []).find((r) => r.id === recordId));

  const data: MigrationData = useMemo(() => (record ? readMigrationData(record) : {}), [record]);

  const patch = (partial: Partial<MigrationData>) => {
    // Read the FRESHEST record from the store (not this render's closure) so
    // rapid successive patches build on each other instead of clobbering one
    // another or fighting the optimistic-version check.
    const fresh = (useAppStore.getState().records[modelId] ?? []).find((r) => r.id === recordId);
    const base = fresh ?? record;
    if (!base) return;
    const next: AppRecord = {
      ...base,
      data: { ...base.data, ...partial },
      updated_at: new Date().toISOString(),
    };
    // expectedVersion: null — opt OUT of optimistic concurrency for the wizard.
    // A migration is ONE record edited by a SINGLE tab (the decks posture), and
    // the wizard fire-and-forget-saves the whole record on EVERY step/value
    // change. Going through the version check made the local `version` drift
    // behind the server (realtime echo-dedup suppresses the tab's own bumps),
    // so saves started returning version_mismatch — which DROPS the write (not
    // queued), trips the circuit breaker, and makes the 2026-06-16
    // reload-on-conflict overwrite the in-progress wizard data with the stale
    // server copy. Net effect: work done after the first conflict never reached
    // the DB, so a refresh "lost"/"deleted" the migration. With null the RPC
    // skips the check, saves always land, and a refresh resumes exactly here.
    void saveRecord(next, { expectedVersion: null });
  };

  /** Merge a standardization update onto the FRESHEST decisions in the store —
   * so editing one column never drops another column's just-saved decision
   * (a closure-merge would clobber it). Keeps save/resume lossless. */
  const patchStandardization = (update: Record<number, ColumnStandardization>) => {
    const fresh = (useAppStore.getState().records[modelId] ?? []).find((r) => r.id === recordId);
    const current = (fresh ? readMigrationData(fresh).standardization : data.standardization) ?? {};
    patch({ standardization: { ...current, ...update } });
  };

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-charcoal/60 text-sm">
        {isAr ? 'لم يتم العثور على عملية الترحيل.' : 'Migration not found.'}
      </div>
    );
  }

  const step: MigrationStep = data.step ?? 'pick_model';
  const targetModel = data.target_model_id
    ? models.find((m) => m.id === data.target_model_id)
    : undefined;
  // A completed migration is browsable: the operator can revisit every page +
  // the result (read-only — re-running is blocked, see StepPreview + the
  // startMigrationJob backstop). Older flows could only see the result.
  const isDone = data.status === 'done';
  // Which DONE_NAV chips are reachable (their step's data exists on the record).
  const canView = (s: MigrationStep): boolean => {
    if (s === 'done') return true;
    if (s === 'prep') return (data.prep_chat?.length ?? 0) > 0 || (data.prep_answered?.length ?? 0) > 0;
    if (s === 'review_raw') return !!data.raw_table;
    return !!data.raw_table && !!data.mappings; // mapping / standardize / preview
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-sand/20">
        <div className="font-semibold text-charcoal truncate">
          {(data.title ?? '').trim() || (isAr ? 'ترحيل جديد' : 'New migration')}
        </div>
        {targetModel && (
          <div className="text-xs text-charcoal/50 truncate">
            {isAr ? `إلى: ${targetModel.label_ar}` : `Into: ${targetModel.label_en}`}
          </div>
        )}
      </div>

      {/* View navigator — only for a COMPLETED migration: jump to any page +
          the result to review what was migrated (read-only; can't re-run). */}
      {isDone && (
        <div className="px-5 py-2 border-b border-sand/20 bg-cream-light/40 flex items-center gap-1.5 overflow-x-auto shrink-0">
          <span className="text-[11px] text-charcoal/45 font-bold shrink-0 me-1">
            {isAr ? 'عرض:' : 'View:'}
          </span>
          {DONE_NAV.map((s) => {
            const active = step === s.step;
            const enabled = canView(s.step);
            return (
              <button
                key={s.step}
                onClick={() => enabled && patch({ step: s.step })}
                disabled={!enabled}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  active ? 'bg-copper text-white' : 'text-charcoal/65 hover:bg-copper/10'
                }`}
              >
                {isAr ? s.ar : s.en}
              </button>
            );
          })}
        </div>
      )}

      {/* Body — step machine */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {step === 'pick_model' && (
          <div className="flex-1 overflow-y-auto">
            <StepPickModel
              isAr={isAr}
              models={models}
              onPick={(m) =>
                patch({
                  target_model_id: m.id,
                  title: isAr ? `ترحيل إلى ${m.label_ar}` : `Migrate into ${m.label_en}`,
                  step: 'upload',
                })
              }
            />
          </div>
        )}

        {step === 'upload' && targetModel && (
          <div className="flex-1 overflow-y-auto">
            <StepUpload
              isAr={isAr}
              recordId={recordId}
              model={targetModel}
              sourceFiles={data.source_files}
              onSourceFiles={(files) => patch({ source_files: files })}
              status={data.status}
              errorMessage={data.error_message}
              onProceed={() => patch({ step: 'prep' })}
              onTable={(table, sourceFiles, extras) =>
                patch({
                  raw_table: table,
                  step: 'review_raw',
                  source_files: sourceFiles,
                  project_document: extras?.projectDocument,
                  project_intelligence: extras?.projectIntelligence,
                })
              }
            />
          </div>
        )}

        {step === 'prep' && targetModel && (
          <div className="flex-1 min-h-0">
            <StepPrep
              isAr={isAr}
              recordId={recordId}
              model={targetModel}
              sourceFiles={data.source_files}
              instructions={data.extraction_instructions}
              onInstructions={(v) => patch({ extraction_instructions: v })}
              prepChat={data.prep_chat}
              prepStructure={data.prep_structure}
              prepReady={data.prep_ready}
              prepQuestions={data.prep_questions}
              prepAnswered={data.prep_answered}
              prepAnswersDraft={data.prep_answers_draft}
              onAnswersDraft={(draft) => patch({ prep_answers_draft: draft })}
              status={data.status}
              errorMessage={data.error_message}
              prepBusy={data.prep_busy}
              phase={data.phase}
              progressDone={data.progress_done}
              progressTotal={data.progress_total}
              onStartExtraction={() => void startExtractionJob(recordId)}
              onBack={() => patch({ step: 'upload' })}
              readOnly={isDone}
            />
          </div>
        )}

        {step === 'review_raw' && targetModel &&
          (data.raw_table ? (
            <div className="flex-1 min-h-0">
              <StepReviewRaw
                isAr={isAr}
                recordId={recordId}
                model={targetModel}
                table={data.raw_table}
                sourceFiles={data.source_files}
                chat={data.chat}
                discussBusy={data.discuss_busy}
                projectDocument={data.project_document}
                projectIntelligence={data.project_intelligence}
                onProjectDocument={(d) => patch({ project_document: d })}
                onChange={(t) => patch({ raw_table: t })}
                onReplace={(t) =>
                  patch({
                    raw_table: t,
                    mappings: undefined,
                    mapping_suggestions: undefined,
                    standardization: undefined,
                    chat: undefined,
                  })
                }
                onContinue={() => patch({ step: 'mapping' })}
                onBack={() => patch({ step: 'upload' })}
              />
            </div>
          ) : (
            // Defensive: step says review_raw but no table yet (e.g. an
            // interrupted extraction). The prep step is the extraction "home" —
            // it shows the resume/retry affordance.
            <div className="flex-1 min-h-0">
              <StepPrep
                isAr={isAr}
                recordId={recordId}
                model={targetModel}
                sourceFiles={data.source_files}
                instructions={data.extraction_instructions}
                onInstructions={(v) => patch({ extraction_instructions: v })}
                prepChat={data.prep_chat}
                prepStructure={data.prep_structure}
                prepReady={data.prep_ready}
                prepQuestions={data.prep_questions}
                prepAnswered={data.prep_answered}
                prepAnswersDraft={data.prep_answers_draft}
                onAnswersDraft={(draft) => patch({ prep_answers_draft: draft })}
                status={data.status}
                errorMessage={data.error_message}
                onStartExtraction={() => void startExtractionJob(recordId)}
                onBack={() => patch({ step: 'upload' })}
                readOnly={isDone}
              />
            </div>
          ))}

        {step === 'mapping' && targetModel && data.raw_table && (
          <div className="flex-1 min-h-0">
            <StepMapping
              isAr={isAr}
              model={targetModel}
              table={data.raw_table}
              mappings={data.mappings}
              suggestions={data.mapping_suggestions}
              onMappings={(m, s) => patch(s ? { mappings: m, mapping_suggestions: s } : { mappings: m })}
              onContinue={() => patch({ step: 'standardize' })}
              onBack={() => patch({ step: 'review_raw' })}
            />
          </div>
        )}

        {step === 'standardize' && targetModel && data.raw_table && data.mappings && (
          <div className="flex-1 min-h-0">
            <StepStandardize
              isAr={isAr}
              model={targetModel}
              table={data.raw_table}
              mappings={data.mappings}
              standardization={data.standardization}
              onChangeColumn={(ci, plan) => patchStandardization({ [ci]: plan })}
              onComputed={(std) => patchStandardization(std)}
              onProceed={() => patch({ step: 'preview' })}
              onBack={() => patch({ step: 'mapping' })}
            />
          </div>
        )}

        {step === 'preview' && targetModel && data.raw_table && data.mappings && (
          <div className="flex-1 min-h-0">
            <StepPreview
              isAr={isAr}
              model={targetModel}
              table={data.raw_table}
              mappings={data.mappings}
              standardization={data.standardization}
              projectDocument={data.project_document}
              projectIntelligence={data.project_intelligence}
              projectUpdateTargetId={data.project_update_target}
              onProjectUpdateTarget={(t) => patch({ project_update_target: t })}
              excludedRows={data.excluded_rows}
              onChangeExcluded={(next) => patch({ excluded_rows: next })}
              onConfirm={() => void startMigrationJob(recordId)}
              onBack={() => patch({ step: 'standardize' })}
              alreadyMigrated={isDone}
              onViewResult={() => patch({ step: 'done' })}
            />
          </div>
        )}

        {step === 'migrating' && targetModel && data.raw_table && data.mappings && (
          <div className="flex-1 min-h-0">
            <StepMigrating
              isAr={isAr}
              recordId={recordId}
              status={data.status}
              errorMessage={data.error_message}
              onBack={() => patch({ step: 'preview', status: 'draft', error_message: null })}
            />
          </div>
        )}

        {step === 'done' && targetModel && (
          <div className="flex-1 overflow-y-auto">
            <StepDone
              isAr={isAr}
              model={targetModel}
              result={data.result}
              onNewMigration={() => navigate('/model/data_migration')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
