import { useState } from 'react';
import {
  Check, X, RefreshCw, Copy, Loader2, AlertTriangle, ShieldCheck, Ban, Undo2, Database,
} from 'lucide-react';
import { angleById } from '@/lib/postsContent/templates';
import { REJECTION_REASONS } from './RejectModal';
import type { PostState } from '../lib/persistence';

interface Props {
  state: PostState;
  isAr: boolean;
  /** Which language bodies exist on this batch. */
  showAr: boolean;
  showEn: boolean;
  onApprove: () => void;
  onUnapprove: () => void;
  onReject: () => void;
  onRestore: () => void;
  onRegenerate: () => void;
  onEditBody: (lang: 'ar' | 'en', value: string) => void;
}

/**
 * One post in the review grid.
 *
 * The body textarea holds the full pasteable post (headline + prose + the
 * database-rendered specification block). The spec block is ALSO shown on its
 * own, labelled and read-only, so a reviewer can see at a glance which lines
 * came from the database rather than from the model.
 */
export default function PostCard({
  state, isAr, showAr, showEn, onApprove, onUnapprove, onReject, onRestore, onRegenerate, onEditBody,
}: Props) {
  const [lang, setLang] = useState<'ar' | 'en'>(showAr ? 'ar' : 'en');
  const [copied, setCopied] = useState(false);
  const [showSpec, setShowSpec] = useState(false);

  const angle = angleById(state.angle);
  const p = state.post;
  const body = p ? (lang === 'ar' ? p.body_ar : p.body_en) : '';
  const spec = p ? (lang === 'ar' ? p.spec_ar : p.spec_en) : '';
  const headline = p ? (lang === 'ar' ? p.headline_ar : p.headline_en) : '';

  const copy = async () => {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[PostCard] clipboard write failed:', err);
    }
  };

  const border =
    state.review === 'approved' ? 'border-green-400 ring-1 ring-green-400/30'
    : state.review === 'rejected' ? 'border-red-300 bg-red-50/30'
    : 'border-sand/25';

  const statusPill =
    state.review === 'approved'
      ? { text: isAr ? 'معتمد' : 'Approved', cls: 'bg-green-100 text-green-700' }
      : state.review === 'rejected'
        ? { text: isAr ? 'مرفوض' : 'Rejected', cls: 'bg-red-100 text-red-700' }
        : { text: isAr ? 'مسودة' : 'Draft', cls: 'bg-cream text-charcoal/50' };

  return (
    <div className={`bg-white rounded-2xl border shadow-sm flex flex-col overflow-hidden transition-colors ${border}`}>
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-sand/15">
        <div className="flex items-start gap-2">
          <div className="w-7 h-7 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0 text-xs font-bold">
            {state.postNumber}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-chocolate truncate">{state.projectName}</h3>
            <p className="text-[11px] text-charcoal/45 truncate">
              {angle ? (isAr ? angle.label_ar : angle.label_en) : state.angle}
              {state.variationIndex > 0 && (
                <span className="text-copper"> · {isAr ? `صيغة ${state.variationIndex + 1}` : `take ${state.variationIndex + 1}`}</span>
              )}
            </p>
          </div>
          <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full font-bold ${statusPill.cls}`}>
            {statusPill.text}
          </span>
        </div>
      </div>

      {/* Evidence */}
      {p && p.evidence.length > 0 && (
        <div className="px-4 py-2 border-b border-sand/15 flex items-start gap-1.5">
          <ShieldCheck size={13} className="text-green-600 shrink-0 mt-0.5" />
          <div className="flex flex-wrap gap-1">
            {p.evidence.slice(0, 4).map((e) => (
              <span key={e} className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">
                {e}
              </span>
            ))}
            {p.evidence.length > 4 && <span className="text-[10px] text-charcoal/40">+{p.evidence.length - 4}</span>}
          </div>
        </div>
      )}

      {/* Rejection note */}
      {state.review === 'rejected' && state.rejection && (
        <div className="px-4 py-2 border-b border-sand/15 text-[11px] text-red-700 flex items-start gap-1.5">
          <Ban size={12} className="shrink-0 mt-0.5" />
          <span>
            {/* Show the human label, not the stored slug (`incorrect_facts`). */}
            {(() => {
              const r = REJECTION_REASONS.find((x) => x.value === state.rejection?.reason);
              return r ? (isAr ? r.ar : r.en) : state.rejection?.reason;
            })()}
            {state.rejection.note ? ` — ${state.rejection.note}` : ''}
          </span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 p-3">
        {state.cardStatus === 'generating' && (
          <div className="h-44 flex flex-col items-center justify-center gap-2 text-charcoal/40">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-xs">{isAr ? 'جارٍ الكتابة…' : 'Writing…'}</span>
          </div>
        )}
        {state.cardStatus === 'pending' && (
          <div className="h-44 flex items-center justify-center text-xs text-charcoal/30">
            {isAr ? 'بانتظار الدور' : 'Queued'}
          </div>
        )}
        {state.cardStatus === 'error' && (
          <div className="h-44 flex flex-col items-center justify-center gap-2 px-3 text-center">
            <AlertTriangle size={18} className="text-red-500" />
            <p className="text-[11px] text-red-600 break-words line-clamp-5">{state.error}</p>
          </div>
        )}
        {state.cardStatus === 'ready' && p && (
          <>
            {showAr && showEn && (
              <div className="flex items-center gap-1 mb-2">
                {(['ar', 'en'] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLang(l)}
                    className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                      lang === l ? 'bg-copper text-white' : 'bg-cream text-charcoal/50 hover:text-charcoal'
                    }`}
                  >
                    {l === 'ar' ? 'عربي' : 'EN'}
                  </button>
                ))}
              </div>
            )}
            {headline && (
              <p
                dir={lang === 'ar' ? 'rtl' : 'ltr'}
                className="text-xs font-bold text-chocolate mb-1.5 line-clamp-2"
              >
                {headline}
              </p>
            )}
            <textarea
              value={body}
              onChange={(e) => onEditBody(lang, e.target.value)}
              dir={lang === 'ar' ? 'rtl' : 'ltr'}
              rows={10}
              className="w-full text-xs leading-relaxed text-charcoal bg-cream/40 rounded-xl border border-sand/25 p-2.5 resize-y focus:outline-none focus:ring-2 focus:ring-copper/25"
            />
            {spec && (
              <>
                <button
                  onClick={() => setShowSpec((v) => !v)}
                  className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-charcoal/45 hover:text-charcoal transition-colors"
                >
                  <Database size={10} />
                  {isAr ? 'بيانات العقار (من قاعدة البيانات)' : 'Specs (from the database)'}
                </button>
                {showSpec && (
                  <pre
                    dir={lang === 'ar' ? 'rtl' : 'ltr'}
                    className="mt-1 text-[10px] leading-relaxed text-charcoal/70 bg-sand/10 rounded-lg p-2 whitespace-pre-wrap font-sans"
                  >
                    {spec}
                  </pre>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 px-3 pb-3 flex-wrap">
        {state.review !== 'rejected' ? (
          <>
            <button
              onClick={state.review === 'approved' ? onUnapprove : onApprove}
              disabled={state.cardStatus !== 'ready'}
              className={`flex-1 min-w-[72px] inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-40 ${
                state.review === 'approved'
                  ? 'bg-green-500 text-white hover:bg-green-600'
                  : 'bg-cream text-charcoal/60 hover:bg-sand/30 hover:text-charcoal'
              }`}
            >
              {state.review === 'approved' ? <Undo2 size={12} /> : <Check size={12} />}
              {state.review === 'approved' ? (isAr ? 'إلغاء' : 'Unapprove') : (isAr ? 'اعتماد' : 'Approve')}
            </button>
            <button
              onClick={onReject}
              disabled={state.cardStatus !== 'ready'}
              className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold text-red-600 bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-40"
            >
              <X size={12} />
              {isAr ? 'رفض' : 'Reject'}
            </button>
          </>
        ) : (
          <button
            onClick={onRestore}
            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold text-charcoal/60 bg-cream hover:bg-sand/30 hover:text-charcoal transition-colors"
          >
            <Undo2 size={12} />
            {isAr ? 'إعادة لمسودة' : 'Restore to draft'}
          </button>
        )}
        <button
          onClick={onRegenerate}
          disabled={state.cardStatus === 'generating'}
          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold text-charcoal/60 bg-cream hover:bg-sand/30 hover:text-charcoal transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={state.cardStatus === 'generating' ? 'animate-spin' : ''} />
          {isAr ? 'إعادة' : 'Rewrite'}
        </button>
        <button
          onClick={copy}
          disabled={state.cardStatus !== 'ready'}
          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold text-charcoal/60 bg-cream hover:bg-sand/30 hover:text-charcoal transition-colors disabled:opacity-40"
        >
          {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
          {copied ? (isAr ? 'تم' : 'Done') : (isAr ? 'نسخ' : 'Copy')}
        </button>
      </div>
    </div>
  );
}
