import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  applyCleanedToListing,
  generateListingMessageText,
  isCleaningInFlight,
  redoListingClean,
  type CleaningEntry,
} from '@/lib/listingMessage/client';
import { uploadImage } from '@/lib/imageUpload';
import {
  ensureListingMessageJob,
  getListingJobState,
  subscribeListingJob,
  retryListingText,
  resumeListingPolling,
  setListingJobBodies,
  clearListingJob,
} from '@/lib/listingMessage/jobRunner';

interface Props {
  listingId: string;
  listingTitle: string;
  chatTemplatesModelId: string;
  /** An existing 'ready' template for this listing, if one was found (reuse-first). */
  existing: AppRecord | null;
  onClose: () => void;
}

/** One entry of a saved template's data.images[] (cleaned or manually added). */
interface TemplateImage {
  asset_id?: string | null;
  public_url?: string | null;
  source_url?: string | null;
  image_index: number;
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

  // ── existing-mode "rewrite text only" state ──────────────────────────
  // Regenerates ONLY body_ar/body_en on the saved template — the cleaned
  // images and the listing photos are never touched (unlike «إعادة الإنشاء»,
  // which re-runs the whole pipeline including photo cleaning).
  const [rewriting, setRewriting] = useState(false);
  const [rewritten, setRewritten] = useState(false);
  const [exAr, setExAr] = useState('');
  const [exEn, setExEn] = useState('');
  const [savingText, setSavingText] = useState(false);

  // ── existing-mode image management ───────────────────────────────────
  // Remove tiles / add manual uploads on the SAVED template. Removal only
  // drops the array entry — storage bytes are never deleted (cleaned outputs
  // are also referenced by the listing's applied photos). Adds upload to
  // marketing-assets/listing-manual (public URL — same render+send path as
  // cleaned photos). Nothing persists until «حفظ التعديلات».
  const [exImagesState, setExImagesState] = useState<TemplateImage[]>(() =>
    Array.isArray((existing?.data as Record<string, unknown> | undefined)?.images)
      ? (((existing!.data as Record<string, unknown>).images as TemplateImage[]).filter(
          (im) => im && typeof im === 'object',
        ) as TemplateImage[])
      : [],
  );
  const [imagesDirty, setImagesDirty] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const removeTemplateImage = (idx: number) => {
    setExImagesState((arr) => arr.filter((_, i) => i !== idx));
    setImagesDirty(true);
  };

  const addTemplateImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    setUploadingCount(list.length);
    try {
      for (const file of list) {
        const url = await uploadImage(file, 'listing-manual');
        setExImagesState((arr) => [
          ...arr,
          {
            asset_id: null,
            public_url: url,
            source_url: null,
            image_index: arr.reduce((m, im) => Math.max(m, im.image_index ?? 0), -1) + 1,
          },
        ]);
        setImagesDirty(true);
        setUploadingCount((n) => n - 1);
      }
    } catch (err) {
      setUploadingCount(0);
      addToast(
        tr('تعذّر رفع الصورة: ', 'Image upload failed: ') +
          (err instanceof Error ? err.message : String(err)),
        'error',
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const rewriteTextOnly = async () => {
    setRewriting(true);
    try {
      const text = await generateListingMessageText(listingId);
      setExAr(text.body_ar);
      setExEn(text.body_en);
      setRewritten(true);
    } catch (err) {
      addToast(
        tr('تعذّرت إعادة كتابة الرسالة: ', 'Could not rewrite the message: ') +
          (err instanceof Error ? err.message : String(err)),
        'error',
      );
    } finally {
      setRewriting(false);
    }
  };

  const saveTemplateEdits = async () => {
    if (!existing) return;
    setSavingText(true);
    try {
      const rec: AppRecord = {
        ...existing,
        data: {
          ...(existing.data ?? {}),
          ...(rewritten ? { body_ar: exAr, body_en: exEn } : {}),
          ...(imagesDirty ? { images: exImagesState } : {}),
        },
        updated_at: new Date().toISOString(),
      };
      const result = await saveRecord(rec);
      if (result.status !== 'saved') {
        setSavingText(false);
        return; // store already toasted the conflict / failure
      }
      addToast(tr('تم حفظ تعديلات الرسالة', 'Message changes saved'), 'success');
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
      setSavingText(false);
    }
  };

  // ── generating-mode state ────────────────────────────────────────────
  // The WORK lives in the job runner (src/lib/listingMessage/jobRunner) — it
  // keeps running when this modal closes and shows in the Job Center. The
  // modal is a viewer/editor bound to that shared state.
  const [, setJobTick] = useState(0);
  useEffect(() => subscribeListingJob(listingId, () => setJobTick((n) => n + 1)), [listingId]);

  // Start (or attach to) the job when entering generating mode.
  useEffect(() => {
    if (mode !== 'generating') return;
    ensureListingMessageJob(listingId, isAr ? `رسالة الإعلان ${listingTitle}` : `Listing message ${listingTitle}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, listingId]);

  const jobState = getListingJobState(listingId);
  const recordId = jobState?.recordId ?? null;
  const startError = jobState?.startError ?? null;
  const textLoading = jobState?.textLoading ?? false;
  const textError = jobState?.textError ?? null;
  const cleaning = jobState?.cleaning ?? [];

  // Local editable copies — seeded from the runner until the user types, then
  // the user's edits win (and sync back so a re-open shows them).
  const [name, setName] = useState(listingTitle);
  const [bodyAr, setBodyAr] = useState(jobState?.bodyAr ?? '');
  const [bodyEn, setBodyEn] = useState(jobState?.bodyEn ?? '');
  const [saving, setSaving] = useState(false);
  const touchedRef = useRef(false);
  useEffect(() => {
    if (touchedRef.current) return;
    if (jobState && (jobState.bodyAr || jobState.bodyEn)) {
      setBodyAr(jobState.bodyAr);
      setBodyEn(jobState.bodyEn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobState?.bodyAr, jobState?.bodyEn]);

  const editBodies = (ar: string, en: string) => {
    touchedRef.current = true;
    setBodyAr(ar);
    setBodyEn(en);
    setListingJobBodies(listingId, ar, en);
  };

  const runGeneration = () => {
    // Fatal start failure → drop the dead job state and start fresh.
    clearListingJob(listingId);
    ensureListingMessageJob(listingId, isAr ? `رسالة الإعلان ${listingTitle}` : `Listing message ${listingTitle}`);
  };

  const inFlight = isCleaningInFlight(cleaning);
  const completed = cleaning.filter((c) => c.status === 'completed');
  const failedCount = cleaning.filter((c) => c.status === 'failed').length;

  const redo = async (entryIds: string[]) => {
    if (!recordId || entryIds.length === 0) return;
    try {
      await redoListingClean(recordId, entryIds);
      resumeListingPolling(listingId);
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
        category: 'project',
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
      // Replace the LISTING's photos with the cleaned (text-removed) versions
      // (server-side; backs up the originals). Non-blocking: a failure here still
      // keeps the saved message — surface it but continue.
      if (completed.length > 0) {
        try {
          await applyCleanedToListing(recordId, listingId);
        } catch (err) {
          addToast(
            tr('تعذّر تحديث صور الإعلان: ', 'Could not update the listing photos: ') +
              (err instanceof Error ? err.message : String(err)),
            'error',
          );
        }
      }
      // One current message per listing: drop any OTHER template (old 'ready' or
      // stray draft) for this same listing.
      const siblings = (records[chatTemplatesModelId] ?? []).filter(
        (r) => r.id !== recordId && (r.data as Record<string, unknown>)?.listing_id === listingId,
      );
      for (const s of siblings) deleteRecord(chatTemplatesModelId, s.id);
      clearListingJob(listingId);
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
    const hasEdits = rewritten || imagesDirty;
    return (
      <Shell onClose={onClose} title={tr('رسالة الإعلان', 'Listing message')} isAr={isAr}>
        <p className="text-xs text-charcoal/50 mb-3">
          {tr(
            'يوجد بالفعل رسالة محفوظة لهذا الإعلان. يمكنك استخدامها، أو إعادة كتابة النص فقط، أو إعادة إنشائها بالكامل.',
            'A saved message already exists for this listing. Use it, rewrite just the text, or regenerate everything.',
          )}
        </p>
        {rewritten ? (
          <>
            <p className="text-xs text-copper mb-2">
              {tr(
                'نص جديد — راجِعه وعدِّله ثم احفظ. الصور لن تتغيّر.',
                'New text — review/edit it, then save. The images will not change.',
              )}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <textarea
                dir="rtl"
                value={exAr}
                onChange={(e) => setExAr(e.target.value)}
                rows={8}
                className="form-input w-full text-sm"
              />
              <textarea
                dir="ltr"
                value={exEn}
                onChange={(e) => setExEn(e.target.value)}
                rows={8}
                className="form-input w-full text-sm"
              />
            </div>
          </>
        ) : (
          <MessagePreview ar={(d.body_ar as string) ?? ''} en={(d.body_en as string) ?? ''} isAr={isAr} />
        )}
        {/* Image management: remove tiles / add manual uploads */}
        <div className="flex items-center justify-between mt-3 mb-1">
          <label className="block text-xs font-bold text-charcoal/60">{tr('الصور', 'Images')}</label>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingCount > 0 || savingText}
            className="inline-flex items-center gap-1 text-[0.7rem] font-bold text-copper hover:underline disabled:opacity-40"
          >
            {uploadingCount > 0 ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
            {uploadingCount > 0
              ? tr(`جارٍ رفع ${uploadingCount} صورة…`, `Uploading ${uploadingCount} image(s)…`)
              : tr('إضافة صور', 'Add images')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void addTemplateImages(e.target.files)}
          />
        </div>
        {exImagesState.length > 0 ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {exImagesState.map((im, i) =>
              im.public_url ? (
                <div key={`${im.public_url}-${i}`} className="relative group">
                  <img
                    src={im.public_url}
                    alt=""
                    className="w-full aspect-square object-cover rounded-lg border border-sand/30"
                  />
                  <button
                    type="button"
                    onClick={() => removeTemplateImage(i)}
                    title={tr('إزالة الصورة', 'Remove image')}
                    className="absolute top-1 end-1 p-1 rounded-md bg-white/90 text-charcoal/70 hover:text-red-600 shadow opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ) : null,
            )}
          </div>
        ) : (
          <p className="text-xs text-charcoal/40">{tr('لا توجد صور في هذه الرسالة.', 'No images on this message.')}</p>
        )}
        <div className="flex items-center justify-end gap-2 mt-5 flex-wrap">
          <Button variant="secondary" onClick={onClose} disabled={savingText}>
            {tr('إغلاق', 'Close')}
          </Button>
          <Button variant="secondary" onClick={() => void rewriteTextOnly()} disabled={rewriting || savingText}>
            {rewriting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {rewritten ? tr('إعادة كتابة مرة أخرى', 'Rewrite again') : tr('إعادة كتابة الرسالة فقط', 'Rewrite text only')}
          </Button>
          {hasEdits ? (
            <Button
              variant="primary"
              onClick={() => void saveTemplateEdits()}
              disabled={rewriting || savingText || uploadingCount > 0}
            >
              {savingText ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              {tr('حفظ التعديلات', 'Save changes')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setMode('generating')} disabled={rewriting || savingText}>
              <RefreshCw size={16} />
              {tr('إعادة الإنشاء بالكامل', 'Regenerate everything')}
            </Button>
          )}
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
          onChange={(e) => editBodies(e.target.value, bodyEn)}
          rows={8}
          className="form-input w-full text-sm"
          placeholder={tr('النص العربي', 'Arabic text')}
        />
        <textarea
          dir="ltr"
          value={bodyEn}
          onChange={(e) => editBodies(bodyAr, e.target.value)}
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
      <div className="flex items-center justify-between gap-2 mt-5">
        <p className="text-[0.7rem] text-charcoal/45 flex-1">
          {(inFlight || textLoading) &&
            tr(
              'يمكنك إغلاق النافذة — العمل يستمر في الخلفية وستصلك إشعارات من مؤشر المهام.',
              'You can close this window — the work continues in the background (see the jobs indicator).',
            )}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {tr('إغلاق', 'Close')}
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
      </div>
    </Shell>
  );

  function regenText() {
    touchedRef.current = false; // let the fresh AI text re-seed the editors
    retryListingText(listingId);
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
