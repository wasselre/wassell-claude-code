import { Loader2, AlertCircle, ArrowRight, ArrowLeft, RotateCcw, PauseCircle } from 'lucide-react';
import { startMigrationJob, useMigrationJobs } from '../../lib/jobRunner';
import type { MigrationStatus } from '../../lib/types';

interface StepMigratingProps {
  isAr: boolean;
  recordId: string;
  status: MigrationStatus | undefined;
  errorMessage: string | null | undefined;
  onBack: () => void;
}

/**
 * Pure VIEWER of the migration job — the import itself runs in the module
 * jobRunner (started by the preview step's confirm), so it survives this
 * component unmounting and never double-starts on remount. Three states:
 * running (progress from the job store), failed (persisted error + retry),
 * and interrupted (record says migrating but no job — a page reload killed
 * the in-tab run) with an explicit resume.
 */
export default function StepMigrating({
  isAr,
  recordId,
  status,
  errorMessage,
  onBack,
}: StepMigratingProps) {
  const job = useMigrationJobs((s) => s.jobs[recordId]);
  const Back = isAr ? ArrowRight : ArrowLeft;

  if (!job && status === 'failed' && errorMessage) {
    return (
      <div className="flex flex-col items-center justify-center text-center p-10 gap-3 h-full">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center">
          <AlertCircle size={28} className="text-red-500" />
        </div>
        <div className="font-semibold text-charcoal">{isAr ? 'فشل الترحيل' : 'Migration failed'}</div>
        <p className="text-sm text-charcoal/60 max-w-md">{errorMessage}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
          >
            <Back size={15} />
            {isAr ? 'رجوع' : 'Back'}
          </button>
          <button
            onClick={() => void startMigrationJob(recordId)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-copper text-white hover:bg-terracotta transition-colors"
          >
            <RotateCcw size={15} />
            {isAr ? 'إعادة المحاولة' : 'Retry'}
          </button>
        </div>
      </div>
    );
  }

  if (!job) {
    // Record says migrating but no job is running in this tab — a reload (or
    // another tab) interrupted the run. Resume is explicit, never automatic:
    // rows saved before the interruption are skipped again only when the
    // model has a duplicate-check field.
    return (
      <div className="flex flex-col items-center justify-center text-center p-10 gap-3 h-full">
        <div className="w-14 h-14 rounded-full bg-gold/15 flex items-center justify-center">
          <PauseCircle size={28} className="text-gold" />
        </div>
        <div className="font-semibold text-charcoal">
          {isAr ? 'توقّف الترحيل' : 'Migration was interrupted'}
        </div>
        <p className="text-sm text-charcoal/60 max-w-md">
          {isAr
            ? 'انقطع الترحيل (غالبًا بسبب إعادة تحميل الصفحة). يمكنك استئنافه — إذا كان للنموذج حقل فحص التكرار فستُتخطى الصفوف المرحّلة سابقًا.'
            : 'The run was interrupted (usually a page reload). You can resume it — rows already imported are skipped when the model has a duplicate-check field.'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
          >
            <Back size={15} />
            {isAr ? 'رجوع' : 'Back'}
          </button>
          <button
            onClick={() => void startMigrationJob(recordId)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-copper text-white hover:bg-terracotta transition-colors"
          >
            <RotateCcw size={15} />
            {isAr ? 'استئناف الترحيل' : 'Resume migration'}
          </button>
        </div>
      </div>
    );
  }

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className="flex flex-col items-center justify-center text-center p-12 gap-4 h-full">
      <Loader2 size={32} className="text-copper animate-spin" />
      <div className="font-semibold text-charcoal">
        {isAr ? 'جارٍ ترحيل البيانات…' : 'Migrating data…'}
      </div>
      <div className="w-full max-w-xs">
        <div className="h-2 rounded-full bg-sand/30 overflow-hidden">
          <div className="h-full bg-copper transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-xs text-charcoal/50 mt-1.5">
          {isAr ? `${job.done} من ${job.total}` : `${job.done} of ${job.total}`}
        </div>
      </div>
      <p className="text-xs text-charcoal/40 max-w-sm">
        {isAr
          ? 'يستمر الترحيل في الخلفية — يمكنك فتح ترحيل آخر أو بدء واحد جديد الآن.'
          : 'The migration keeps running in the background — you can open or start another one now.'}
      </p>
    </div>
  );
}
