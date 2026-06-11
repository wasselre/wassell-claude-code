import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  Check,
  Copy,
  Expand,
  Languages,
  Loader2,
  PenLine,
  Replace,
  Shrink,
  Sparkles,
  Text,
  Wand2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { requestDocAssist, type AssistAction } from '@/lib/documents/assist';

interface Props {
  open: boolean;
  /** Selected text captured when the modal opened (empty = nothing selected). */
  selectionText: string;
  docTitle: string;
  context: string;
  onClose: () => void;
  /** Replace the original selection with the result. */
  onReplace: (result: string) => void;
  /** Insert the result after the selection. */
  onInsertBelow: (result: string) => void;
}

type Phase = 'pick' | 'busy' | 'result';

const ACTIONS: Array<{ id: AssistAction; icon: LucideIcon }> = [
  { id: 'rewrite', icon: PenLine },
  { id: 'improve', icon: Wand2 },
  { id: 'summarize', icon: Text },
  { id: 'expand', icon: Expand },
  { id: 'shorten', icon: Shrink },
];

/**
 * AI assistant for selected text — pick an action, review the result, then
 * Replace / Insert below / Copy. Never auto-applies: the user always reviews
 * before the document changes.
 */
export default function DocAssistModal({
  open,
  selectionText,
  docTitle,
  context,
  onClose,
  onReplace,
  onInsertBelow,
}: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('pick');
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const reset = () => {
    setPhase('pick');
    setResult('');
    setError(null);
    setCopied(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const run = async (action: AssistAction, targetLang?: 'ar' | 'en') => {
    setPhase('busy');
    setError(null);
    try {
      const out = await requestDocAssist({
        action,
        text: selectionText,
        docTitle,
        context,
        targetLang,
      });
      setResult(out);
      setPhase('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('pick');
    }
  };

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4 modal-overlay"
      onClick={() => phase !== 'busy' && close()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-sand/30 sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-copper" />
            <h3 className="font-bold text-charcoal">{t('doc.assist.title')}</h3>
          </div>
          <button
            onClick={close}
            disabled={phase === 'busy'}
            className="p-2 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream disabled:opacity-40"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {/* No selection */}
          {selectionText.trim().length === 0 ? (
            <p className="text-sm text-charcoal/50 text-center py-6">{t('doc.assist.empty_selection')}</p>
          ) : phase === 'busy' ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <Loader2 size={28} className="animate-spin text-copper" />
              <p className="text-sm text-charcoal/50">{t('doc.assist.busy')}</p>
            </div>
          ) : phase === 'result' ? (
            <div>
              <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-2">
                {t('doc.assist.result_title')}
              </div>
              <div
                dir="auto"
                className="rounded-xl border border-sand/40 bg-cream/40 p-4 text-sm text-charcoal leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto mb-4"
                style={{ fontFamily: "'Amiri', serif" }}
              >
                {result}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    onReplace(result);
                    close();
                  }}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm transition-colors"
                >
                  <Replace size={15} />
                  {t('doc.assist.replace')}
                </button>
                <button
                  onClick={() => {
                    onInsertBelow(result);
                    close();
                  }}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream font-bold text-sm transition-colors"
                >
                  <ArrowDownToLine size={15} />
                  {t('doc.assist.insert_below')}
                </button>
                <button
                  onClick={() => void copyResult()}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream font-bold text-sm transition-colors"
                >
                  {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
                  {copied ? t('doc.assist.copied') : t('doc.assist.copy')}
                </button>
                <button
                  onClick={reset}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal/60 hover:bg-cream font-bold text-sm transition-colors"
                >
                  {t('doc.assist.back')}
                </button>
              </div>
            </div>
          ) : (
            <div>
              {/* Selection preview */}
              <div
                dir="auto"
                className="rounded-xl border border-sand/30 bg-cream/30 px-3 py-2 text-xs text-charcoal/60 leading-relaxed mb-4 max-h-20 overflow-hidden"
                style={{ fontFamily: "'Amiri', serif" }}
              >
                {selectionText.slice(0, 220)}
                {selectionText.length > 220 ? '…' : ''}
              </div>

              {error && <div className="text-sm text-red-600 mb-3">{error}</div>}

              <div className="grid grid-cols-2 gap-2">
                {ACTIONS.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => void run(id)}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-sand/40 hover:bg-cream hover:border-copper/30 text-start transition-colors"
                  >
                    <Icon size={16} className="text-copper shrink-0" />
                    <span className="text-sm font-bold text-charcoal">{t(`doc.assist.action.${id}`)}</span>
                  </button>
                ))}
                {/* Translate — two explicit directions */}
                <div className="col-span-2 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-sand/40">
                  <Languages size={16} className="text-copper shrink-0" />
                  <span className="text-sm font-bold text-charcoal flex-1">{t('doc.assist.action.translate')}</span>
                  <button
                    onClick={() => void run('translate', 'ar')}
                    className="px-3 py-1.5 rounded-lg bg-cream hover:bg-copper hover:text-white text-xs font-bold text-charcoal transition-colors"
                  >
                    {t('doc.assist.to_ar')}
                  </button>
                  <button
                    onClick={() => void run('translate', 'en')}
                    className="px-3 py-1.5 rounded-lg bg-cream hover:bg-copper hover:text-white text-xs font-bold text-charcoal transition-colors"
                  >
                    {t('doc.assist.to_en')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
