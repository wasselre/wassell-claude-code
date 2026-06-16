import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { resultToSeries } from '../../lib/resultToChartData';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizHeatmap } from '@/types';

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Heatmap: the two-level grouped result as a colored density matrix — first
 * level down the rows, second across the columns, each cell shaded by its value
 * relative to the largest cell. Reuses the pivot's 2-level shape.
 */
export default function HeatmapWidget({ widget, result }: { widget: DashboardWidget; result: AnalyticsResult | null }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizHeatmap;
  const base = viz.color ?? '#B8734F';
  const { data, series } = resultToSeries(result, isAr);
  const max = Math.max(1, ...data.flatMap((row) => series.map((s) => (typeof row[s.key] === 'number' ? (row[s.key] as number) : 0))));

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-[10px]">
        <thead className="sticky top-0 bg-white">
          <tr>
            <th className="p-1 text-start"></th>
            {series.map((s) => (
              <th key={s.key} className="max-w-[80px] truncate p-1 text-center font-bold text-charcoal/55">{s.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              <td className="max-w-[110px] truncate p-1 text-start font-bold text-charcoal/65">{row.name}</td>
              {series.map((s) => {
                const v = typeof row[s.key] === 'number' ? (row[s.key] as number) : 0;
                const intensity = v / max;
                return (
                  <td
                    key={s.key}
                    className="p-1.5 text-center font-medium"
                    dir="ltr"
                    style={{ backgroundColor: rgba(base, v === 0 ? 0.04 : 0.12 + intensity * 0.85), color: intensity > 0.55 ? '#fff' : '#4A4E54' }}
                  >
                    {v ? formatNumber(v, viz.number_format) : ''}
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
