import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import DynamicCell from '@/pages/Records/components/DynamicCell';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';

export interface DrillContext {
  sourceModelId: string;
  recordIds: string[];
  title: string;
}

/**
 * "Show me the records behind this number." Opened when a user clicks any
 * number / bar / slice / point. Lists the underlying records (reusing the record
 * table + DynamicCell); clicking a row opens it in RecordFormModal for view/edit.
 * Read-only on public dashboards (no row click → no write path for anon).
 */
export default function DrillThroughModal({
  ctx,
  onClose,
  isPublic,
}: {
  ctx: DrillContext | null;
  onClose: () => void;
  isPublic?: boolean;
}) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';
  const [editId, setEditId] = useState<string | null>(null);

  if (!ctx) return null;
  const model = models.find((m) => m.id === ctx.sourceModelId);
  const allFields = model?.schema.sections.flatMap((s) => s.fields) ?? [];
  const cols = allFields.filter((f) => f.show_in_table).slice(0, 6);
  const idSet = new Set(ctx.recordIds);
  const rows = (records[ctx.sourceModelId] ?? []).filter((r) => idSet.has(r.id));

  return (
    <>
      <Modal open onClose={onClose} title={`${ctx.title} · ${rows.length} ${isAr ? 'سجل' : 'records'}`} maxWidth="max-w-4xl">
        <div className="max-h-[60vh] overflow-x-auto">
          <table className="data-table text-xs">
            <thead>
              <tr>{cols.map((f) => <th key={f.id} className="px-2 py-1.5">{isAr ? f.label_ar : f.label_en}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((rec) => (
                <tr
                  key={rec.id}
                  className={isPublic ? '' : 'cursor-pointer hover:bg-cream'}
                  onClick={() => { if (!isPublic) setEditId(rec.id); }}
                >
                  {cols.map((f) => (
                    <td key={f.id} className="px-2 py-1.5">
                      <DynamicCell field={f} value={rec.data[f.name]} allRecords={records} recordData={rec.data} />
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={Math.max(cols.length, 1)} className="py-4 text-center text-charcoal/40">{isAr ? 'لا توجد سجلات' : 'No records'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Modal>
      {editId && !isPublic && (
        <RecordFormModal modelId={ctx.sourceModelId} recordId={editId} onClose={() => setEditId(null)} onSaved={() => setEditId(null)} />
      )}
    </>
  );
}
