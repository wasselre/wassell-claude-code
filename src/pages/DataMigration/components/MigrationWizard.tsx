import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { readMigrationData, type MigrationData, type MigrationStep } from '../lib/types';
import StepPickModel from './steps/StepPickModel';
import StepUpload from './steps/StepUpload';
import StepReviewRaw from './steps/StepReviewRaw';
import StepMapping from './steps/StepMapping';
import StepStandardize from './steps/StepStandardize';
import StepMigrating from './steps/StepMigrating';
import StepDone from './steps/StepDone';

interface MigrationWizardProps {
  recordId: string;
  modelId: string;
}

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
    if (!record) return;
    const next: AppRecord = {
      ...record,
      data: { ...record.data, ...partial },
      updated_at: new Date().toISOString(),
    };
    void saveRecord(next);
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

        {step === 'upload' && (
          <div className="flex-1 overflow-y-auto">
            <StepUpload
              isAr={isAr}
              recordId={recordId}
              onTable={(table) => patch({ raw_table: table, step: 'review_raw' })}
            />
          </div>
        )}

        {step === 'review_raw' &&
          (data.raw_table ? (
            <div className="flex-1 min-h-0">
              <StepReviewRaw
                isAr={isAr}
                table={data.raw_table}
                onChange={(t) => patch({ raw_table: t })}
                onReplace={(t) => patch({ raw_table: t, mappings: undefined })}
                onContinue={() => patch({ step: 'mapping' })}
                onBack={() => patch({ step: 'upload' })}
              />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <StepUpload
                isAr={isAr}
                recordId={recordId}
                onTable={(table) => patch({ raw_table: table, step: 'review_raw' })}
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
              onChangeColumn={(ci, plan) =>
                patch({ standardization: { ...(data.standardization ?? {}), [ci]: plan } })
              }
              onMigrate={() => patch({ step: 'migrating', status: 'migrating' })}
              onBack={() => patch({ step: 'mapping' })}
            />
          </div>
        )}

        {step === 'migrating' && targetModel && data.raw_table && data.mappings && (
          <div className="flex-1 min-h-0">
            <StepMigrating
              isAr={isAr}
              model={targetModel}
              table={data.raw_table}
              mappings={data.mappings}
              standardization={data.standardization}
              onDone={(result) => patch({ result, step: 'done', status: 'done' })}
              onBack={() => patch({ step: 'standardize', status: 'draft' })}
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
