import { useEffect, useRef, useState } from 'react';
import { Library, Plus, Trash2, Loader2, Check } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  listMigrationPrompts,
  saveMigrationPrompt,
  deleteMigrationPrompt,
  type MigrationPrompt,
} from '../lib/client';

interface PromptLibraryProps {
  isAr: boolean;
  /** The current instructions text — what "Save current" persists. */
  currentText: string;
  /** Insert a selected prompt's body into the instructions field (replaces it). */
  onInsert: (body: string) => void;
}

/**
 * A SHARED library of saved extraction-instruction prompts, surfaced next to the
 * instructions field in the prep step. The operator can pick a saved prompt to
 * fill the instructions before starting an analysis, save the current text as a
 * new prompt, or delete one they authored. Backed by `migration_prompts` via the
 * client helpers (no store — same posture as the rest of the migration feature).
 */
export default function PromptLibrary({ isAr, currentText, onInsert }: PromptLibraryProps) {
  const addToast = useAppStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<MigrationPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setPrompts(await listMigrationPrompts());
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  // Load on first open (don't fetch until the operator looks).
  useEffect(() => {
    if (open && prompts.length === 0 && !loading) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const saveCurrent = async () => {
    const text = currentText.trim();
    if (!text || busy) return;
    const label = window.prompt(
      isAr ? 'اسم التعليمات المحفوظة:' : 'Name this prompt:',
      '',
    );
    if (label == null || label.trim() === '') return;
    setBusy(true);
    try {
      const saved = await saveMigrationPrompt(label, text);
      setPrompts((prev) => [saved, ...prev]);
      addToast(isAr ? 'تم حفظ التعليمات في المكتبة' : 'Saved to the prompt library', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: MigrationPrompt) => {
    if (busy) return;
    if (!window.confirm(isAr ? `حذف "${p.label}"؟` : `Delete "${p.label}"?`)) return;
    setBusy(true);
    try {
      await deleteMigrationPrompt(p.id);
      setPrompts((prev) => prev.filter((x) => x.id !== p.id));
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pick = (p: MigrationPrompt) => {
    onInsert(p.body);
    setOpen(false);
    addToast(isAr ? `تم إدراج "${p.label}"` : `Inserted "${p.label}"`, 'success');
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-copper bg-copper/10 hover:bg-copper/20 transition-colors"
      >
        <Library size={13} />
        {isAr ? 'مكتبة التعليمات' : 'Prompt library'}
      </button>

      {open && (
        <div
          className={`absolute z-30 mt-1.5 w-80 max-w-[90vw] rounded-xl border border-sand/40 bg-white shadow-lg p-2.5 ${
            isAr ? 'start-0' : 'end-0'
          }`}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold text-charcoal">
              {isAr ? 'تعليمات محفوظة' : 'Saved prompts'}
            </span>
            <button
              type="button"
              onClick={saveCurrent}
              disabled={busy || currentText.trim() === ''}
              title={
                currentText.trim() === ''
                  ? isAr ? 'اكتب تعليمات أولاً' : 'Write some instructions first'
                  : undefined
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold bg-copper text-white hover:bg-terracotta disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              {isAr ? 'حفظ الحالية' : 'Save current'}
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto space-y-1">
            {loading ? (
              <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-charcoal/50">
                <Loader2 size={14} className="animate-spin" />
                {isAr ? 'جارٍ التحميل…' : 'Loading…'}
              </div>
            ) : prompts.length === 0 ? (
              <p className="text-xs text-charcoal/50 text-center py-4 leading-relaxed">
                {isAr
                  ? 'لا توجد تعليمات محفوظة بعد. اكتب تعليماتك ثم اضغط «حفظ الحالية».'
                  : 'No saved prompts yet. Write instructions, then "Save current".'}
              </p>
            ) : (
              prompts.map((p) => (
                <div
                  key={p.id}
                  className="group flex items-start gap-1.5 rounded-lg border border-sand/30 hover:border-copper/40 hover:bg-copper/[0.03] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => pick(p)}
                    className="flex-1 min-w-0 text-start p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <Check size={12} className="text-copper shrink-0" />
                      <span className="text-xs font-bold text-charcoal truncate" dir="auto">
                        {p.label}
                      </span>
                    </div>
                    <div className="text-[11px] text-charcoal/55 mt-0.5 line-clamp-2 leading-relaxed ps-[18px]" dir="auto">
                      {p.body}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(p)}
                    title={isAr ? 'حذف' : 'Delete'}
                    className="shrink-0 p-1.5 mt-1 me-1 rounded-lg text-charcoal/30 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
