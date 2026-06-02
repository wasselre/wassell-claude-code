import { Plus, Trash2, ArrowDownToLine } from 'lucide-react';
import type { RawTable } from '../lib/types';

interface EditableRawGridProps {
  table: RawTable;
  onChange: (next: RawTable) => void;
  isAr: boolean;
}

/**
 * A plain editable HTML table over { headers, rows } — the exact shape
 * readExcelFile returns and mapImportedRows consumes. No data-grid dependency
 * (handles tens-to-hundreds of rows fine; bigger sets use download → edit →
 * re-upload). Every cell is free text, so multiselect multi-values
 * (comma / `،`-separated) survive editing intact.
 */
/** Only render the first N rows in-app — editing thousands of <input>s is
 * slow and the record/localStorage have size limits. Beyond this, the user
 * edits via download → re-upload; the FULL table still migrates. */
const RENDER_CAP = 500;

export default function EditableRawGrid({ table, onChange, isAr }: EditableRawGridProps) {
  const { headers, rows } = table;
  const shownRows = rows.length > RENDER_CAP ? rows.slice(0, RENDER_CAP) : rows;

  const setHeader = (c: number, value: string) =>
    onChange({ ...table, headers: headers.map((h, i) => (i === c ? value : h)) });

  const setCell = (r: number, c: number, value: string) =>
    onChange({
      ...table,
      rows: rows.map((row, ri) => {
        if (ri !== r) return row;
        // Pad ragged rows up to the column being edited so the write lands
        // at the right index.
        const next = [...row];
        while (next.length <= c) next.push('');
        next[c] = value;
        return next;
      }),
    });

  const addRow = () => onChange({ ...table, rows: [...rows, headers.map(() => '')] });
  const removeRow = (r: number) => onChange({ ...table, rows: rows.filter((_, ri) => ri !== r) });

  const addColumn = () =>
    onChange({
      ...table,
      headers: [...headers, isAr ? `عمود ${headers.length + 1}` : `Column ${headers.length + 1}`],
      rows: rows.map((row) => [...row, '']),
    });
  const removeColumn = (c: number) =>
    onChange({
      ...table,
      headers: headers.filter((_, ci) => ci !== c),
      rows: rows.map((row) => row.filter((_, ci) => ci !== c)),
    });

  // Fill every row in column `c` with the value currently in the FIRST row —
  // type a value in the top cell, click fill-down to apply it to all rows.
  const fillColumn = (c: number) => {
    const val = rows[0]?.[c] ?? '';
    onChange({
      ...table,
      rows: rows.map((row) => {
        const next = [...row];
        while (next.length <= c) next.push('');
        next[c] = val;
        return next;
      }),
    });
  };

  return (
    <div>
      <div className="overflow-auto max-h-[55vh] border border-sand/30 rounded-xl">
        <table className="text-sm border-collapse min-w-full">
          <thead className="sticky top-0 z-10 bg-cream-light">
            <tr>
              <th className="w-10 border-b border-e border-sand/20 p-1 text-charcoal/40 text-xs font-normal">#</th>
              {headers.map((h, c) => (
                <th key={c} className="border-b border-e border-sand/20 p-1 min-w-[140px]">
                  <div className="flex items-center gap-1">
                    <input
                      value={h}
                      onChange={(e) => setHeader(c, e.target.value)}
                      className="w-full bg-transparent font-bold text-charcoal px-1.5 py-1 rounded focus:bg-white focus:outline-none focus:ring-1 focus:ring-copper/40"
                    />
                    <button
                      onClick={() => fillColumn(c)}
                      title={isAr ? 'تعبئة كل الصفوف بقيمة الصف الأول' : 'Fill all rows with the first row’s value'}
                      className="shrink-0 text-charcoal/30 hover:text-copper transition-colors"
                    >
                      <ArrowDownToLine size={13} />
                    </button>
                    <button
                      onClick={() => removeColumn(c)}
                      title={isAr ? 'حذف العمود' : 'Delete column'}
                      className="shrink-0 text-charcoal/30 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </th>
              ))}
              <th className="border-b border-sand/20 p-1">
                <button
                  onClick={addColumn}
                  title={isAr ? 'إضافة عمود' : 'Add column'}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-copper hover:bg-copper/10 transition-colors"
                >
                  <Plus size={15} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {shownRows.map((row, r) => (
              <tr key={r} className="hover:bg-cream/40">
                <td className="border-b border-e border-sand/10 p-1 text-center text-charcoal/30 text-xs align-middle">
                  <div className="flex items-center gap-1 justify-center">
                    <span>{r + 1}</span>
                    <button
                      onClick={() => removeRow(r)}
                      title={isAr ? 'حذف الصف' : 'Delete row'}
                      className="text-charcoal/30 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
                {headers.map((_, c) => (
                  <td key={c} className="border-b border-e border-sand/10 p-0">
                    <input
                      value={row[c] ?? ''}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      className="w-full bg-transparent px-1.5 py-1 text-charcoal focus:bg-white focus:outline-none focus:ring-1 focus:ring-copper/40"
                    />
                  </td>
                ))}
                <td className="border-b border-sand/10" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > RENDER_CAP && (
        <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {isAr
            ? `يتم عرض أول ${RENDER_CAP} من ${rows.length} صف للتعديل. سيتم ترحيل كل الصفوف. للتعديل على البقية، نزّل الملف وصحّحه ثم أعد الرفع.`
            : `Showing the first ${RENDER_CAP} of ${rows.length} rows for editing. All rows will migrate. To edit the rest, download, fix, and re-upload.`}
        </div>
      )}
      <div className="mt-2">
        <button
          onClick={addRow}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-copper hover:text-terracotta"
        >
          <Plus size={15} />
          {isAr ? 'إضافة صف' : 'Add row'}
        </button>
      </div>
    </div>
  );
}
