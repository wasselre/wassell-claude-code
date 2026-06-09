import { useMemo, useState } from 'react';
import { Plus, Trash2, ImagePlus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { ModelField, TableColumn } from '@/types';
import { evaluateFormula, isFormulaErrorValue } from '@/lib/formulaEngine';
import { shortenGoogleMapsUrl } from '@/lib/urlUtils';
import { formatNumberWithCommas, parseFormattedNumber } from './RangeField';
import IconPickerModal from './IconPickerModal';
import AutoGrowTextarea from './AutoGrowTextarea';
import { resolveSlugToLibraryUrl } from '@/data/iconLibrary';

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
                      row={row}
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
  row,
  onChange,
  isAr,
}: {
  column: TableColumn;
  value: unknown;
  row: Row;
  onChange: (v: unknown) => void;
  isAr: boolean;
}) {
  const commonClass = 'w-full bg-transparent border border-sand/30 rounded px-2 py-1 text-sm focus:outline-none focus:border-copper';
  switch (column.type) {
    case 'textarea':
      return (
        <AutoGrowTextarea
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={1}
          className={commonClass}
        />
      );
    case 'number':
    case 'currency':
      return <NumericCellInput value={value} onChange={onChange} isAr={isAr} className={commonClass} />;
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
          onBlur={(e) => {
            const shortened = shortenGoogleMapsUrl(e.target.value);
            if (shortened !== e.target.value) onChange(shortened);
          }}
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
    case 'formula':
      return <FormulaCell column={column} row={row} isAr={isAr} />;
    case 'image_icon':
      return <ImageIconCell value={value} onChange={onChange} isAr={isAr} />;
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

/**
 * Numeric cell input that displays values with locale-aware thousands separators
 * (e.g. 1,000,000 / 1،000،000) while still storing a raw number.
 * Uses a draft string while focused so commas don't fight typing.
 */
function NumericCellInput({
  value,
  onChange,
  isAr,
  className,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  isAr: boolean;
  className: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const numeric = typeof value === 'number'
    ? value
    : (value === null || value === undefined || value === '' ? undefined : Number(value));
  const display = draft !== null
    ? draft
    : (numeric === undefined || Number.isNaN(numeric) ? '' : formatNumberWithCommas(numeric, isAr));
  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseFormattedNumber(e.target.value);
        onChange(parsed === undefined ? null : parsed);
      }}
      onBlur={() => setDraft(null)}
      className={className}
      dir="ltr"
    />
  );
}

/**
 * Cell renderer for `image_icon` columns (project_details features /
 * landmarks). The stored value is a public URL; the cell shows a thumb
 * plus an "edit" affordance, and clicking the cell opens the modal
 * picker (Library or Generate tabs).
 */
function ImageIconCell({
  value,
  onChange,
  isAr,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  isAr: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Existing data may still hold legacy slug values (`"building"`, `"metro"`)
  // from before the column type flipped. Resolve them to the library URL on
  // read so the cell renders the right image regardless of stored shape.
  // The first time the row is saved with a new pick, the URL gets persisted
  // and the slug is gone for good.
  const raw = typeof value === 'string' ? value : '';
  const url = raw ? (resolveSlugToLibraryUrl(raw) ?? raw) : '';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-2 w-full px-2 py-1 rounded border border-sand/30 hover:border-copper/60 hover:bg-cream/40 transition-colors text-start ${
          url ? '' : 'text-charcoal/40'
        }`}
        title={isAr ? 'تغيير الأيقونة' : 'Change icon'}
      >
        {url ? (
          <img
            src={url}
            alt="icon"
            className="w-7 h-7 object-contain bg-white rounded border border-sand/20"
          />
        ) : (
          <span className="w-7 h-7 rounded border border-dashed border-sand/50 bg-cream/30 flex items-center justify-center">
            <ImagePlus size={14} className="text-charcoal/40" />
          </span>
        )}
        <span className="text-xs">
          {url ? (isAr ? 'تغيير' : 'Change') : isAr ? 'اختيار أيقونة' : 'Pick icon'}
        </span>
      </button>
      <IconPickerModal
        open={open}
        onClose={() => setOpen(false)}
        selected={url || undefined}
        onSelect={(next) => onChange(next)}
      />
    </>
  );
}

/**
 * Read-only cell that renders a per-row formula. References inside `{...}`
 * resolve against the row's other columns (e.g. `{max_price} - {min_price}`).
 * Falls through error sentinels (#DIV0, #REF, …) untouched so the user can
 * see why a cell isn't computing.
 */
function FormulaCell({
  column,
  row,
  isAr,
}: {
  column: TableColumn;
  row: Row;
  isAr: boolean;
}) {
  const expression = column.formula_expression?.trim();
  if (!expression) {
    return <span className="text-xs text-charcoal/30 italic">{isAr ? '— لا توجد صيغة —' : '— no formula —'}</span>;
  }
  const result = evaluateFormula(expression, row);
  const text = formatTableFormulaValue(result, column, isAr ? 'ar-SA' : 'en-US');
  const isError = isFormulaErrorValue(result);
  return (
    <span
      className={`block w-full px-2 py-1 text-sm ${isError ? 'text-red-600 font-mono text-xs' : 'text-charcoal/80'}`}
      title={isError ? expression : undefined}
    >
      {text}
    </span>
  );
}

function formatTableFormulaValue(
  value: ReturnType<typeof evaluateFormula>,
  column: TableColumn,
  locale: string,
): string {
  if (isFormulaErrorValue(value)) return value;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return String(value);
  const outputType = column.formula_output_type ?? 'number';
  if (outputType === 'text') return String(value);
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  const decimals = clampDecimals(column.formula_decimals);
  const useGrouping = column.formula_thousands_separator !== false;
  if (outputType === 'percentage') {
    const body = (num * 100).toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping,
    });
    return `${body}%`;
  }
  const body = num.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping,
  });
  if (outputType === 'currency') {
    const code = (column.formula_currency ?? 'SAR').trim() || 'SAR';
    if (code.toUpperCase() === 'SAR') {
      return `${body} ${locale.startsWith('ar') ? 'ر.س' : 'SAR'}`;
    }
    return `${body} ${code}`;
  }
  return body;
}

function clampDecimals(d: number | undefined): number {
  if (d === undefined || d === null || !Number.isFinite(d)) return 2;
  const r = Math.round(d);
  return Math.max(0, Math.min(6, r));
}
