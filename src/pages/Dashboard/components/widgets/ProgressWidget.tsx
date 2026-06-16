import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizProgress } from '@/types';

/**
 * Progress: the scalar total as a linear bar filling to value/target. Target
 * defaults to 100 for percent metrics. The bar visually clamps to 100% but the
 * label shows the true attainment % (which may exceed 100). Drills to records.
 */
export default function ProgressWidget({
  widget,
  result,
  onDrill,
}: {
  widget: DashboardWidget;
  result: AnalyticsResult | null;
  onDrill?: (recordIds: string[], title: string) => void;
}) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizProgress;
  const value = result?.total ?? 0;
  const target = viz.target && viz.target > 0 ? viz.target : viz.number_format?.percent ? 100 : null;
  const ratio = target ? value / target : viz.number_format?.percent ? value / 100 : 0;
  const visual = Math.max(0, Math.min(1, ratio)) * 100;
  const title = isAr ? widget.title_ar : widget.title_en;
  const drillIds = result?.rows?.flatMap((r) => r.recordIds ?? []) ?? [];
  const color = viz.color ?? '#B8734F';

  return (
    <div
      className={`flex h-full flex-col justify-center gap-2 px-4 ${onDrill ? 'cursor-pointer' : ''}`}
      role={onDrill ? 'button' : undefined}
      onClick={onDrill ? () => onDrill(drillIds, title) : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-charcoal/60">{title}</span>
        <span className="shrink-0 text-xl font-bold" style={{ color }} dir="ltr">
          {formatNumber(value, viz.number_format)}
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-sand/30">
        <div className="h-full rounded-full transition-all" style={{ width: `${visual}%`, backgroundColor: color }} />
      </div>
      {target != null && (
        <div className="flex items-center justify-between text-[11px] text-charcoal/40">
          <span dir="ltr" className="font-medium" style={{ color }}>{(ratio * 100).toFixed(0)}%</span>
          <span dir="ltr">{isAr ? 'الهدف' : 'Target'}: {formatNumber(target, viz.number_format)}</span>
        </div>
      )}
    </div>
  );
}
