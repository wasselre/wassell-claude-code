import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizStat } from '@/types';

interface Props {
  widget: DashboardWidget;
  result: AnalyticsResult | null;
  onDrill?: (recordIds: string[], title: string) => void;
}

export default function StatWidget({ widget, result, onDrill }: Props) {
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const viz = effectiveViz(widget) as VizStat;
  const value = result?.total ?? null;
  const comp = result?.comparison;
  const title = isAr ? widget.title_ar : widget.title_en;
  const drillIds = result?.rows[0]?.recordIds ?? [];

  const good = viz.comparison?.good_direction ?? 'up';
  const delta = comp?.delta_pct ?? null;
  const positive = (delta ?? 0) >= 0;
  const isGood = good === 'up' ? positive : !positive;
  const deltaColor = delta === null ? '#9ca3af' : isGood ? '#15803d' : '#b91c1c';

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div
        className={`text-4xl font-bold ${onDrill ? 'cursor-pointer hover:opacity-80' : ''}`}
        style={{ color: viz.color ?? '#B8734F' }}
        dir="ltr"
        role={onDrill ? 'button' : undefined}
        onClick={onDrill ? () => onDrill(drillIds, title) : undefined}
      >
        {formatNumber(value, viz.number_format)}
      </div>
      <div className="text-sm text-charcoal/50 mt-1 text-center px-2">{title}</div>
      {viz.comparison && delta !== null && (
        <div className="text-xs mt-1 font-medium" style={{ color: deltaColor }} dir="ltr">
          {positive ? '↑' : '↓'} {Math.abs(delta).toFixed(0)}% {isAr ? 'مقارنة بالفترة السابقة' : 'vs prev.'}
        </div>
      )}
    </div>
  );
}
