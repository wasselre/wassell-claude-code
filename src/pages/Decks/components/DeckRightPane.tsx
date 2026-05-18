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
  Paperclip,
  X,
  FileSpreadsheet,
  FileText as FileTextIcon,
  FileImage,
  File as FileIcon,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  signDeckUrl,
  enqueueGenerateDeck,
  uploadDeckAttachment,
  deleteDeckAttachment,
  type DeckAttachment,
  type DeckSize,
} from '@/lib/decks/client';

type Phase = 'calling-claude' | 'downloading' | 'uploading' | 'finalizing';
type ModelChoice = 'claude-opus-4-7' | 'claude-sonnet-4-6';
type LanguageChoice = 'ar' | 'en' | 'mixed';

/** If the record's `status='generating'` but `updated_at` hasn't moved
 * in this long, the worker is presumed dead. The UI shows the "looks
 * stuck — retry?" view instead of the spinner. The pg-side watchdog
 * (deck_jobs_watchdog) catches it at 20 min and flips it to 'failed'
 * for real, but the user shouldn't have to wait that long. */
const STUCK_THRESHOLD_MS = 6 * 60 * 1000;

/** UI-only superset of the wire `DeckAttachment` — adds local upload state
 * so the brief form can show progress / errors without persisting them
 * to the record. Once `status === 'ready'` the entry can be sent to the
 * API as a plain `DeckAttachment`. */
interface UiAttachment extends DeckAttachment {
  /** Local id for React keys / removal. */
  uiId: string;
  status: 'uploading' | 'ready' | 'failed';
  error?: string;
}

/** Mime types accepted by the brief form. Aligned with the bucket's
 * `allowed_mime_types` (see migration 2026-05-10). */
const ACCEPT_ATTRIBUTE = [
  '.xlsx', '.xls', '.csv',
  '.pdf',
  '.pptx', '.docx', '.doc',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif',
  '.txt',
].join(',');

interface Props {
  recordId: string;
  modelId: string;
  onNewDeck: () => void;
}

/**
 * Right pane for the Decks page. Renders one of four views based on
 * the deck record's `status` field (and a brief optimistic flag when
 * the user has just clicked Submit, so the GeneratingView appears
 * before the worker's first Realtime echo lands). All progress
 * updates flow through Supabase Realtime — no SSE here.
 */
export default function DeckRightPane({ recordId, modelId, onNewDeck }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);

  const record = useMemo<AppRecord | undefined>(
    () => (recordsByModel[modelId] ?? []).find((r) => r.id === recordId),
    [recordsByModel, modelId, recordId],
  );

  // Optimistic flag: true between clicking Generate and the worker's
  // first Realtime echo (which flips status to 'generating'). Cleared
  // once the record actually transitions out of 'queued'.
  const [submitted, setSubmitted] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  // Heartbeat for the stuck-detector. Ticks every 15s while a generation
  // is active so the "stuck > 6 min" check re-evaluates on its own —
  // otherwise a dead worker means no Realtime events means no re-renders.
  const [nowTick, setNowTick] = useState(() => Date.now());

  const status = (record?.data?.status as string | undefined) ?? 'queued';
  const phase = (record?.data?.phase as Phase | undefined) ?? 'calling-claude';
  const phaseDetail = (record?.data?.phase_detail as string | undefined) ?? '';
  const errorMessage = (record?.data?.error_message as string | undefined) ?? '';

  useEffect(() => {
    if (status !== 'generating' && !submitted) return;
    const t = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [status, submitted]);

  // Clear the optimistic flag once the worker has stamped 'generating',
  // 'ready', or 'failed' on the record. The flag exists only to bridge
  // the gap between submit and that first echo.
  useEffect(() => {
    if (submitted && status !== 'queued') setSubmitted(false);
  }, [status, submitted]);

  // Reset transient state when switching to a different deck record.
  useEffect(() => {
    setSubmitted(false);
    setEnqueueError(null);
  }, [recordId]);

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-charcoal/60">
        {isAr ? 'العرض غير موجود.' : 'Deck not found.'}
      </div>
    );
  }

  async function startGeneration(args: {
    brief: string;
    title: string;
    language: LanguageChoice;
    model: ModelChoice;
    size: DeckSize;
    attachments: DeckAttachment[];
  }) {
    const { brief, title, language, model, size, attachments } = args;
    setEnqueueError(null);
    setSubmitted(true);
    if (record) {
      // Persist the user-facing fields (title / brief / hints / attachments)
      // straight away so the list pane reflects them and so a refresh
      // mid-flight doesn't lose what they typed. Don't write status here
      // — the worker stamps 'generating' on the first phase update.
      try {
        await useAppStore.getState().saveRecord({
          ...record,
          data: {
            ...record.data,
            title,
            brief,
            language,
            model_used: model,
            size,
            attachments,
            // Clear any prior error message + ready-state fields so the
            // GeneratingView doesn't flash stale "ready" content during
            // the retry. Keep status='queued' until the worker echoes.
            status: 'queued',
            phase: null,
            phase_detail: null,
            error_message: null,
            file_url: null,
            file_path: null,
            filename: null,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setEnqueueError(`Could not save brief: ${msg}`);
        setSubmitted(false);
        return;
      }
    }

    try {
      await enqueueGenerateDeck({ recordId, brief, language, model, size, attachments });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEnqueueError(msg);
      setSubmitted(false);
    }
  }

  function retry() {
    if (!record) return;
    const brief = (record.data.brief as string | undefined) ?? '';
    const title = (record.data.title as string | undefined) ?? '';
    const language = ((record.data.language as LanguageChoice | undefined) ?? 'ar') as LanguageChoice;
    const model = ((record.data.model_used as ModelChoice | undefined) ?? 'claude-opus-4-7') as ModelChoice;
    const size = ((record.data.size as DeckSize | undefined) ?? '16:9') as DeckSize;
    const attachments = ((record.data.attachments as DeckAttachment[] | undefined) ?? []);
    void startGeneration({ brief, title, language, model, size, attachments });
  }

  // ── Stuck detection ──────────────────────────────────────────────────
  // Only meaningful while the record claims to be generating. If the worker
  // hasn't updated the record in over STUCK_THRESHOLD_MS, render the
  // failed view with a clear "press Try again" message even though the
  // DB still says 'generating' — the pg watchdog will eventually catch
  // up but we give the user an immediate way out.
  const updatedAtMs = new Date(record.updated_at).getTime();
  const stalenessMs = nowTick - updatedAtMs;
  const isStuck = status === 'generating' && stalenessMs > STUCK_THRESHOLD_MS && !submitted;

  // ── View selection ───────────────────────────────────────────────────
  if (enqueueError) {
    return (
      <FailedView
        isAr={isAr}
        message={enqueueError}
        onRetry={retry}
        onNewDeck={onNewDeck}
      />
    );
  }
  if (isStuck) {
    const minutes = Math.floor(stalenessMs / 60_000);
    return (
      <FailedView
        isAr={isAr}
        message={
          isAr
            ? `لم تصل أي تحديثات منذ ${minutes} دقيقة. يبدو أن الخادم توقّف. اضغط "إعادة المحاولة".`
            : `No updates from the worker in ${minutes} min. Looks stuck — press Try again.`
        }
        onRetry={retry}
        onNewDeck={onNewDeck}
      />
    );
  }
  if (status === 'generating' || submitted) {
    return <GeneratingView isAr={isAr} phase={phase} detail={phaseDetail} />;
  }
  if (status === 'ready') {
    return <ReadyView isAr={isAr} record={record} onNewDeck={onNewDeck} onRetry={retry} />;
  }
  if (status === 'failed') {
    return (
      <FailedView
        isAr={isAr}
        message={errorMessage}
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
  onSubmit: (args: {
    brief: string;
    title: string;
    language: LanguageChoice;
    model: ModelChoice;
    size: DeckSize;
    attachments: DeckAttachment[];
  }) => Promise<void>;
}) {
  // Storage path-prefix RLS keys off auth.uid() (the Supabase auth user id),
  // NOT the CRM-internal users.id. Use authUid here so uploads land at
  // <auth.uid()>/<deck_id>/uploads/... and the storage policy passes.
  const userId = useAppStore((s) => s.authUid);
  const [title, setTitle] = useState((record.data.title as string | undefined) ?? '');
  const [brief, setBrief] = useState((record.data.brief as string | undefined) ?? '');
  const [language, setLanguage] = useState<LanguageChoice>(
    ((record.data.language as LanguageChoice | undefined) ?? 'ar') as LanguageChoice,
  );
  const [model, setModel] = useState<ModelChoice>(
    // Default to Opus 4.7 — produces visibly better designs than Sonnet.
    // The earlier file_id capture issue with Opus is no longer blocking
    // because the worker returns bytes via the base64-stdout channel
    // instead of relying on Anthropic's file capture.
    ((record.data.model_used as ModelChoice | undefined) ?? 'claude-opus-4-7') as ModelChoice,
  );
  const [size, setSize] = useState<DeckSize>(
    ((record.data.size as DeckSize | undefined) ?? '16:9') as DeckSize,
  );

  // Hydrate any attachments persisted on a previous in-flight save (e.g.
  // user uploaded files, refreshed the page, came back). Stored entries
  // are already 'ready' — only freshly-picked files go through 'uploading'.
  const initialAttachments: UiAttachment[] = useMemo(() => {
    const stored = record.data.attachments as DeckAttachment[] | undefined;
    if (!Array.isArray(stored)) return [];
    return stored.map((a) => ({ ...a, uiId: crypto.randomUUID(), status: 'ready' as const }));
    // Only on mount — user edits should not be clobbered by record updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [attachments, setAttachments] = useState<UiAttachment[]>(initialAttachments);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length;
  const canSubmit =
    title.trim().length > 0 && brief.trim().length >= 10 && uploadingCount === 0;

  function addFiles(files: FileList | File[]) {
    if (!userId) {
      alert(isAr ? 'يجب تسجيل الدخول لرفع المرفقات.' : 'Sign in to upload attachments.');
      return;
    }
    const arr = Array.from(files);
    const placeholders: UiAttachment[] = arr.map((file) => ({
      uiId: crypto.randomUUID(),
      name: file.name,
      path: '',
      mimeType: file.type || '',
      size: file.size,
      status: 'uploading' as const,
    }));
    setAttachments((prev) => [...prev, ...placeholders]);

    arr.forEach(async (file, idx) => {
      const placeholder = placeholders[idx]!;
      try {
        const result = await uploadDeckAttachment(userId, record.id, file);
        setAttachments((prev) =>
          prev.map((a) =>
            a.uiId === placeholder.uiId
              ? { ...a, ...result, status: 'ready' as const }
              : a,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAttachments((prev) =>
          prev.map((a) =>
            a.uiId === placeholder.uiId
              ? { ...a, status: 'failed' as const, error: msg }
              : a,
          ),
        );
      }
    });
  }

  async function removeAttachment(uiId: string) {
    const target = attachments.find((a) => a.uiId === uiId);
    setAttachments((prev) => prev.filter((a) => a.uiId !== uiId));
    if (target?.path && target.status === 'ready') {
      try {
        await deleteDeckAttachment(target.path);
      } catch (err) {
        // Best-effort: log but don't block the UI. A leftover file will
        // be paid for in a tiny amount of bucket storage; not a correctness
        // issue. (Surfaced via console so we can inspect later.)
        console.warn('[DeckRightPane] removeAttachment storage delete failed:', err);
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    // Strip UI-only state before sending to the API. Failed uploads are
    // skipped so the run isn't poisoned by missing files.
    const ready: DeckAttachment[] = attachments
      .filter((a) => a.status === 'ready')
      .map(({ path, name, mimeType, size }) => ({ path, name, mimeType, size }));
    await onSubmit({
      brief: brief.trim(),
      title: title.trim(),
      language,
      model,
      size,
      attachments: ready,
    });
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
                { v: 'claude-opus-4-7', label: 'Opus 4.7', sub: isAr ? 'أعلى جودة' : 'Best quality' },
                { v: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sub: isAr ? 'أسرع وأرخص' : 'Faster, cheaper' },
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

      {/* Size selector — visual aspect-ratio thumbnails so the user can
          see the orientation at a glance instead of parsing "9:16" math.
          Each option shows a mini-rectangle proportioned to the ratio. */}
      <fieldset className="mb-6">
        <legend className="text-sm font-medium text-charcoal mb-2">
          {isAr ? 'حجم الشرائح' : 'Slide size'}
        </legend>
        <div className="grid grid-cols-4 gap-2">
          {(
            [
              { v: '16:9', label: isAr ? '١٦:٩' : '16:9', sub: isAr ? 'أفقي' : 'Widescreen', boxClass: 'w-9 h-[20px]' },
              { v: '9:16', label: isAr ? '٩:١٦' : '9:16', sub: isAr ? 'رأسي' : 'Vertical',  boxClass: 'w-[14px] h-[26px]' },
              { v: '4:3',  label: isAr ? '٤:٣' : '4:3',   sub: isAr ? 'قياسي' : 'Standard',  boxClass: 'w-7 h-[21px]' },
              { v: '1:1',  label: isAr ? '١:١' : '1:1',   sub: isAr ? 'مربع' : 'Square',     boxClass: 'w-5 h-5' },
            ] as const
          ).map((opt) => (
            <label
              key={opt.v}
              className={`px-2 py-3 rounded-lg border text-center cursor-pointer transition-colors ${
                size === opt.v
                  ? 'border-copper bg-copper/10 text-copper font-medium'
                  : 'border-sand/40 text-charcoal/70 hover:border-copper/50'
              }`}
            >
              <input
                type="radio"
                name="size"
                value={opt.v}
                checked={size === opt.v}
                onChange={() => setSize(opt.v as DeckSize)}
                className="sr-only"
              />
              <div className="flex items-center justify-center h-7 mb-1">
                <div className={`rounded-sm border-[1.5px] border-current ${opt.boxClass}`} />
              </div>
              <div className="text-xs">{opt.label}</div>
              <div className="text-[10px] opacity-70 leading-tight">{opt.sub}</div>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Attachments — drop or pick files for Claude to inspect inside the
          sandbox. Uploads happen immediately to wassel-decks under
          <user>/<deck>/uploads/ so they survive a tab refresh and so the
          generation request body stays small. Per-file cap aligned with
          Anthropic's Files API limit (32 MB). */}
      <fieldset className="mb-6">
        <legend className="text-sm font-medium text-charcoal mb-2">
          {isAr ? 'المرفقات (اختياري)' : 'Attachments (optional)'}
        </legend>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-lg border-2 border-dashed cursor-pointer p-4 text-center text-sm transition-colors ${
            isDragOver
              ? 'border-copper bg-copper/10 text-copper'
              : 'border-sand/40 text-charcoal/60 hover:border-copper/50 hover:bg-cream/50'
          }`}
        >
          <Paperclip size={20} className="mx-auto mb-1.5 opacity-70" />
          <div>
            {isAr
              ? 'اسحب الملفات هنا أو اضغط للاختيار'
              : 'Drop files here or click to choose'}
          </div>
          <div className="text-[11px] opacity-70 mt-1">
            {isAr
              ? 'Excel ، PDF ، PowerPoint ، Word ، صور (حد أقصى ٣٢ ميجابايت لكل ملف)'
              : 'Excel, PDF, PowerPoint, Word, images (32 MB max each)'}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTRIBUTE}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              // Reset so the same file can be re-picked after a remove.
              e.target.value = '';
            }}
          />
        </div>

        {attachments.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {attachments.map((att) => (
              <AttachmentRow
                key={att.uiId}
                att={att}
                isAr={isAr}
                onRemove={() => removeAttachment(att.uiId)}
              />
            ))}
          </ul>
        )}
      </fieldset>

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full md:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:bg-charcoal/20 disabled:cursor-not-allowed transition-colors font-medium"
      >
        <Sparkles size={16} />
        {isAr ? 'توليد العرض' : 'Generate deck'}
        {uploadingCount > 0 && (
          <span className="text-xs opacity-90">
            {isAr
              ? `(جارٍ رفع ${uploadingCount}…)`
              : `(${uploadingCount} uploading…)`}
          </span>
        )}
      </button>

      <p className="text-xs text-charcoal/50 mt-4">
        {isAr
          ? 'يستغرق التوليد عادةً من دقيقة إلى ثلاث دقائق.'
          : 'Generation typically takes 1–3 minutes.'}
      </p>
    </form>
  );
}

/** Single attachment row in the brief form's list. Surfaces upload progress
 * and any failure inline so a user can retry by removing + re-picking. */
function AttachmentRow({
  att,
  isAr,
  onRemove,
}: {
  att: UiAttachment;
  isAr: boolean;
  onRemove: () => void;
}) {
  const Icon = pickAttachmentIcon(att.mimeType, att.name);
  const sizeMb = (att.size / 1024 / 1024).toFixed(att.size < 1024 * 1024 ? 2 : 1);
  return (
    <li
      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-sm ${
        att.status === 'failed'
          ? 'border-red-200 bg-red-50'
          : 'border-sand/30 bg-cream/40'
      }`}
    >
      <Icon size={16} className={att.status === 'failed' ? 'text-red-600' : 'text-copper'} />
      <div className="flex-1 min-w-0">
        <div className="truncate text-charcoal">{att.name}</div>
        <div className="text-[11px] text-charcoal/50">
          {sizeMb} MB
          {att.status === 'uploading' && ` · ${isAr ? 'جارٍ الرفع…' : 'uploading…'}`}
          {att.status === 'failed' && att.error ? ` · ${att.error}` : ''}
        </div>
      </div>
      {att.status === 'uploading' && <Loader2 size={14} className="animate-spin text-charcoal/40" />}
      <button
        type="button"
        onClick={onRemove}
        className="p-1 rounded hover:bg-charcoal/5 text-charcoal/50 hover:text-red-600"
        aria-label={isAr ? 'إزالة' : 'Remove'}
      >
        <X size={14} />
      </button>
    </li>
  );
}

/** Pick a Lucide icon based on the file's mime + extension. Falls back to
 * a generic file icon for anything we don't classify. */
function pickAttachmentIcon(mimeType: string, name: string): typeof FileIcon {
  const lowerName = name.toLowerCase();
  if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif|hei[cf])$/i.test(lowerName)) {
    return FileImage;
  }
  if (mimeType.includes('spreadsheet') || /\.(xlsx?|csv)$/i.test(lowerName)) {
    return FileSpreadsheet;
  }
  if (mimeType.includes('pdf') || /\.pdf$/i.test(lowerName)) {
    return FileTextIcon;
  }
  if (mimeType.includes('presentation') || /\.pptx?$/i.test(lowerName)) {
    return FileTextIcon;
  }
  if (mimeType.includes('word') || /\.docx?$/i.test(lowerName)) {
    return FileTextIcon;
  }
  return FileIcon;
}

// ────────────────────────────────────────────────────────────────────────
// Generating view
// ────────────────────────────────────────────────────────────────────────

function GeneratingView({ isAr, phase, detail }: { isAr: boolean; phase: Phase; detail: string }) {
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
        {detail && (
          <p className="text-xs text-charcoal/50 text-center mb-2 truncate" title={detail}>
            {detail}
          </p>
        )}
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
        <div className="text-sm text-charcoal/70 bg-red-50 border border-red-100 rounded-lg p-3 mb-6 text-start whitespace-pre-wrap max-h-96 overflow-y-auto">
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
