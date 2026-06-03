import { useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Loader2, AlertCircle, ArrowRight, ArrowLeft } from 'lucide-react';
import { runMigration } from '../../lib/runMigration';
import type { AppModel } from '@/types';
import type { RawTable, ColumnStandardization, MigrationResult } from '../../lib/types';

interface StepMigratingProps {
  isAr: boolean;
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization> | undefined;
  excludedRows: number[] | undefined;
  onDone: (result: MigrationResult) => void;
  onBack: () => void;
}

export default function StepMigrating({
  isAr,
  model,
  table,
  mappings,
  standardization,
  excludedRows,
  onDone,
  onBack,
}: StepMigratingProps) {
  const saveModel = useAppStore((s) => s.saveModel);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const allModels = useAppStore((s) => s.models);
  const allRecords = useAppStore((s) => s.records);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const Back = isAr ? ArrowRight : ArrowLeft;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const result = await runMigration({
          model,
          table,
          mappings,
          standardization: standardization ?? {},
          excludedRows,
          allModels,
          allRecords,
          createdBy: currentUserId,
          saveModel,
          saveRecord,
          makeId: uuid,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        onDone(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        addToast(msg, 'error');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center text-center p-10 gap-3 h-full">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center">
          <AlertCircle size={28} className="text-red-500" />
        </div>
        <div className="font-semibold text-charcoal">{isAr ? 'فشل الترحيل' : 'Migration failed'}</div>
        <p className="text-sm text-charcoal/60 max-w-md">{error}</p>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
      </div>
    );
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
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
          {isAr ? `${progress.done} من ${progress.total}` : `${progress.done} of ${progress.total}`}
        </div>
      </div>
    </div>
  );
}
