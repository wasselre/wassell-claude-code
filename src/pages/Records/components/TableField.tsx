import { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { ModelField, TableColumn } from '@/types';

type Row = Record<string, unknown>;

export default function TableField({
  field,
  value,
  onChange,
}: {
  field: ModelField;
  value: unknown;
  onChange: (next: Row[]) => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const columns: TableColumn[] = field.table_columns ?? [];
  const rows: Row[] = useMemo(() => (Array.isArray(value) ? (value as Row[]) : []), [value]);
  const maxRows = field.table_max_rows ?? 0;
  const atLimit = maxRows > 0 && rows.length >= maxRows;

  if (columns.length === 0) {
    return (
      <div className="text-xs text-charcoal/50 bg-cream-light/40 border border-dashed border-sand/40 rounded-lg p-3">
        {isAr
          ? 'لم يتم إعداد أعمدة لهذا الجدول بعد. افتح الباني لإضافة الأعمدة.'
          : 'No columns configured for this table yet. Open the Builder to add columns.'}
      </div>
    );
  }

  const addRow = () => {
    const blank: Row = {};
    for (const col of columns) blank[col.name] = '';
    onChange([...rows, blank]);
  };

  const deleteRow = (idx: number) => {
    onChange(rows.filter((_, i) => i !== idx));
  };

  const updateCell = (idx: number, slug: string, cellValue: unknown) => {
    onChange(rows.map((r, i) => (i === idx ? { ...r, [slug]: cellValue } : r)));
  };

  return (
    <div className="bg-white border border-sand/50 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-cream/40 border-b border-sand/40">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.id}
                  className="text-start px-3 py-2 text-xs font-bold text-charcoal/60 uppercase tracking-wider whitespace-nowrap"
                >
                  {isAr ? col.label_ar : col.label_en}
                  {col.required && <span className="text-red-500 ms-0.5">*</span>}
                </th>
              ))}
              <th className="w-8" aria-label="delete" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="text-center py-4 text-charcoal/40 text-xs"
                >
                  {isAr ? 'لا توجد صفوف — اضغط "إضافة صف"' : 'No rows — click "Add row"'}
                </td>
              </tr>
            )}
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b border-sand/25 last:border-0">
                {columns.map((col) => (
                  <td key={col.id} className="px-2 py-1.5">
                    <CellInput
                      column={col}
                      value={row[col.name]}
                      onChange={(v) => updateCell(idx, col.name, v)}
                      isAr={isAr}
                    />
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => deleteRow(idx)}
                    className="p-1 rounded text-red-600/70 hover:text-red-700 hover:bg-red-50"
                    aria-label={isAr ? 'حذف الصف' : 'Delete row'}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 border-t border-sand/40 bg-cream/20 flex items-center justify-between">
        <button
          type="button"
          onClick={addRow}
          disabled={atLimit}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-copper hover:text-terracotta disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={13} />
          {isAr ? 'إضافة صف' : 'Add row'}
        </button>
        <span className="text-[10px] text-charcoal/40">
          {rows.length}
          {maxRows > 0 ? ` / ${maxRows}` : ''} {isAr ? 'صف' : 'rows'}
        </span>
      </div>
    </div>
  );
}

function CellInput({
  column,
  value,
  onChange,
  isAr,
}: {
  column: TableColumn;
  value: unknown;
  onChange: (v: unknown) => void;
  isAr: boolean;
}) {
  const commonClass = 'w-full bg-transparent border border-sand/30 rounded px-2 py-1 text-sm focus:outline-none focus:border-copper';
  switch (column.type) {
    case 'textarea':
      return (
        <textarea
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={1}
          className={commonClass + ' resize-y'}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={(value as number | string) ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={commonClass}
        />
      );
    case 'currency':
      return (
        <input
          type="number"
          value={(value as number | string) ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={commonClass}
          step="0.01"
        />
      );
    case 'date':
      return (
        <input
          type="date"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={commonClass}
        />
      );
    case 'url':
      return (
        <input
          type="url"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={commonClass}
          dir="ltr"
        />
      );
    case 'dropdown':
      return (
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={commonClass}
        >
          <option value="">—</option>
          {(column.options ?? []).map((o) => (
            <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
          ))}
        </select>
      );
    default:
      return (
        <input
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={commonClass}
        />
      );
  }
}
