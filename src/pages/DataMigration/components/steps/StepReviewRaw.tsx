import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { readExcelFile, exportRawTable } from '@/lib/excelUtils';
import { Download, Upload, ArrowRight, ArrowLeft, Info, Sparkles, Loader2 } from 'lucide-react';
import EditableRawGrid from '../EditableRawGrid';
import { enrichTable, type MigrationUpload } from '../../lib/client';
import type { RawTable } from '../../lib/types';

interface StepReviewRawProps {
  isAr: boolean;
  table: RawTable;
  /** uploaded source files — let "Ask AI" re-read the brochure for a missed column. */
  sourceFiles?: MigrationUpload[];
  /** Persist edits (debounced by this component). */
  onChange: (t: RawTable) => void;
  /** Re-upload replaces the table AND resets downstream mappings/standardization. */
  onReplace: (t: RawTable) => void;
  onContinue: () => void;
  onBack: () => void;
}

/** Merge AI-returned columns into the table: existing header → fill blanks only
 * (never overwrite); unknown header → append a new column. */
function mergeEnrichment(table: RawTable, columns: { header: string; values: string[] }[]): RawTable {
  const headers = [...table.headers];
  const rows = table.rows.map((r) => [...r]);
  for (const col of columns) {
    let idx = headers.findIndex((h) => h.trim() === col.header.trim());
    const isNew = idx === -1;
    if (isNew) {
      headers.push(col.header);
      idx = headers.length - 1;
    }
    rows.forEach((r, i) => {
      while (r.length <= idx) r.push('');
      const val = (col.values[i] ?? '').trim();
      if (!val) return;
      if (isNew || (r[idx] ?? '') === '') r[idx] = val; // fill blanks / new column
    });
  }
  return { ...table, headers, rows };
}

/**
 * Step "review_raw" — show the raw table (extracted or uploaded), edit it
 * in-app, download as Excel, or re-upload a corrected sheet. The convergence
 * point for both entry modes.
 *
 * Edits are held in a local `draft` (responsive typing) and persisted to the
 * record on a 700ms debounce — never per keystroke (that would spam Supabase).
 * The draft re-seeds from `table` on every mount, which is correct because the
 * wizard only mounts this step for `review_raw`; we flush the pending save on
 * navigate and on unmount so nothing is lost.
 */
export default function StepReviewRaw({
  isAr,
  table,
  sourceFiles,
  onChange,
  onReplace,
  onContinue,
  onBack,
}: StepReviewRawProps) {
  const addToast = useAppStore((s) => s.addToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<RawTable>(table);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<RawTable>(table);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;

  const runAsk = async () => {
    const instruction = aiInstruction.trim();
    if (!instruction) return;
    setAiBusy(true);
    try {
      const { columns, notes, truncated } = await enrichTable({
        instruction,
        headers: draft.headers,
        rows: draft.rows,
        uploads: sourceFiles,
        language: isAr ? 'ar' : 'en',
      });
      if (columns.length === 0) {
        addToast(isAr ? 'لم يُضِف الذكاء أي بيانات' : 'AI returned nothing to add', 'info');
        return;
      }
      const next = mergeEnrichment(draft, columns);
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setDraft(next);
      latest.current = next;
      onChange(next); // persist immediately
      setAiInstruction('');
      addToast(
        (isAr ? `أضاف/عبّأ الذكاء ${columns.length} عمود` : `AI added/filled ${columns.length} column(s)`) +
          (notes ? ` — ${notes}` : '') +
          (truncated ? (isAr ? ' (أول 250 صف)' : ' (first 250 rows)') : ''),
        'success',
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      onChange(latest.current);
    }
  };
  // Flush any pending debounced save when leaving the step.
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGridChange = (t: RawTable) => {
    setDraft(t);
    latest.current = t;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(t);
    }, 700);
  };

  const handleReupload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = await readExcelFile(file);
      const next: RawTable = { headers: result.headers, rows: result.rows, source: 'excel_upload' };
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setDraft(next);
      latest.current = next;
      onReplace(next); // immediate persist + reset downstream mappings/standardization
      addToast(isAr ? 'تم تحديث الجدول' : 'Table replaced', 'success');
    } catch {
      addToast(isAr ? 'تعذّرت قراءة الملف' : 'Could not read the file', 'error');
    }
  };

  const goContinue = () => {
    flush();
    onContinue();
  };
  const goBack = () => {
    flush();
    onBack();
  };

  const rowCount = draft.rows.length;
  const colCount = draft.headers.length;
  const canContinue = colCount > 0 && rowCount > 0;

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-charcoal">
            {isAr ? 'راجع البيانات المستخرجة' : 'Review the extracted data'}
          </h3>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? `${rowCount} صف · ${colCount} عمود — عدّل هنا، أو نزّل وصحّح في Excel ثم أعد الرفع.`
              : `${rowCount} rows · ${colCount} columns — edit here, or download, fix in Excel and re-upload.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => exportRawTable(draft, isAr ? 'بيانات_الترحيل' : 'migration_data', isAr)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/40 text-sm text-charcoal hover:bg-cream transition-colors"
          >
            <Download size={15} />
            {isAr ? 'تنزيل Excel' : 'Download Excel'}
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/40 text-sm text-charcoal hover:bg-cream transition-colors"
          >
            <Upload size={15} />
            {isAr ? 'رفع نسخة مصححة' : 'Re-upload'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => void handleReupload(e.target.files?.[0])}
          />
        </div>
      </div>

      {draft.notes && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-copper/[0.06] border border-copper/20 text-xs text-charcoal/70">
          <Info size={14} className="text-copper shrink-0 mt-0.5" />
          <span>{draft.notes}</span>
        </div>
      )}

      {/* Ask AI — fill blanks from other columns, pull a column from the
          uploaded files, or add a column from the AI's knowledge. */}
      <div className="mb-3 flex items-center gap-2">
        <input
          value={aiInstruction}
          onChange={(e) => setAiInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !aiBusy && aiInstruction.trim()) void runAsk();
          }}
          placeholder={
            isAr
              ? 'اطلب من الذكاء: عبّئ المدينة من الحي، أو أضف تاريخ التسليم من الكتيّب…'
              : 'Ask AI: fill city from district, add delivery date from the brochure…'
          }
          disabled={aiBusy}
          className="form-input flex-1 text-sm py-1.5"
        />
        <button
          onClick={() => void runAsk()}
          disabled={aiBusy || !aiInstruction.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper/10 text-copper font-medium text-sm hover:bg-copper/20 disabled:opacity-50 transition-colors shrink-0"
        >
          {aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {isAr ? 'اسأل الذكاء' : 'Ask AI'}
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <EditableRawGrid table={draft} onChange={handleGridChange} isAr={isAr} />
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-sand/20">
        <button
          onClick={goBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
        <button
          onClick={goContinue}
          disabled={!canContinue}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
        >
          {isAr ? 'اقتراح ربط الأعمدة' : 'Suggest column mapping'}
          <Next size={15} />
        </button>
      </div>
    </div>
  );
}
