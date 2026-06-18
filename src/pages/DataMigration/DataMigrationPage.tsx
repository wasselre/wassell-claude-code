import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Database, Plus } from 'lucide-react';
import type { AppRecord } from '@/types';
import { DATA_MIGRATION_MODEL_NAME } from './lib/types';
import { useMigrationJobs } from './lib/jobRunner';
import MigrationWizard from './components/MigrationWizard';
import MigrationList from './components/MigrationList';

/**
 * Two-pane "Data Migration" layout. Left = list of past migrations (records
 * in the `data_migration` model). Right = the active migration wizard (pick
 * model → upload → extract → review → map → standardize → migrate → done).
 * Routes `/model/data_migration` and `/model/data_migration/:recordId` both
 * land here via the dispatcher in App.tsx.
 *
 * Each migration is one `data_migration` record. The whole wizard state —
 * target model, raw table, column mappings, value-standardization decisions,
 * result summary — lives on `record.data`, so reload / navigate-away both
 * resume at the exact step. Mirrors the Decks pipeline shell.
 */
export default function DataMigrationPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const currentUserId = useAppStore((s) => s.currentUserId);
  // Live jobs (extract / migrate) keyed by record id — any number can run at
  // once; each row shows its own progress.
  const jobs = useMigrationJobs((s) => s.jobs);

  const migrationModel = useMemo(
    () => models.find((m) => m.name === DATA_MIGRATION_MODEL_NAME),
    [models],
  );
  const migrations = useMemo<AppRecord[]>(() => {
    if (!migrationModel) return [];
    const all = recordsByModel[migrationModel.id] ?? [];
    return [...all].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [migrationModel, recordsByModel]);

  function startNewMigration() {
    if (!migrationModel) return;
    const now = new Date().toISOString();
    const newId = uuid();
    const record: AppRecord = {
      id: newId,
      model_id: migrationModel.id,
      data: {
        title: '',
        status: 'draft',
        step: 'pick_model',
        created_by: currentUserId,
      },
      created_at: now,
      updated_at: now,
    };
    void saveRecord(record);
    navigate(`/model/data_migration/${newId}`);
  }

  if (!migrationModel) {
    return (
      <div className="p-8 text-center text-charcoal/70">
        {isAr
          ? 'نموذج ترحيل البيانات غير مهيأ بعد. أعد تحميل الصفحة.'
          : 'Data Migration model not initialized. Please reload.'}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex overflow-hidden rounded-2xl border border-sand/20 bg-white">
      {/* Left pane — list + new-migration button */}
      <div
        className={`w-full md:w-[320px] shrink-0 border-e border-sand/20 flex-col ${
          recordId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="p-3 border-b border-sand/20">
          <button
            onClick={startNewMigration}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            {isAr ? 'ترحيل جديد' : 'New migration'}
          </button>
        </div>
        <MigrationList
          isAr={isAr}
          migrations={migrations}
          models={models}
          modelId={migrationModel.id}
          activeId={recordId}
          jobs={jobs}
          onOpen={(id) => navigate(`/model/data_migration/${id}`)}
        />
      </div>

      {/* Right pane — active migration or welcome */}
      <div className={`flex-1 min-w-0 flex-col ${!recordId ? 'hidden md:flex' : 'flex'}`}>
        {recordId ? (
          <MigrationWizard key={recordId} recordId={recordId} modelId={migrationModel.id} />
        ) : (
          <EmptyPane isAr={isAr} onStart={startNewMigration} />
        )}
      </div>
    </div>
  );
}

function EmptyPane({ isAr, onStart }: { isAr: boolean; onStart: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-copper/10 flex items-center justify-center mb-4">
        <Database size={32} className="text-copper" />
      </div>
      <h2 className="text-xl font-semibold text-charcoal mb-2">
        {isAr ? 'ترحيل البيانات' : 'Data Migration'}
      </h2>
      <p className="text-sm text-charcoal/70 max-w-md mb-6">
        {isAr
          ? 'حوّل بيانات المطوّرين من أي صيغة — Excel أو PDF أو صور — إلى سجلات نظيفة داخل أي نموذج. يستخرج التطبيق البيانات، يقترح الربط، ويوحّد القيم، وأنت توافق على كل تعديل قبل الترحيل.'
          : "Turn developers' data from any format — Excel, PDF, screenshots — into clean records in any model. The app extracts, suggests mappings, and standardizes values; you approve every change before it migrates."}
      </p>
      <button
        onClick={onStart}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors"
      >
        <Plus size={16} />
        {isAr ? 'ترحيل جديد' : 'New migration'}
      </button>
    </div>
  );
}
