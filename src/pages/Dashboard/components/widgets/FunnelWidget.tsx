import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { resultToChartData } from '../../lib/resultToChartData';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizFunnel } from '@/types';

/**
 * Funnel: a single-level grouped result rendered as descending stages. Preserves
 * the engine's group order (so pipeline stages stay New → … → Won, not sorted by
 * size) and scales each centered bar to the largest stage. Every stage drills to
 * its records. Brand colors per group option, or a single override.
 */
export default function FunnelWidget({
  widget,
  result,
  onDrill,
}: {
  widget: DashboardWidget;
  result: AnalyticsResult | null;
  onDrill?: (recordIds: string[], title: string) => void;
}) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizFunnel;
  const data = resultToChartData(result, isAr);
  const max = Math.max(1, ...data.map((d) => d.value));
  const single = viz.color_mode?.kind === 'single' ? viz.color_mode.color : null;

  return (
    <div className="flex h-full flex-col justify-center gap-2 overflow-y-auto px-3 py-2">
      {data.map((d, i) => {
        const pct = (d.value / max) * 100;
        return (
          <div key={d.raw + i} className="flex flex-col items-center">
            <div className="mb-0.5 flex w-full items-center justify-between gap-2 text-[11px] text-charcoal/60">
              <span className="truncate">{d.name}</span>
              <span dir="ltr" className="shrink-0 font-bold text-charcoal/80">
                {formatNumber(d.value, viz.number_format)}
                {viz.show_pct ? ` · ${pct.toFixed(0)}%` : ''}
              </span>
            </div>
            <div
              className={`h-6 rounded-md transition-all ${onDrill ? 'cursor-pointer hover:opacity-80' : ''}`}
              style={{ width: `${Math.max(pct, 4)}%`, backgroundColor: single ?? d.color }}
              role={onDrill ? 'button' : undefined}
              onClick={onDrill ? () => onDrill(d.recordIds ?? [], d.name) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
