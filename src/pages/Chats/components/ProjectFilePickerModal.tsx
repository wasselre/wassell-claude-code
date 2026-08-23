import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, Image as ImageIcon, Video, FileText, Check, FolderOpen } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { listRecordFiles } from '@/lib/files/recordFiles';
import { signViewUrls } from '@/lib/files/client';
import { directVideoUrls } from '@/lib/matching/sendToClient';
import Button from '@/components/ui/Button';
import {
  buildPickerItems, orderSelectedRefs, type PickerGroup, type PickerItem,
} from '@/pages/Chats/lib/projectFilePicker';

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
}: {
  allProjectId: string;
  projectName: string;
  isAr: boolean;
  onConfirm: (refs: string[]) => void;
  onClose: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);
  const projectRecord = useMemo(() => {
    if (!allProjectsModel) return null;
    return (records[allProjectsModel.id] ?? []).find((r) => r.id === allProjectId) ?? null;
  }, [allProjectsModel, records, allProjectId]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PickerItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
        const entries = await listRecordFiles(allProjectsModel.id, allProjectId);
        const videoUrls = directVideoUrls((projectRecord?.data as Record<string, unknown> | undefined)?.project_videos);
        const fileItems = buildPickerItems(entries, videoUrls);

        // Sign thumbnails for image files (best-effort — icon fallback on fail).
        const imageIds = fileItems.filter((it) => it.group === 'photo' && !it.isUrl).map((it) => it.ref);
        let thumbs: Record<string, string> = {};
        if (imageIds.length > 0) {
          try {
            thumbs = await signViewUrls(imageIds);
          } catch {
            thumbs = {}; // non-fatal — tiles fall back to the image icon
          }
        }
        const withThumbs = fileItems.map((it) => (thumbs[it.ref] ? { ...it, thumb: thumbs[it.ref] } : it));

        if (cancelled) return;
        setItems(withThumbs);
        setSelected(new Set(withThumbs.map((it) => it.ref))); // everything pre-checked
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

  // Send order matches today's behaviour: photos, then videos, then documents.
  const orderedSelectedRefs = useMemo(() => orderSelectedRefs(items, selected), [items, selected]);

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
                          <button
                            key={it.ref}
                            type="button"
                            onClick={() => toggle(it.ref)}
                            className={`relative flex flex-col rounded-lg border text-start overflow-hidden transition-colors ${
                              on ? 'border-copper ring-1 ring-copper/40 bg-copper/5' : 'border-sand/40 hover:border-sand'
                            }`}
                            aria-pressed={on}
                          >
                            {/* Checkbox badge */}
                            <span
                              className={`absolute top-1.5 ${isAr ? 'start-1.5' : 'end-1.5'} z-10 w-5 h-5 rounded-md flex items-center justify-center shadow-sm ${
                                on ? 'bg-copper text-white' : 'bg-white/90 text-transparent border border-sand'
                              }`}
                            >
                              <Check size={13} />
                            </span>
                            {/* Preview */}
                            <div className="w-full h-24 bg-charcoal/5 flex items-center justify-center">
                              {it.group === 'photo' && it.thumb ? (
                                <img src={it.thumb} alt={it.name} className="w-full h-full object-cover" />
                              ) : it.group === 'photo' ? (
                                <ImageIcon size={24} className="text-charcoal/40" />
                              ) : it.group === 'video' ? (
                                <Video size={24} className="text-charcoal/40" />
                              ) : (
                                <FileText size={24} className="text-charcoal/40" />
                              )}
                            </div>
                            <div className="px-2 py-1.5">
                              <div className="text-[11px] text-charcoal/70 truncate" title={it.name}>{it.name}</div>
                              {it.isUrl && <div className="text-[9px] text-charcoal/40">{L('رابط فيديو', 'video link')}</div>}
                            </div>
                          </button>
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
              {selectedCount > 0 ? L(`متابعة (${selectedCount})`, `Continue (${selectedCount})`) : L('متابعة بدون ملفات', 'Continue with no files')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
