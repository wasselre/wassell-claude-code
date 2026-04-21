import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useAppStore } from '@/stores/appStore';
import { groupRecordsByField } from '@/lib/dashboardUtils';
import type { DashboardWidget, WidgetConfigChart } from '@/types';

interface BarChartWidgetProps {
  widget: DashboardWidget;
}

export default function BarChartWidget({ widget }: BarChartWidgetProps) {
  const { records, models, language } = useAppStore();
  const isAr = language === 'ar';
  const config = widget.config as WidgetConfigChart;

  const model = models.find((m) => m.id === widget.source_model_id);
  const allFields = model?.schema.sections.flatMap((s) => s.fields) ?? [];
  const groupField = allFields.find((f) => f.id === config.group_by_field_id);
  const modelRecords = records[widget.source_model_id] ?? [];

  if (!groupField) return <div className="text-sm text-charcoal/30 text-center">Configure group by field</div>;

  const data = groupRecordsByField(modelRecords, groupField, config.conditions, allFields)
    .map((d) => ({ name: isAr ? d.label_ar : d.label_en, count: d.count, color: d.color }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
