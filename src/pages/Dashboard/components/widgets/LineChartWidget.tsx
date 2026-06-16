import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useAppStore } from '@/stores/appStore';
import { resultToChartData, type ChartDatum } from '../../lib/resultToChartData';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizLines } from '@/types';

const COPPER = '#B8734F';

export default function LineChartWidget({ widget, result, onDrill }: { widget: DashboardWidget; result: AnalyticsResult | null; onDrill?: (recordIds: string[], title: string) => void }) {
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const viz = effectiveViz(widget) as VizLines;
  const data = resultToChartData(result, isAr);
  const curve = viz.smooth ? 'monotone' : 'linear';
  const handleClick = onDrill
    ? (state: { activePayload?: Array<{ payload?: ChartDatum }> }) => {
        const p = state?.activePayload?.[0]?.payload;
        if (p) onDrill(p.recordIds ?? [], p.name);
      }
    : undefined;

  return (
    <ResponsiveContainer width="100%" height="100%">
      {viz.area ? (
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }} onClick={handleClick}>
          <CartesianGrid strokeDasharray="3 3" stroke="#D4B89640" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} reversed={isAr} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} orientation={isAr ? 'right' : 'left'} />
          <Tooltip />
          <Area dataKey="value" type={curve} stroke={COPPER} fill={`${COPPER}33`} strokeWidth={2} />
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }} onClick={handleClick}>
          <CartesianGrid strokeDasharray="3 3" stroke="#D4B89640" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} reversed={isAr} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} orientation={isAr ? 'right' : 'left'} />
          <Tooltip />
          <Line dataKey="value" type={curve} stroke={COPPER} strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}
