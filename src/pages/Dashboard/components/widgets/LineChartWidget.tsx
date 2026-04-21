import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useAppStore } from '@/stores/appStore';
import { groupRecordsByDate } from '@/lib/dashboardUtils';
import type { DashboardWidget, WidgetConfigLine } from '@/types';

interface LineChartWidgetProps {
  widget: DashboardWidget;
}

export default function LineChartWidget({ widget }: LineChartWidgetProps) {
  const { records, models } = useAppStore();
  const config = widget.config as WidgetConfigLine;

  const model = models.find((m) => m.id === widget.source_model_id);
  const allFields = model?.schema.sections.flatMap((s) => s.fields) ?? [];
  const dateField = allFields.find((f) => f.id === config.date_field_id);
  const modelRecords = records[widget.source_model_id] ?? [];

  if (!dateField) return <div className="text-sm text-charcoal/30 text-center">Configure date field</div>;

  const data = groupRecordsByDate(modelRecords, dateField, config.period, config.conditions, allFields);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip />
        <Line type="monotone" dataKey="count" stroke="#B8734F" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
