import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  Sparkles,
  Download,
  AlertCircle,
  RotateCcw,
  Plus,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { signDeckUrl, streamGenerateDeck } from '@/lib/decks/client';

type Phase = 'calling-claude' | 'downloading' | 'uploading' | 'finalizing';
type ModelChoice = 'claude-opus-4-7' | 'claude-sonnet-4-6';
type LanguageChoice = 'ar' | 'en' | 'mixed';

interface Props {
  recordId: string;
  modelId: string;
  onNewDeck: () => void;
}

/**
 * Right pane for the Decks page. Renders one of four views based on the
 * deck record's status field, plus drives the SSE stream during a live
 * generation. Local state carries the phase + any error so the UI updates
 * faster than the store's realtime echo.
 */
export default function DeckRightPane({ recordId, modelId, onNewDeck }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);

  const record = useMemo<AppRecord | undefined>(
    () => (recordsByModel[modelId] ?? []).find((r) => r.id === recordId),
    [recordsByModel, modelId, recordId],
  );

  const [livePhase, setLivePhase] = useState<Phase | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight stream when the record changes (user navigates away).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [recordId]);

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-charcoal/60">
        {isAr ? 'العرض غير موجود.' : 'Deck not found.'}
      </div>
    );
  }

  const status = (record.data.status as string | undefined) ?? 'queued';
  const isStreaming = livePhase !== null;
  const effectiveStatus = isStreaming ? 'generating' : status;

  async function startGeneration(brief: string, title: string, language: LanguageChoice, model: ModelChoice) {
    setLiveError(null);
    setLivePhase('calling-claude');

    // Save the brief / title / hints to the record FIRST so they survive a
    // network failure mid-stream and so the list pane reflects the title
    // immediately. The endpoint also stamps language + model_used, but we
    // do it here too so the values appear before the first SSE tick.
    if (record) {
      const newData = {
        ...record.data,
        title,
        brief,
        language,
        model_used: model,
        status: 'queued', // endpoint flips to 'generating' on entry
      };
      await saveRecord({ ...record, data: newData });
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await streamGenerateDeck(
        { recordId, brief, language, model },
        (event) => {
          if (event.type === 'status') setLivePhase(event.phase);
          else if (event.type === 'error') setLiveError(event.message);
          else if (event.type === 'done') {
            setLivePhase(null);
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setLiveError(msg);
      }
    } finally {
      setLivePhase(null);
      abortRef.current = null;
    }
  }

  function retry() {
    const brief = (record.data.brief as string | undefined) ?? '';
    const title = (record.data.title as string | undefined) ?? '';
    const language = ((record.data.language as LanguageChoice | undefined) ?? 'ar') as LanguageChoice;
    const model = ((record.data.model_used as ModelChoice | undefined) ?? 'claude-opus-4-7') as ModelChoice;
    void startGeneration(brief, title, language, model);
  }

  if (effectiveStatus === 'generating' || isStreaming) {
    return <GeneratingView isAr={isAr} phase={livePhase ?? 'calling-claude'} />;
  }
  if (effectiveStatus === 'ready') {
    return <ReadyView isAr={isAr} record={record} onNewDeck={onNewDeck} onRetry={retry} />;
  }
  if (effectiveStatus === 'failed') {
    return (
      <FailedView
        isAr={isAr}
        message={liveError ?? (record.data.error_message as string | undefined) ?? ''}
        onRetry={retry}
        onNewDeck={onNewDeck}
      />
    );
  }
  return <BriefForm isAr={isAr} record={record} onSubmit={startGeneration} />;
}

// ────────────────────────────────────────────────────────────────────────
// Brief form
// ────────────────────────────────────────────────────────────────────────

function BriefForm({
  isAr,
  record,
  onSubmit,
}: {
  isAr: boolean;
  record: AppRecord;
  onSubmit: (brief: string, title: string, language: LanguageChoice, model: ModelChoice) => Promise<void>;
}) {
  const [title, setTitle] = useState((record.data.title as string | undefined) ?? '');
  const [brief, setBrief] = useState((record.data.brief as string | undefined) ?? '');
  const [language, setLanguage] = useState<LanguageChoice>(
    ((record.data.language as LanguageChoice | undefined) ?? 'ar') as LanguageChoice,
  );
  const [model, setModel] = useState<ModelChoice>(
    ((record.data.model_used as ModelChoice | undefined) ?? 'claude-opus-4-7') as ModelChoice,
  );
  const canSubmit = title.trim().length > 0 && brief.trim().length >= 10;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(brief.trim(), title.trim(), language, model);
  }

  return (
    <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto w-full">
      <h2 className="text-xl font-semibold text-charcoal mb-1">
        {isAr ? 'عرض تقديمي جديد' : 'New deck'}
      </h2>
      <p className="text-sm text-charcoal/70 mb-6">
        {isAr
          ? 'اكتب الموجز بأي لغة. كلما زادت التفاصيل (الغرض، الجمهور، عدد الشرائح، النبرة) كان الناتج أفضل.'
          : 'Write the brief in any language. The more detail you give — purpose, audience, slide count, tone — the better the result.'}
      </p>

      {/* Title */}
      <label className="block mb-4">
        <span className="text-sm font-medium text-charcoal mb-1 block">
          {isAr ? 'العنوان' : 'Title'} <span className="text-red-500">*</span>
        </span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={isAr ? 'مثال: عرض قدراتنا لشركة المطلق' : 'e.g. Capability deck for AlMutlaq'}
          className="w-full px-3 py-2 rounded-lg border border-sand/40 focus:border-copper focus:outline-none focus:ring-1 focus:ring-copper bg-white"
        />
      </label>

      {/* Brief */}
      <label className="block mb-4">
        <span className="text-sm font-medium text-charcoal mb-1 block">
          {isAr ? 'الموجز' : 'Brief'} <span className="text-red-500">*</span>
        </span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={10}
          placeholder={
            isAr
              ? 'صف ما تريده: الغرض من العرض، الجمهور، الرسالة الأساسية، عدد الشرائح، الأقسام التي تريدها، النبرة (رسمية / حماسية / تقنية)…'
              : 'Describe what you want: purpose, audience, key message, slide count, sections, tone (formal / energetic / technical)…'
          }
          className="w-full px-3 py-2 rounded-lg border border-sand/40 focus:border-copper focus:outline-none focus:ring-1 focus:ring-copper bg-white resize-y leading-relaxed"
        />
        <span className="text-xs text-charcoal/50 mt-1 block">
          {brief.trim().length < 10
            ? isAr
              ? 'اكتب 10 أحرف على الأقل.'
              : 'At least 10 characters.'
            : isAr
              ? `${brief.trim().length} حرف`
              : `${brief.trim().length} characters`}
        </span>
      </label>

      {/* Language + Model — side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <fieldset>
          <legend className="text-sm font-medium text-charcoal mb-2">
            {isAr ? 'اللغة' : 'Language'}
          </legend>
          <div className="flex gap-2">
            {(['ar', 'en', 'mixed'] as const).map((l) => (
              <label
                key={l}
                className={`flex-1 px-3 py-2 rounded-lg border text-center text-sm cursor-pointer ${
                  language === l
                    ? 'border-copper bg-copper/10 text-copper font-medium'
                    : 'border-sand/40 text-charcoal/70 hover:border-copper/50'
                }`}
              >
                <input
                  type="radio"
                  name="language"
                  value={l}
                  checked={language === l}
                  onChange={() => setLanguage(l)}
                  className="sr-only"
                />
                {l === 'ar' ? (isAr ? 'عربي' : 'Arabic') : l === 'en' ? (isAr ? 'إنجليزي' : 'English') : isAr ? 'مختلط' : 'Mixed'}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-charcoal mb-2">
            {isAr ? 'النموذج' : 'Model'}
          </legend>
          <div className="flex gap-2">
            {(
              [
                { v: 'claude-opus-4-7', label: 'Opus 4.7', sub: isAr ? 'الأجود' : 'Best' },
                { v: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sub: isAr ? 'أوفر' : 'Cheaper' },
              ] as const
            ).map((opt) => (
              <label
                key={opt.v}
                className={`flex-1 px-3 py-2 rounded-lg border text-center text-sm cursor-pointer ${
                  model === opt.v
                    ? 'border-copper bg-copper/10 text-copper font-medium'
                    : 'border-sand/40 text-charcoal/70 hover:border-copper/50'
                }`}
              >
                <input
                  type="radio"
                  name="model"
                  value={opt.v}
                  checked={model === opt.v}
                  onChange={() => setModel(opt.v)}
                  className="sr-only"
                />
                <div>{opt.label}</div>
                <div className="text-[10px] opacity-70 mt-0.5">{opt.sub}</div>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full md:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:bg-charcoal/20 disabled:cursor-not-allowed transition-colors font-medium"
      >
        <Sparkles size={16} />
        {isAr ? 'توليد العرض' : 'Generate deck'}
      </button>

      <p className="text-xs text-charcoal/50 mt-4">
        {isAr
          ? 'يستغرق التوليد عادةً من دقيقة إلى ثلاث دقائق.'
          : 'Generation typically takes 1–3 minutes.'}
      </p>
    </form>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Generating view
// ────────────────────────────────────────────────────────────────────────

function GeneratingView({ isAr, phase }: { isAr: boolean; phase: Phase }) {
  const phases: Phase[] = ['calling-claude', 'downloading', 'uploading', 'finalizing'];
  const labels: Record<Phase, { ar: string; en: string }> = {
    'calling-claude': { ar: 'يفكر Claude في تصميم العرض…', en: 'Claude is composing the deck…' },
    downloading: { ar: 'تحميل الملف من Anthropic…', en: 'Downloading from Anthropic…' },
    uploading: { ar: 'رفع الملف إلى التخزين…', en: 'Uploading to storage…' },
    finalizing: { ar: 'إنهاء…', en: 'Finalizing…' },
  };
  const currentIdx = phases.indexOf(phase);
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full">
        <div className="flex items-center justify-center mb-6">
          <Loader2 size={48} className="text-copper animate-spin" />
        </div>
        <h2 className="text-lg font-semibold text-charcoal text-center mb-2">
          {isAr ? labels[phase].ar : labels[phase].en}
        </h2>
        <p className="text-sm text-charcoal/60 text-center mb-6">
          {isAr ? 'قد يستغرق هذا 1-3 دقائق.' : 'This may take 1–3 minutes.'}
        </p>
        <div className="space-y-2">
          {phases.map((p, idx) => {
            const done = idx < currentIdx;
            const active = idx === currentIdx;
            return (
              <div
                key={p}
                className={`flex items-center gap-2 text-sm ${
                  active ? 'text-copper font-medium' : done ? 'text-charcoal/70' : 'text-charcoal/30'
                }`}
              >
                <div
                  className={`w-2 h-2 rounded-full ${
                    done ? 'bg-copper' : active ? 'bg-copper animate-pulse' : 'bg-charcoal/20'
                  }`}
                />
                {isAr ? labels[p].ar : labels[p].en}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Ready view
// ────────────────────────────────────────────────────────────────────────

function ReadyView({
  isAr,
  record,
  onNewDeck,
  onRetry,
}: {
  isAr: boolean;
  record: AppRecord;
  onNewDeck: () => void;
  onRetry: () => void;
}) {
  const filename = (record.data.filename as string | undefined) ?? 'deck.pptx';
  const title = (record.data.title as string | undefined) ?? '';
  const initialUrl = (record.data.file_url as string | undefined) ?? '';
  const [url, setUrl] = useState(initialUrl);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Re-sign on mount: signed URLs expire in 7 days, but it's cheap to mint a
  // fresh one on every visit so download always works without surfacing
  // expiry handling to the user. Errors fall back to the stored URL.
  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    signDeckUrl(record.id)
      .then((res) => {
        if (!cancelled) setUrl(res.file_url);
      })
      .catch((err) => {
        console.warn('[DeckRightPane] sign refresh failed:', err);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id]);

  function copyLink() {
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
          <Sparkles size={32} className="text-green-700" />
        </div>
        <h2 className="text-xl font-semibold text-charcoal mb-1">
          {isAr ? 'العرض جاهز' : 'Deck ready'}
        </h2>
        {title && <p className="text-sm text-charcoal/70 mb-1 truncate">{title}</p>}
        <p className="text-xs text-charcoal/50 mb-6 truncate">{filename}</p>

        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <a
            href={url || undefined}
            download={filename}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors font-medium ${
              !url ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            {refreshing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            {isAr ? 'تحميل' : 'Download'}
          </a>
          <button
            onClick={copyLink}
            disabled={!url}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-sand/40 text-charcoal hover:bg-cream transition-colors text-sm"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {isAr ? (copied ? 'تم النسخ' : 'نسخ الرابط') : copied ? 'Copied' : 'Copy link'}
          </button>
        </div>

        <div className="mt-8 pt-6 border-t border-sand/20 flex gap-2 justify-center">
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-charcoal/70 hover:bg-cream transition-colors"
          >
            <RotateCcw size={14} />
            {isAr ? 'إعادة التوليد' : 'Regenerate'}
          </button>
          <button
            onClick={onNewDeck}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-charcoal/70 hover:bg-cream transition-colors"
          >
            <Plus size={14} />
            {isAr ? 'عرض جديد' : 'New deck'}
          </button>
        </div>

        {url && !refreshing && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1 text-xs text-charcoal/40 hover:text-copper"
          >
            <ExternalLink size={10} />
            {isAr ? 'فتح في تبويب جديد' : 'Open in new tab'}
          </a>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Failed view
// ────────────────────────────────────────────────────────────────────────

function FailedView({
  isAr,
  message,
  onRetry,
  onNewDeck,
}: {
  isAr: boolean;
  message: string;
  onRetry: () => void;
  onNewDeck: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
          <AlertCircle size={32} className="text-red-700" />
        </div>
        <h2 className="text-xl font-semibold text-charcoal mb-2">
          {isAr ? 'فشل التوليد' : 'Generation failed'}
        </h2>
        <div className="text-sm text-charcoal/70 bg-red-50 border border-red-100 rounded-lg p-3 mb-6 text-start whitespace-pre-wrap">
          {message || (isAr ? 'حدث خطأ غير معروف.' : 'Unknown error.')}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <button
            onClick={onRetry}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors font-medium"
          >
            <RotateCcw size={16} />
            {isAr ? 'إعادة المحاولة' : 'Try again'}
          </button>
          <button
            onClick={onNewDeck}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-sand/40 text-charcoal hover:bg-cream transition-colors text-sm"
          >
            <Plus size={14} />
            {isAr ? 'عرض جديد' : 'New deck'}
          </button>
        </div>
      </div>
    </div>
  );
}
