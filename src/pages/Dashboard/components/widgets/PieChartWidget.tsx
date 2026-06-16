import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useAppStore } from '@/stores/appStore';
import { resultToChartData } from '../../lib/resultToChartData';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizPies } from '@/types';

export default function PieChartWidget({ widget, result, onDrill }: { widget: DashboardWidget; result: AnalyticsResult | null; onDrill?: (recordIds: string[], title: string) => void }) {
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const viz = effectiveViz(widget) as VizPies;
  const data = resultToChartData(result, isAr).filter((d) => d.value > 0);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="45%" innerRadius={viz.donut ? '50%' : 0} outerRadius="70%" paddingAngle={1} cursor={onDrill ? 'pointer' : undefined} onClick={onDrill ? (_d, index) => onDrill(data[index]?.recordIds ?? [], data[index]?.name ?? '') : undefined}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip />
        {viz.show_legend !== false && <Legend wrapperStyle={{ fontSize: 11 }} />}
      </PieChart>
    </ResponsiveContainer>
  );
}
