import { useAppStore } from '@/stores/appStore';
import { applyConditions } from '@/lib/dashboardUtils';
import DynamicCell from '@/pages/Records/components/DynamicCell';
import type { DashboardWidget, WidgetConfigTable } from '@/types';

interface TableWidgetProps {
  widget: DashboardWidget;
  isPublic?: boolean;
}

export default function TableWidget({ widget }: TableWidgetProps) {
  const { records, models, language, records: allRecords } = useAppStore();
  const isAr = language === 'ar';
  const config = widget.config as WidgetConfigTable;

  const model = models.find((m) => m.id === widget.source_model_id);
  const allFields = model?.schema.sections.flatMap((s) => s.fields) ?? [];
  const shownFields = config.field_ids.map((id) => allFields.find((f) => f.id === id)).filter(Boolean);
  const modelRecords = records[widget.source_model_id] ?? [];

  let filtered = applyConditions(modelRecords, config.conditions, allFields);

  // Sort
  if (config.sort_field_id) {
    const sf = allFields.find((f) => f.id === config.sort_field_id);
    if (sf) {
      filtered = [...filtered].sort((a, b) => {
        const va = String(a.data[sf.name] ?? '');
        const vb = String(b.data[sf.name] ?? '');
        return config.sort_direction === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
  }

  filtered = filtered.slice(0, config.max_rows || 10);

  return (
    <div className="overflow-x-auto h-full">
      <table className="data-table text-xs">
        <thead>
          <tr>
            {shownFields.map((f) => f && (
              <th key={f.id} className="py-1.5 px-2">{isAr ? f.label_ar : f.label_en}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((rec) => (
            <tr key={rec.id}>
              {shownFields.map((f) => f && (
                <td key={f.id} className="py-1.5 px-2">
                  <DynamicCell field={f} value={rec.data[f.name]} allRecords={allRecords} recordData={rec.data} recordId={rec.id} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
