import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useAppStore } from '@/stores/appStore';
import { groupRecordsByField } from '@/lib/dashboardUtils';
import type { DashboardWidget, WidgetConfigChart } from '@/types';

interface PieChartWidgetProps {
  widget: DashboardWidget;
}

export default function PieChartWidget({ widget }: PieChartWidgetProps) {
  const { records, models, language } = useAppStore();
  const isAr = language === 'ar';
  const config = widget.config as WidgetConfigChart;

  const model = models.find((m) => m.id === widget.source_model_id);
  const allFields = model?.schema.sections.flatMap((s) => s.fields) ?? [];
  const groupField = allFields.find((f) => f.id === config.group_by_field_id);
  const modelRecords = records[widget.source_model_id] ?? [];

  if (!groupField) return <div className="text-sm text-charcoal/30 text-center">Configure group by field</div>;

  const data = groupRecordsByField(modelRecords, groupField, config.conditions, allFields)
    .filter((d) => d.count > 0)
    .map((d) => ({ name: isAr ? d.label_ar : d.label_en, value: d.count, color: d.color }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius="70%" label>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}
