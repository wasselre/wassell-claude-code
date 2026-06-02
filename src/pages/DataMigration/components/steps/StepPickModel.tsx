import { getIconComponent } from '@/components/layout/Sidebar';
import type { AppModel } from '@/types';
import { listTargetModels } from '../../lib/types';

interface StepPickModelProps {
  isAr: boolean;
  models: AppModel[];
  onPick: (model: AppModel) => void;
}

/**
 * Step 1 — choose the target model. Lists every importable model (custom-UI
 * and singleton/sidecar models are excluded via `listTargetModels`).
 */
export default function StepPickModel({ isAr, models, onPick }: StepPickModelProps) {
  const targets = listTargetModels(models)
    .slice()
    .sort((a, b) => (isAr ? a.label_ar : a.label_en).localeCompare(isAr ? b.label_ar : b.label_en));

  return (
    <div className="p-5">
      <h3 className="font-bold text-charcoal mb-1">
        {isAr ? 'اختر النموذج الذي تريد الترحيل إليه' : 'Choose the model to migrate into'}
      </h3>
      <p className="text-sm text-charcoal/50 mb-4">
        {isAr ? 'سيتم استيراد السجلات إلى هذا النموذج.' : 'Records will be imported into this model.'}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {targets.map((m) => {
          const Icon = getIconComponent(m.icon ?? 'database');
          const color = m.color ?? '#B8734F';
          return (
            <button
              key={m.id}
              onClick={() => onPick(m)}
              className="flex flex-col items-start gap-2 p-4 rounded-xl border border-sand/30 bg-white hover:border-copper/40 hover:bg-copper/[0.02] transition-colors text-start"
            >
              <span
                className="w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: `${color}1a` }}
              >
                <Icon size={18} style={{ color }} />
              </span>
              <span className="text-sm font-medium text-charcoal truncate w-full">
                {isAr ? m.label_ar : m.label_en}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
