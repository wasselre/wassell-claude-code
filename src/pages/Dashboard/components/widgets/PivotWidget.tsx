import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { resultToSeries } from '../../lib/resultToChartData';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizPivot } from '@/types';

/**
 * Pivot table: the two-level grouped result as a matrix — first level down the
 * rows, second level across the columns, the aggregated value in each cell.
 * Collapses to a one-column table when only one group level is set. A blank cell
 * (no row for that combination) shows a dash.
 */
export default function PivotWidget({ widget, result }: { widget: DashboardWidget; result: AnalyticsResult | null }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizPivot;
  const { data, series } = resultToSeries(result, isAr);

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-sand/50">
            <th className="p-1.5 text-start font-bold text-charcoal/40"></th>
            {series.map((s) => (
              <th key={s.key} className="p-1.5 text-end font-bold text-charcoal/60">{s.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b border-sand/20 hover:bg-cream-light">
              <td className="max-w-[140px] truncate p-1.5 text-start font-bold text-charcoal/70">{row.name}</td>
              {series.map((s) => {
                const v = row[s.key];
                return (
                  <td key={s.key} className="p-1.5 text-end text-charcoal/80" dir="ltr">
                    {typeof v === 'number' ? formatNumber(v, viz.number_format) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
