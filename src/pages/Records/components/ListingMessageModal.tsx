import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  fetchDraftData,
  generateListingMessageText,
  isCleaningInFlight,
  readCleaning,
  redoListingClean,
  startListingClean,
  type CleaningEntry,
} from '@/lib/listingMessage/client';

interface Props {
  listingId: string;
  listingTitle: string;
  chatTemplatesModelId: string;
  /** An existing 'ready' template for this listing, if one was found (reuse-first). */
  existing: AppRecord | null;
  onClose: () => void;
}

type Mode = 'existing' | 'generating';

/**
 * Generate (or view) the reusable WhatsApp message for ONE market listing:
 * AI-written editable text + every listing photo cleaned of text. Reuse-first is
 * decided by the caller (existing != null → start in 'existing' mode). On Approve
 * the draft becomes a ready chat_templates record linked to the listing, and any
 * other template for the same listing is removed (one current message per listing).
 */
export default function ListingMessageModal({
  listingId,
  listingTitle,
  chatTemplatesModelId,
  existing,
  onClose,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const deleteRecord = useAppStore((s) => s.deleteRecord);
  const records = useAppStore((s) => s.records);
  const tr = (ar: string, en: string) => (isAr ? ar : en);

  const [mode, setMode] = useState<Mode>(existing ? 'existing' : 'generating');

  // ── generating-mode state ────────────────────────────────────────────
  const [recordId, setRecordId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [name, setName] = useState(listingTitle);
  const [bodyAr, setBodyAr] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState<CleaningEntry[]>([]);
  const [pollNonce, setPollNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const startedRef = useRef(false);

  // Kick off generation once when entering generating mode with no draft yet.
  useEffect(() => {
    if (mode !== 'generating' || startedRef.current) return;
    startedRef.current = true;
    void runGeneration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const runGeneration = async () => {
    setStartError(null);
    setTextError(null);
    setCleaning([]);
    setTextLoading(true);
    setName(listingTitle);
    // Photo cleaning (creates the draft + fans out the jobs).
    try {
      const { recordId: rid } = await startListingClean(listingId);
      setRecordId(rid);
      setPollNonce((n) => n + 1);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
    // AI message text (independent of cleaning).
    try {
      const txt = await generateListingMessageText(listingId);
      setBodyAr(txt.body_ar);
      setBodyEn(txt.body_en);
    } catch (err) {
      setTextError(err instanceof Error ? err.message : String(err));
    } finally {
      setTextLoading(false);
    }
  };

  // Poll the draft for cleaning progress while any photo is still in flight.
  useEffect(() => {
    if (!recordId) return;
    let active = true;
    let iv: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const data = await fetchDraftData(recordId);
        if (!active) return;
        const entries = readCleaning(data);
        setCleaning(entries);
        if (!isCleaningInFlight(entries) && iv) {
          clearInterval(iv);
          iv = null;
        }
      } catch {
        /* transient network — keep polling */
      }
    };
    void tick();
    iv = setInterval(tick, 2500);
    return () => {
      active = false;
      if (iv) clearInterval(iv);
    };
  }, [recordId, pollNonce]);

  const inFlight = isCleaningInFlight(cleaning);
  const completed = cleaning.filter((c) => c.status === 'completed');
  const failedCount = cleaning.filter((c) => c.status === 'failed').length;

  const redo = async (entryIds: string[]) => {
    if (!recordId || entryIds.length === 0) return;
    // Optimistically flip them back to queued so the spinner returns immediately.
    setCleaning((prev) =>
      prev.map((c) => (entryIds.includes(c.id) ? { ...c, status: 'queued', output_url: undefined, error: undefined } : c)),
    );
    try {
      await redoListingClean(recordId, entryIds);
      setPollNonce((n) => n + 1);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const approve = async () => {
    if (!recordId) return;
    setSaving(true);
    const images = completed.map((c) => ({
      asset_id: c.asset_id ?? null,
      public_url: c.output_url ?? null,
      source_url: c.source_url,
      image_index: c.image_index,
    }));
    const nowIso = new Date().toISOString();
    const rec: AppRecord = {
      id: recordId,
      model_id: chatTemplatesModelId,
      data: {
        name: name.trim() || listingTitle,
        language: 'both',
        tags: ['listing'],
        listing_id: listingId,
        status: 'ready',
        body_ar: bodyAr,
        body_en: bodyEn,
        images,
        cleaning,
      },
      created_at: nowIso,
      updated_at: nowIso,
    } as AppRecord;
    try {
      const result = await saveRecord(rec);
      if (result.status !== 'saved') {
        setSaving(false);
        return; // store already toasted the conflict / failure
      }
      // One current message per listing: drop any OTHER template (old 'ready' or
      // stray draft) for this same listing.
      const siblings = (records[chatTemplatesModelId] ?? []).filter(
        (r) => r.id !== recordId && (r.data as Record<string, unknown>)?.listing_id === listingId,
      );
      for (const s of siblings) deleteRecord(chatTemplatesModelId, s.id);
      addToast(tr('تم حفظ رسالة الإعلان', 'Listing message saved'), 'success');
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
      setSaving(false);
    }
  };

  // ── Existing-mode view (reuse-first hit) ─────────────────────────────
  if (mode === 'existing' && existing) {
    const d = (existing.data ?? {}) as Record<string, unknown>;
    const exImages = Array.isArray(d.images) ? (d.images as Array<{ public_url?: string }>) : [];
    return (
      <Shell onClose={onClose} title={tr('رسالة الإعلان', 'Listing message')} isAr={isAr}>
        <p className="text-xs text-charcoal/50 mb-3">
          {tr(
            'يوجد بالفعل رسالة محفوظة لهذا الإعلان. يمكنك استخدامها أو إعادة إنشائها.',
            'A saved message already exists for this listing. Use it, or regenerate it.',
          )}
        </p>
        <MessagePreview ar={(d.body_ar as string) ?? ''} en={(d.body_en as string) ?? ''} isAr={isAr} />
        {exImages.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-3">
            {exImages.map((im, i) =>
              im.public_url ? (
                <img
                  key={i}
                  src={im.public_url}
                  alt=""
                  className="w-full aspect-square object-cover rounded-lg border border-sand/30"
                />
              ) : null,
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={onClose}>
            {tr('إغلاق', 'Close')}
          </Button>
          <Button variant="primary" onClick={() => setMode('generating')}>
            <RefreshCw size={16} />
            {tr('إعادة الإنشاء', 'Regenerate')}
          </Button>
        </div>
      </Shell>
    );
  }

  // ── Generating-mode view ─────────────────────────────────────────────
  return (
    <Shell onClose={onClose} title={tr('إنشاء رسالة الإعلان', 'Generate listing message')} isAr={isAr}>
      {/* Status banner */}
      <div className="flex items-center gap-2 mb-3 text-sm">
        {inFlight ? (
          <>
            <Loader2 size={16} className="animate-spin text-copper" />
            <span className="text-charcoal/70">
              {tr(
                `تم إنشاء الرسالة — جارٍ تنظيف الصور (${completed.length}/${cleaning.length})…`,
                `Message created — cleaning images (${completed.length}/${cleaning.length})…`,
              )}
            </span>
          </>
        ) : cleaning.length > 0 ? (
          <>
            <CheckCircle2 size={16} className="text-green-600" />
            <span className="text-charcoal/70">
              {tr(
                `اكتمل تنظيف ${completed.length} صورة. راجِع ووافِق.`,
                `Cleaned ${completed.length} image(s). Review and approve.`,
              )}
            </span>
          </>
        ) : (
          <>
            <Loader2 size={16} className="animate-spin text-copper" />
            <span className="text-charcoal/70">{tr('جارٍ التحضير…', 'Preparing…')}</span>
          </>
        )}
      </div>

      {startError && <ErrorBox message={startError} onRetry={runGeneration} isAr={isAr} />}

      {/* Editable name */}
      <label className="block text-xs font-bold text-charcoal/60 mb-1">{tr('اسم القالب', 'Template name')}</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="form-input w-full mb-3"
        placeholder={listingTitle}
      />

      {/* Editable message */}
      <div className="flex items-center gap-2 mb-1">
        <label className="block text-xs font-bold text-charcoal/60">{tr('نص الرسالة', 'Message text')}</label>
        {textLoading && <Loader2 size={12} className="animate-spin text-copper" />}
        <button
          type="button"
          onClick={() => void regenText()}
          disabled={textLoading}
          className="ms-auto inline-flex items-center gap-1 text-[0.7rem] font-bold text-copper hover:underline disabled:opacity-40"
        >
          <Sparkles size={12} />
          {tr('إعادة كتابة', 'Rewrite')}
        </button>
      </div>
      {textError && <ErrorBox message={textError} onRetry={regenText} isAr={isAr} />}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <textarea
          dir="rtl"
          value={bodyAr}
          onChange={(e) => setBodyAr(e.target.value)}
          rows={8}
          className="form-input w-full text-sm"
          placeholder={tr('النص العربي', 'Arabic text')}
        />
        <textarea
          dir="ltr"
          value={bodyEn}
          onChange={(e) => setBodyEn(e.target.value)}
          rows={8}
          className="form-input w-full text-sm"
          placeholder={tr('النص الإنجليزي', 'English text')}
        />
      </div>

      {/* Cleaning grid */}
      {cleaning.length > 0 && (
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-bold text-charcoal/60">
            {tr('الصور (بعد إزالة النص)', 'Photos (text removed)')}
          </label>
          {!inFlight && cleaning.length > 0 && (
            <button
              type="button"
              onClick={() => void redo(cleaning.map((c) => c.id))}
              className="inline-flex items-center gap-1 text-[0.7rem] font-bold text-copper hover:underline"
            >
              <RefreshCw size={12} />
              {tr('إعادة تنظيف الكل', 'Redo all')}
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {cleaning
          .slice()
          .sort((a, b) => a.image_index - b.image_index)
          .map((c) => (
            <CleaningTile key={c.id} entry={c} onRedo={() => void redo([c.id])} isAr={isAr} />
          ))}
      </div>

      {failedCount > 0 && !inFlight && (
        <p className="text-xs text-red-600 mt-2">
          {tr(
            `تعذّر تنظيف ${failedCount} صورة — يمكنك إعادة المحاولة أو المتابعة بدونها.`,
            `${failedCount} image(s) failed — redo them or continue without them.`,
          )}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 mt-5">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          {tr('إلغاء', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void approve()}
          disabled={saving || inFlight || completed.length === 0}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
          {tr('اعتماد وحفظ', 'Approve & save')}
        </Button>
      </div>
    </Shell>
  );

  async function regenText() {
    setTextError(null);
    setTextLoading(true);
    try {
      const txt = await generateListingMessageText(listingId);
      setBodyAr(txt.body_ar);
      setBodyEn(txt.body_en);
    } catch (err) {
      setTextError(err instanceof Error ? err.message : String(err));
    } finally {
      setTextLoading(false);
    }
  }
}

/* ─── Small presentational helpers ─────────────────────────────────────── */

function Shell({
  title,
  isAr,
  onClose,
  children,
}: {
  title: string;
  isAr: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir={isAr ? 'rtl' : 'ltr'}
      onClick={onClose}
    >
      <div
        className="bg-cream w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-charcoal">{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-sand/30 text-charcoal/60">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MessagePreview({ ar, en, isAr }: { ar: string; en: string; isAr: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <pre dir="rtl" className="whitespace-pre-wrap text-sm bg-white rounded-xl border border-sand/30 p-3 font-[inherit]">
        {ar || (isAr ? '—' : '—')}
      </pre>
      <pre dir="ltr" className="whitespace-pre-wrap text-sm bg-white rounded-xl border border-sand/30 p-3 font-[inherit]">
        {en || '—'}
      </pre>
    </div>
  );
}

function ErrorBox({ message, onRetry, isAr }: { message: string; onRetry: () => void; isAr: boolean }) {
  return (
    <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-xl px-3 py-2.5 text-sm mb-3">
      <AlertCircle size={16} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 break-words">{message}</div>
      <button onClick={onRetry} className="shrink-0 inline-flex items-center gap-1 text-xs font-bold hover:underline">
        <RefreshCw size={13} />
        {isAr ? 'إعادة' : 'Retry'}
      </button>
    </div>
  );
}

function CleaningTile({
  entry,
  onRedo,
  isAr,
}: {
  entry: CleaningEntry;
  onRedo: () => void;
  isAr: boolean;
}) {
  const busy = entry.status === 'queued' || entry.status === 'cleaning';
  const failed = entry.status === 'failed';
  const src = entry.output_url || entry.source_url;
  return (
    <div className="relative group">
      <img
        src={src}
        alt=""
        className={`w-full aspect-square object-cover rounded-lg border border-sand/30 ${busy ? 'opacity-40' : ''}`}
      />
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-copper" />
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-50/80 rounded-lg text-center p-1">
          <AlertCircle size={16} className="text-red-600" />
          <span className="text-[0.6rem] text-red-700 mt-0.5">{isAr ? 'فشل' : 'Failed'}</span>
        </div>
      )}
      {!busy && (
        <button
          onClick={onRedo}
          title={isAr ? 'إعادة تنظيف' : 'Redo'}
          className="absolute top-1 end-1 p-1 rounded-md bg-white/90 text-charcoal/70 hover:text-copper shadow opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <RefreshCw size={13} />
        </button>
      )}
    </div>
  );
}
