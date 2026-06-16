import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { resultToChartData } from '../../lib/resultToChartData';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizLeaderboard } from '@/types';

/**
 * Leaderboard: a single-level grouped result ranked descending by value, with a
 * rank number, an inline proportional bar, and the formatted value. Always sorts
 * + caps to max_rows in the renderer so it looks like a leaderboard regardless of
 * the query's own sort. Every row drills to its records.
 */
export default function LeaderboardWidget({
  widget,
  result,
  onDrill,
}: {
  widget: DashboardWidget;
  result: AnalyticsResult | null;
  onDrill?: (recordIds: string[], title: string) => void;
}) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizLeaderboard;
  const ranked = resultToChartData(result, isAr)
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, viz.max_rows ?? 10);
  const max = Math.max(1, ...ranked.map((d) => d.value));
  const single = viz.color_mode?.kind === 'single' ? viz.color_mode.color : null;

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-y-auto px-2 py-1.5">
      {ranked.map((d, i) => (
        <div
          key={d.raw + i}
          className={`flex items-center gap-2 rounded px-1 py-0.5 ${onDrill ? 'cursor-pointer hover:bg-cream-light' : ''}`}
          role={onDrill ? 'button' : undefined}
          onClick={onDrill ? () => onDrill(d.recordIds ?? [], d.name) : undefined}
        >
          <span className="w-5 shrink-0 text-center text-[11px] font-bold text-charcoal/40">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-charcoal/70">{d.name}</span>
              <span dir="ltr" className="shrink-0 font-bold text-charcoal/90">
                {formatNumber(d.value, viz.number_format)}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-sand/30">
              <div className="h-full rounded" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: single ?? d.color }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
