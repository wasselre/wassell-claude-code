import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { readExcelFile, exportRawTable } from '@/lib/excelUtils';
import {
  Download,
  Upload,
  ArrowRight,
  ArrowLeft,
  Info,
  Sparkles,
  Loader2,
  MessageSquareText,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import EditableRawGrid from '../EditableRawGrid';
import { discussExtraction, type MigrationUpload } from '../../lib/client';
import { targetFieldLites } from '../../lib/targetFields';
import type { RawTable, ChatMessage } from '../../lib/types';
import type { AppModel } from '@/types';

interface StepReviewRawProps {
  isAr: boolean;
  /** Target model — fed to the discussion as context (never to coerce values). */
  model: AppModel;
  table: RawTable;
  /** Uploaded source files — let the discussion re-read the brochure + plans. */
  sourceFiles?: MigrationUpload[];
  /** The post-extraction discussion thread (persisted on the record). */
  chat?: ChatMessage[];
  /** Persist edits (debounced by this component). */
  onChange: (t: RawTable) => void;
  /** Re-upload replaces the table AND resets downstream mappings/standardization. */
  onReplace: (t: RawTable) => void;
  /** Persist the discussion thread. */
  onChat: (next: ChatMessage[]) => void;
  onContinue: () => void;
  onBack: () => void;
}

/** Apply the AI's discussion column edits to the table: an existing header is
 * filled/overwritten with the AI's non-empty values (a recount or fix); an
 * unknown header is appended as a new column. */
function applyDiscussColumns(table: RawTable, columns: { header: string; values: string[] }[]): RawTable {
  const headers = [...table.headers];
  const rows = table.rows.map((r) => [...r]);
  for (const col of columns) {
    let idx = headers.findIndex((h) => h.trim() === col.header.trim());
    if (idx === -1) {
      headers.push(col.header);
      idx = headers.length - 1;
    }
    rows.forEach((r, i) => {
      while (r.length <= idx) r.push('');
      const val = (col.values[i] ?? '').trim();
      if (val) r[idx] = val; // overwrite/fill with the AI's non-empty value
    });
  }
  return { ...table, headers, rows };
}

/**
 * Step "review_raw" — show the extracted table, edit it in-app, download/
 * re-upload, AND discuss it with the AI. Extraction now does the heavy lifting
 * (model-aware, numeric, deep floor-plan analysis), so this step is review +
 * conversation: the AI's summary explains how it derived every number, and the
 * operator can chat back to question or revise the data (recount a column,
 * pull a missed field, re-read the brochure).
 *
 * Edits are held in a local `draft` and persisted on a 700ms debounce; the
 * pending save is flushed on navigate / unmount.
 */
export default function StepReviewRaw({
  isAr,
  model,
  table,
  sourceFiles,
  chat,
  onChange,
  onReplace,
  onChat,
  onContinue,
  onBack,
}: StepReviewRawProps) {
  const addToast = useAppStore((s) => s.addToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<RawTable>(table);
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [discussOpen, setDiscussOpen] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<RawTable>(table);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;

  const thread: ChatMessage[] = chat ?? [];

  const runAsk = async () => {
    const text = aiInput.trim();
    if (!text || aiBusy) return;
    setAiBusy(true);
    try {
      // Seed the model with its own extraction summary (the conversation's
      // opening), then the persisted thread, then the new question.
      const apiMessages = [
        ...(draft.summary ? [{ role: 'assistant' as const, content: draft.summary }] : []),
        ...thread.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: text },
      ];
      const { reply, columns, truncated } = await discussExtraction({
        messages: apiMessages,
        headers: draft.headers,
        rows: draft.rows,
        uploads: sourceFiles,
        fields: targetFieldLites(model),
        language: isAr ? 'ar' : 'en',
      });
      const now = new Date().toISOString();
      onChat([
        ...thread,
        { role: 'user', content: text, ts: now },
        { role: 'assistant', content: reply || (isAr ? 'تم.' : 'Done.'), ts: now },
      ]);
      if (columns.length > 0) {
        const next = applyDiscussColumns(draft, columns);
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        setDraft(next);
        latest.current = next;
        onChange(next); // persist the revised table immediately
        addToast(
          (isAr ? `حدّث الذكاء ${columns.length} عمود` : `AI updated ${columns.length} column(s)`) +
            (truncated ? (isAr ? ' (أول 250 صف)' : ' (first 250 rows)') : ''),
          'success',
        );
      }
      setAiInput('');
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
  const msgPairs = (thread.length / 2) | 0;

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-charcoal">
            {isAr ? 'راجع البيانات المستخرجة' : 'Review the extracted data'}
          </h3>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? `${rowCount} صف · ${colCount} عمود — عدّل هنا، أو ناقش الذكاء، أو نزّل وصحّح في Excel ثم أعد الرفع.`
              : `${rowCount} rows · ${colCount} columns — edit here, discuss with the AI, or download/fix in Excel and re-upload.`}
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

      {/* AI discussion: the extraction summary + a back-and-forth chat where the
          operator can question how a value (esp. a number) was derived, or ask
          the AI to recount / pull a missed column by re-reading the brochure. */}
      {(draft.summary || draft.source === 'ai_extract') && (
        <div className="mb-3 rounded-xl border border-copper/20 bg-copper/[0.03] overflow-hidden shrink-0">
          <button
            onClick={() => setDiscussOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-bold text-charcoal hover:bg-copper/[0.06] transition-colors"
          >
            {discussOpen ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronRight size={15} className={isAr ? 'rotate-180' : ''} />
            )}
            <MessageSquareText size={15} className="text-copper" />
            <span className="flex-1 text-start">
              {isAr ? 'ملخص ونقاش الاستخراج' : 'Extraction summary & chat'}
            </span>
            {msgPairs > 0 && (
              <span className="text-[11px] text-charcoal/40 font-normal">
                {isAr ? `${msgPairs} رسالة` : `${msgPairs} msg`}
              </span>
            )}
          </button>

          {discussOpen && (
            <div className="px-3 pb-3">
              {/* Summary + thread, bounded + scrollable so the grid stays visible. */}
              <div className="max-h-52 overflow-y-auto space-y-2 pe-1">
                {draft.summary && (
                  <div className="text-xs text-charcoal/80 whitespace-pre-wrap leading-relaxed bg-white/60 rounded-lg p-2.5 border border-sand/30">
                    {draft.summary}
                  </div>
                )}
                {thread.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] text-xs whitespace-pre-wrap leading-relaxed rounded-lg px-2.5 py-1.5 ${
                        m.role === 'user'
                          ? 'bg-copper text-white'
                          : 'bg-white text-charcoal border border-sand/30'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {aiBusy && (
                  <div className="flex justify-start">
                    <div className="inline-flex items-center gap-1.5 text-xs text-charcoal/50 bg-white border border-sand/30 rounded-lg px-2.5 py-1.5">
                      <Loader2 size={13} className="animate-spin" />
                      {isAr ? 'يفكّر الذكاء…' : 'Thinking…'}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 mt-2">
                <input
                  value={aiInput}
                  onChange={(e) => setAiInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !aiBusy && aiInput.trim()) void runAsk();
                  }}
                  placeholder={
                    isAr
                      ? 'اسأل: كيف حسبت عدد الحمامات؟ أو: أعد عدّ الغرف من المخطط…'
                      : 'Ask: how did you count the bathrooms? or: recount bedrooms from the plan…'
                  }
                  disabled={aiBusy}
                  className="form-input flex-1 text-sm py-1.5"
                />
                <button
                  onClick={() => void runAsk()}
                  disabled={aiBusy || !aiInput.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper/10 text-copper font-medium text-sm hover:bg-copper/20 disabled:opacity-50 transition-colors shrink-0"
                >
                  {aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                  {isAr ? 'اسأل' : 'Ask'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
