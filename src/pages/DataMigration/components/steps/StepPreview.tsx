import { useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, ArrowLeft, PlayCircle, AlertTriangle } from 'lucide-react';
import { buildMigrationPlan } from '../../lib/runMigration';
import { resolveDisplay } from '../../lib/previewRecords';
import type { AppModel, ModelField } from '@/types';
import type { RawTable, ColumnStandardization } from '../../lib/types';

interface StepPreviewProps {
  isAr: boolean;
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization> | undefined;
  excludedRows: number[] | undefined;
  onChangeExcluded: (next: number[]) => void;
  onConfirm: () => void;
  onBack: () => void;
}

const RENDER_CAP = 500;

/**
 * Step "preview" — the final approval gate. Builds the exact records that would
 * be created (no writes) via the shared `buildMigrationPlan`, shows them in a
 * table with resolved display values, and lets the user approve/exclude each
 * record. Only approved records are migrated.
 */
export default function StepPreview({
  isAr,
  model,
  table,
  mappings,
  standardization,
  excludedRows,
  onChangeExcluded,
  onConfirm,
  onBack,
}: StepPreviewProps) {
  const allModels = useAppStore((s) => s.models);
  const allRecords = useAppStore((s) => s.records);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;

  const plan = useMemo(
    () =>
      buildMigrationPlan({
        model,
        table,
        mappings,
        standardization: standardization ?? {},
        allModels,
        allRecords,
        makeId: uuid,
      }),
    [model, table, mappings, standardization, allModels, allRecords],
  );

  // Columns = the importable fields actually populated by any record, in schema order.
  const columns: ModelField[] = useMemo(() => {
    const present = new Set<string>();
    plan.records.forEach((r) => Object.keys(r.data).forEach((k) => present.add(k)));
    return model.schema.sections.flatMap((s) => s.fields).filter((f) => present.has(f.name));
  }, [plan, model]);

  const excluded = new Set(excludedRows ?? []);
  const approvedCount = plan.records.filter((r) => !excluded.has(r.rowIndex)).length;

  const toggle = (rowIndex: number) => {
    const next = new Set(excluded);
    if (next.has(rowIndex)) next.delete(rowIndex);
    else next.add(rowIndex);
    onChangeExcluded([...next]);
  };
  const selectAll = () => onChangeExcluded([]);
  const selectNone = () => onChangeExcluded(plan.records.map((r) => r.rowIndex));

  const shown = plan.records.slice(0, RENDER_CAP);

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-charcoal">
            {isAr ? 'راجع السجلات قبل الترحيل' : 'Review the records before migrating'}
          </h3>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? `${approvedCount} من ${plan.records.length} سجل ستتم إضافته إلى ${model.label_ar}.`
              : `${approvedCount} of ${plan.records.length} records will be added to ${model.label_en}.`}
            {plan.skipped > 0 && (isAr ? ` تم تخطي ${plan.skipped} مكرر.` : ` ${plan.skipped} duplicates skipped.`)}
            {plan.newLookupRecords.length > 0 &&
              (isAr
                ? ` (+${plan.newLookupRecords.length} سجل مرتبط جديد)`
                : ` (+${plan.newLookupRecords.length} new linked records)`)}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={selectAll} className="px-2.5 py-1 rounded-lg bg-copper/10 text-copper font-bold hover:bg-copper/20">
            {isAr ? 'الموافقة على الكل' : 'Approve all'}
          </button>
          <button onClick={selectNone} className="px-2.5 py-1 rounded-lg bg-charcoal/5 text-charcoal/60 font-bold hover:bg-charcoal/10">
            {isAr ? 'إلغاء الكل' : 'Deselect all'}
          </button>
        </div>
      </div>

      {plan.records.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 text-charcoal/60">
          <AlertTriangle size={26} className="text-amber-500" />
          <p className="text-sm">
            {isAr
              ? 'لا توجد سجلات للترحيل. تأكد من ربط الأعمدة بالحقول.'
              : 'No records to migrate. Check that columns are mapped to fields.'}
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto border border-sand/30 rounded-xl">
          <table className="text-sm border-collapse min-w-full">
            <thead className="sticky top-0 z-10 bg-cream-light">
              <tr>
                <th className="w-12 border-b border-e border-sand/20 p-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={approvedCount === plan.records.length}
                    ref={(el) => {
                      if (el) el.indeterminate = approvedCount > 0 && approvedCount < plan.records.length;
                    }}
                    onChange={(e) => (e.target.checked ? selectAll() : selectNone())}
                    className="accent-copper"
                  />
                </th>
                <th className="w-10 border-b border-e border-sand/20 p-1.5 text-charcoal/40 text-xs font-normal">#</th>
                {columns.map((f) => (
                  <th key={f.id} className="border-b border-e border-sand/20 p-2 text-start font-bold text-charcoal whitespace-nowrap min-w-[120px]">
                    {isAr ? f.label_ar : f.label_en}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((rec, i) => {
                const on = !excluded.has(rec.rowIndex);
                return (
                  <tr key={rec.rowIndex} className={on ? 'hover:bg-cream/40' : 'opacity-40 bg-charcoal/[0.02]'}>
                    <td className="border-b border-e border-sand/10 p-1.5 text-center align-middle">
                      <input type="checkbox" checked={on} onChange={() => toggle(rec.rowIndex)} className="accent-copper" />
                    </td>
                    <td className="border-b border-e border-sand/10 p-1.5 text-center text-charcoal/30 text-xs align-middle">
                      {i + 1}
                    </td>
                    {columns.map((f) => (
                      <td key={f.id} className="border-b border-e border-sand/10 p-2 text-charcoal align-middle">
                        {resolveDisplay(f, rec.data[f.name], allRecords, plan.newLookupRecords, isAr)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plan.records.length > RENDER_CAP && (
            <div className="p-2 text-xs text-amber-700 bg-amber-50 border-t border-amber-200">
              {isAr
                ? `يتم عرض أول ${RENDER_CAP} من ${plan.records.length} سجل. زر «الموافقة على الكل» يشمل جميع السجلات.`
                : `Showing the first ${RENDER_CAP} of ${plan.records.length}. "Approve all" covers every record.`}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-sand/20">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
        <button
          onClick={onConfirm}
          disabled={approvedCount === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
        >
          <PlayCircle size={16} />
          {isAr ? `ترحيل ${approvedCount} سجل` : `Migrate ${approvedCount} records`}
          <Next size={15} />
        </button>
      </div>
    </div>
  );
}
