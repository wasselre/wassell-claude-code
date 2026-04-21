import { useAppStore } from '@/stores/appStore';
import { applyConditions } from '@/lib/dashboardUtils';
import type { DashboardWidget, WidgetConfigStat } from '@/types';

interface StatWidgetProps {
  widget: DashboardWidget;
}

export default function StatWidget({ widget }: StatWidgetProps) {
  const { records, models, language } = useAppStore();
  const isAr = language === 'ar';
  const config = widget.config as WidgetConfigStat;

  const model = models.find((m) => m.id === widget.source_model_id);
  const allFields = model?.schema.sections.flatMap((s) => s.fields) ?? [];
  const modelRecords = records[widget.source_model_id] ?? [];
  const filtered = applyConditions(modelRecords, config.conditions, allFields);

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-4xl font-bold" style={{ color: config.color ?? '#B8734F' }}>
        {filtered.length}
      </div>
      <div className="text-sm text-charcoal/50 mt-1">
        {isAr ? widget.title_ar : widget.title_en}
      </div>
    </div>
  );
}
