import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useAppStore } from '@/stores/appStore';
import { resultToChartData } from '../../lib/resultToChartData';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizBars } from '@/types';

export default function BarChartWidget({ widget, result, onDrill }: { widget: DashboardWidget; result: AnalyticsResult | null; onDrill?: (recordIds: string[], title: string) => void }) {
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const viz = effectiveViz(widget) as VizBars;
  const data = resultToChartData(result, isAr);
  const single = viz.color_mode?.kind === 'single' ? viz.color_mode.color : null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
        <XAxis dataKey="name" tick={{ fontSize: 11 }} reversed={isAr} interval={0} angle={data.length > 5 ? -25 : 0} textAnchor={data.length > 5 ? 'end' : 'middle'} height={data.length > 5 ? 50 : 30} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} orientation={isAr ? 'right' : 'left'} />
        <Tooltip />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} cursor={onDrill ? 'pointer' : undefined} onClick={onDrill ? (_d, index) => onDrill(data[index]?.recordIds ?? [], data[index]?.name ?? '') : undefined}>
          {data.map((entry, i) => (
            <Cell key={i} fill={single ?? entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
