import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { X, Loader2, Image as ImageIcon, Video, FileText, Check, FolderOpen, Play, Eye, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { listSendableProjectFiles } from '@/lib/files/recordFiles';
import { signThumbUrls, signViewUrl } from '@/lib/files/client';
import Button from '@/components/ui/Button';
import {
  buildPickerItems, isUnitPlanFile, orderSelectedRefs, orderSelectedRefsBulk,
  defaultBulkSelection, type PickerGroup, type PickerItem,
} from '@/pages/Chats/lib/projectFilePicker';

// pdf.js (~1 MB) loads only when a PDF is opened — keeps it out of the main bundle.
const PdfViewer = lazy(() => import('@/components/ui/PdfViewer'));

/**
 * ProjectFilePickerModal — choose which of a project's linked files get sent to
 * a customer over WhatsApp.
 *
 * Sources every file linked to the `all_projects` record via the Files
 * projection (`listRecordFiles` → field-derived gallery/main image/videos,
 * manual links, marketing-library assets, legacy attachments) AND merges the
 * project's external direct-video URLs (`project_videos` entries that are hosted
 * links rather than CRM file ids — those never enter `file_links`).
 *
 * Everything is PRE-CHECKED (the rep unchecks what not to send). Confirm returns
 * an ordered list of refs — a `files.id` for CRM files, a raw URL for external
 * videos — exactly the mixed shape `sendProjectImageMessages` already accepts
 * (photos as image messages, videos as videos, PDFs as WhatsApp documents).
 *
 * The pure grouping/merge/ordering lives in ../lib/projectFilePicker (tested).
 */

export default function ProjectFilePickerModal({
  allProjectId,
  projectName,
  isAr,
  onConfirm,
  onClose,
  preselect = 'all',
  confirmLabel,
}: {
  allProjectId: string;
  projectName: string;
  isAr: boolean;
  onConfirm: (refs: string[]) => void;
  onClose: () => void;
  /**
   * Which files start checked. `'bulk'` (both the single AND the bulk project
   * send) pre-checks the brochure + the first 3 photos (the "top 3") and returns
   * refs in text→PDF→pictures order (`orderSelectedRefsBulk`). `'all'` (the
   * default, currently unused) pre-checks everything in photo-first order — kept
   * as an explicit opt-in for any future "send the whole folder" caller.
   */
  preselect?: 'all' | 'bulk';
  /** Overrides the default "Continue" confirm-button label (e.g. "Next: message"). */
  confirmLabel?: string;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);

  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PickerItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PickerItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!allProjectsModel) {
        setError(L('نموذج المشاريع غير متوفر', 'Projects model unavailable'));
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        // Lean fetch: minimal columns, no provenance query — the picker only
        // needs to group / name / filter / thumbnail. Exclude unit-plan /
        // floor-plan files (internal drawings, and the bulk of a project's images).
        const entries = await listSendableProjectFiles(allProjectsModel.id, allProjectId);
        const sendable = entries.filter((e) => !isUnitPlanFile(e.file));
        // External hosted video LINKS (project_videos URLs) are intentionally not
        // offered here — only real CRM files (photos / videos / PDFs) are.
        const fileItems = buildPickerItems(sendable, []);

        // Sign SMALL transformed thumbnails (with a full-size fallback) for image
        // files — downloading full-resolution originals into tiles was the drag.
        const imageIds = fileItems.filter((it) => it.group === 'photo' && !it.isUrl).map((it) => it.ref);
        let thumb: Record<string, string> = {};
        let full: Record<string, string> = {};
        if (imageIds.length > 0) {
          try {
            ({ thumb, full } = await signThumbUrls(imageIds));
          } catch {
            thumb = {}; full = {}; // non-fatal — tiles fall back to the image icon
          }
        }
        const withThumbs = fileItems.map((it) =>
          thumb[it.ref] ? { ...it, thumb: thumb[it.ref], thumbFull: full[it.ref] ?? thumb[it.ref] } : it,
        );

        if (cancelled) return;
        setItems(withThumbs);
        // 'all' → everything pre-checked (single flow). 'bulk' → documents +
        // the first 3 photos (the "top 3" pre-selection the rep asked for).
        setSelected(
          preselect === 'bulk'
            ? defaultBulkSelection(withThumbs)
            : new Set(withThumbs.map((it) => it.ref)),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProjectsModel, allProjectId]);

  const groups: Array<{ key: PickerGroup; label: string; icon: typeof ImageIcon }> = [
    { key: 'photo', label: L('الصور', 'Photos'), icon: ImageIcon },
    { key: 'video', label: L('الفيديوهات', 'Videos'), icon: Video },
    { key: 'document', label: L('المستندات و PDF', 'Documents & PDFs'), icon: FileText },
  ];

  const toggle = (ref: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  const groupItems = (g: PickerGroup) => items.filter((it) => it.group === g);
  const setGroup = (g: PickerGroup, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const it of groupItems(g)) {
        if (on) next.add(it.ref);
        else next.delete(it.ref);
      }
      return next;
    });

  // Send order. 'all' (single flow) keeps today's photos→videos→documents order;
  // 'bulk' returns documents→photos→videos so the send reads text→PDF→pictures.
  const orderedSelectedRefs = useMemo(
    () => (preselect === 'bulk' ? orderSelectedRefsBulk(items, selected) : orderSelectedRefs(items, selected)),
    [items, selected, preselect],
  );

  const selectedCount = orderedSelectedRefs.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]" dir={isAr ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <FolderOpen size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-chocolate truncate">{L('اختر الملفات للإرسال', 'Choose files to send')}</h2>
            <p className="text-xs text-charcoal/50 truncate">{projectName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors" aria-label={L('إغلاق', 'Close')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-charcoal/50 text-sm">
              <Loader2 size={16} className="animate-spin" /> {L('جارٍ تحميل ملفات المشروع…', 'Loading project files…')}
            </div>
          ) : error ? (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 my-4">{error}</div>
          ) : items.length === 0 ? (
            <p className="text-sm text-charcoal/40 py-12 text-center">{L('لا توجد ملفات مرتبطة بهذا المشروع', 'No files linked to this project')}</p>
          ) : (
            <div className="space-y-5">
              {groups.map(({ key, label, icon: Icon }) => {
                const its = groupItems(key);
                if (its.length === 0) return null;
                const allOn = its.every((it) => selected.has(it.ref));
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 text-xs font-bold text-charcoal/60 uppercase tracking-wide">
                        <Icon size={14} className="text-copper" />
                        {label}
                        <span className="text-charcoal/40 font-normal normal-case">({its.length})</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setGroup(key, !allOn)}
                        className="text-[11px] font-medium text-copper hover:text-terracotta"
                      >
                        {allOn ? L('إلغاء تحديد الكل', 'Clear all') : L('تحديد الكل', 'Select all')}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {its.map((it) => {
                        const on = selected.has(it.ref);
                        return (
                          <div
                            key={it.ref}
                            className={`relative flex flex-col rounded-lg border overflow-hidden transition-colors ${
                              on ? 'border-copper ring-1 ring-copper/40 bg-copper/5' : 'border-sand/40 hover:border-sand'
                            }`}
                          >
                            {/* Checkbox badge — toggles selection only. */}
                            <button
                              type="button"
                              onClick={() => toggle(it.ref)}
                              aria-pressed={on}
                              aria-label={on ? L('إلغاء التحديد', 'Deselect') : L('تحديد', 'Select')}
                              className={`absolute top-1.5 ${isAr ? 'start-1.5' : 'end-1.5'} z-10 w-6 h-6 rounded-md flex items-center justify-center shadow-sm transition-colors ${
                                on ? 'bg-copper text-white' : 'bg-white/90 text-transparent border border-sand hover:border-copper'
                              }`}
                            >
                              <Check size={14} />
                            </button>
                            {/* Preview area — click to OPEN/VIEW the file. */}
                            <button
                              type="button"
                              onClick={() => setPreview(it)}
                              className="group w-full text-start"
                              title={L('عرض', 'View')}
                            >
                              <div className="relative w-full h-24 bg-charcoal/5 flex items-center justify-center">
                                {it.group === 'photo' && it.thumb ? (
                                  <img
                                    src={it.thumb}
                                    alt={it.name}
                                    loading="lazy"
                                    decoding="async"
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      // Transformed thumb failed (e.g. image
                                      // transformation not enabled) → full-size URL.
                                      const img = e.currentTarget;
                                      if (it.thumbFull && img.src !== it.thumbFull) img.src = it.thumbFull;
                                    }}
                                  />
                                ) : it.group === 'photo' ? (
                                  <ImageIcon size={24} className="text-charcoal/40" />
                                ) : it.group === 'video' ? (
                                  <Video size={24} className="text-charcoal/40" />
                                ) : (
                                  <FileText size={24} className="text-charcoal/40" />
                                )}
                                {/* View overlay hint */}
                                <div className="absolute inset-0 flex items-center justify-center bg-charcoal/0 group-hover:bg-charcoal/30 transition-colors">
                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity w-9 h-9 rounded-full bg-white/90 text-charcoal flex items-center justify-center shadow">
                                    {it.group === 'video' ? <Play size={16} className="ms-0.5" fill="currentColor" /> : <Eye size={16} />}
                                  </span>
                                </div>
                              </div>
                              <div className="px-2 py-1.5">
                                <div className="text-[11px] text-charcoal/70 truncate" title={it.name}>{it.name}</div>
                                {it.isUrl && <div className="text-[9px] text-charcoal/40">{L('رابط فيديو', 'video link')}</div>}
                              </div>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-sand/20 shrink-0">
          <span className="text-sm text-charcoal/60">
            {selectedCount > 0
              ? L(`${selectedCount} ملف محدد`, `${selectedCount} file${selectedCount === 1 ? '' : 's'} selected`)
              : L('لن تُرسل أي ملفات', 'No files will be sent')}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>{L('إلغاء', 'Cancel')}</Button>
            <Button variant="primary" onClick={() => onConfirm(orderedSelectedRefs)} disabled={loading}>
              <Check size={14} />
              {confirmLabel
                ? (selectedCount > 0 ? `${confirmLabel} (${selectedCount})` : confirmLabel)
                : selectedCount > 0 ? L(`متابعة (${selectedCount})`, `Continue (${selectedCount})`) : L('متابعة بدون ملفات', 'Continue with no files')}
            </Button>
          </div>
        </div>
      </div>

      {/* Preview lightbox — plays videos, shows images, opens PDFs/documents. */}
      {preview && (
        <FilePreviewLightbox item={preview} isAr={isAr} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/**
 * Full-screen preview of one picker item. Resolves a viewable URL on open — a
 * signed URL for a private CRM file, or the raw URL for an external video — then
 * renders it by kind: image inline, video with controls, PDF/doc in a frame with
 * an "open in new tab" fallback.
 */
function FilePreviewLightbox({
  item,
  isAr,
  onClose,
}: {
  item: PickerItem;
  isAr: boolean;
  onClose: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [url, setUrl] = useState<string | null>(item.isUrl ? item.ref : null);
  const [mime, setMime] = useState<string>('');
  const [loading, setLoading] = useState(!item.isUrl);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (item.isUrl) return; // external URL is already viewable
    let cancelled = false;
    setLoading(true);
    setErr(null);
    signViewUrl(item.ref)
      .then((r) => { if (!cancelled) { setUrl(r.url); setMime(r.mime_type || ''); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Route to the in-app viewer whenever we have ANY signal it's a PDF — the
  // file's own kind (most reliable), its signed mime, or a .pdf name. A blank
  // mime + a title-only name must NOT fall through to the browser's plugin.
  const isPdf = item.kind === 'pdf' || mime.includes('pdf') || /\.pdf($|\?)/i.test(item.name);

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 end-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
        aria-label={L('إغلاق', 'Close')}
      >
        <X size={20} />
      </button>

      <div className="max-w-[92vw] max-h-[86vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <div className="flex items-center gap-2 text-white/80 text-sm py-10">
            <Loader2 size={18} className="animate-spin" /> {L('جارٍ التحميل…', 'Loading…')}
          </div>
        ) : err ? (
          <div className="text-sm text-white bg-red-600/80 rounded-lg px-4 py-3 max-w-md text-center">{err}</div>
        ) : !url ? (
          <div className="text-sm text-white/70 py-10">{L('تعذّر فتح الملف', 'Could not open the file')}</div>
        ) : item.group === 'photo' ? (
          <img src={url} alt={item.name} className="max-w-[92vw] max-h-[80vh] object-contain rounded-lg" />
        ) : item.group === 'video' ? (
          <video src={url} controls autoPlay playsInline className="max-w-[92vw] max-h-[80vh] rounded-lg bg-black" />
        ) : isPdf ? (
          <div className="w-[92vw] max-w-5xl h-[82vh] rounded-lg overflow-hidden">
            <Suspense fallback={(
              <div className="flex items-center justify-center gap-2 text-white/80 text-sm h-full">
                <Loader2 size={18} className="animate-spin" /> {L('جارٍ تحميل عارض PDF…', 'Loading PDF viewer…')}
              </div>
            )}>
              <PdfViewer url={url} isAr={isAr} />
            </Suspense>
          </div>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-white text-charcoal rounded-lg px-5 py-3 text-sm font-medium hover:bg-cream"
          >
            <ExternalLink size={16} /> {L('فتح الملف في نافذة جديدة', 'Open the file in a new tab')}
          </a>
        )}
        <div className="text-white/70 text-xs truncate max-w-[92vw]" dir="auto">{item.name}</div>
      </div>
    </div>
  );
}
