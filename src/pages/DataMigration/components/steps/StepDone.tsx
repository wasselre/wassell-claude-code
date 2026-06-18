import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Plus, ExternalLink, AlertTriangle } from 'lucide-react';
import type { AppModel } from '@/types';
import type { MigrationResult } from '../../lib/types';

interface StepDoneProps {
  isAr: boolean;
  model: AppModel;
  result: MigrationResult | undefined;
  onNewMigration: () => void;
}

export default function StepDone({ isAr, model, result, onNewMigration }: StepDoneProps) {
  const navigate = useNavigate();
  const r = result ?? { imported: 0, skipped: 0, new_lookup_records: 0, new_options: 0, invalid_skipped: 0, errors: [] };
  const modelLabel = isAr ? model.label_ar : model.label_en;

  return (
    <div className="flex flex-col items-center justify-center text-center p-10 gap-3 h-full">
      <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
        <CheckCircle2 size={34} className="text-green-500" />
      </div>
      <h3 className="text-xl font-bold text-charcoal">{isAr ? 'تم الترحيل بنجاح' : 'Migration complete'}</h3>
      <p className="text-charcoal/60">
        {isAr
          ? `تم ترحيل ${r.imported} سجل إلى ${modelLabel}`
          : `Imported ${r.imported} records into ${modelLabel}`}
      </p>
      <div className="text-xs text-charcoal/45 space-y-0.5">
        {r.new_lookup_records > 0 && (
          <div>{isAr ? `+${r.new_lookup_records} سجل مرتبط جديد` : `+${r.new_lookup_records} new linked records`}</div>
        )}
        {r.new_options > 0 && (
          <div>{isAr ? `+${r.new_options} خيار جديد في النموذج` : `+${r.new_options} new options added`}</div>
        )}
        {r.skipped > 0 && (
          <div>{isAr ? `تم تخطي ${r.skipped} مكرر` : `${r.skipped} duplicates skipped`}</div>
        )}
        {r.invalid_skipped > 0 && (
          <div className="text-amber-600">
            {isAr ? `تم تجاوز ${r.invalid_skipped} صف غير صالح` : `${r.invalid_skipped} invalid rows skipped`}
          </div>
        )}
      </div>
      {r.errors.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-charcoal/70 max-w-md">
          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <span>
            {isAr ? `${r.errors.length} سجل لم يُحفظ` : `${r.errors.length} records failed to save`}
            {r.errors[0] ? ` — ${r.errors[0].error}` : ''}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={() => navigate(`/model/${model.name}`)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors font-medium"
        >
          <ExternalLink size={15} />
          {isAr ? 'فتح النموذج' : 'Open model'}
        </button>
        <button
          onClick={onNewMigration}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-sand/40 text-charcoal hover:bg-cream transition-colors"
        >
          <Plus size={15} />
          {isAr ? 'ترحيل جديد' : 'New migration'}
        </button>
      </div>
    </div>
  );
}
