import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, ExternalLink, Loader2, Pencil, RefreshCw, Share2, Shield, X, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { FileRow } from '@/types';
import {
  isOfficePreviewMime,
  renameFile,
  requestOfficePreview,
  signDownloadUrl,
  signViewUrl,
} from '@/lib/files/client';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindIcon, kindLabel } from '@/lib/files/format';

interface Props {
  file: FileRow | null;
  open: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  onShare: (f: FileRow) => void;
  onPermissions: (f: FileRow) => void;
  onDelete: (f: FileRow) => void;
  /** Called after a successful rename so callers can refresh their lists. */
  onRenamed?: (file: FileRow) => void;
}

/**
 * Full-screen file viewer. Branches by MIME:
 *   image/*           → <img> lightbox
 *   application/pdf   → <iframe> (browsers render PDFs natively)
 *   video/*           → <video controls>
 *   audio/*           → <audio controls>
 *   else              → metadata card + Download button
 */
export default function FilePreviewModal({
  file,
  open,
  canEdit,
  canDelete,
  onClose,
  onShare,
  onPermissions,
  onDelete,
  onRenamed,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Local override for the displayed name so a successful rename is visible
   *  immediately without waiting for the parent to refresh the FileRow. */
  const [displayName, setDisplayName] = useState<string>('');
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    if (!open || !file) {
      setUrl(null);
      setRenaming(false);
      return;
    }
    let cancelled = false;
    setDisplayName(file.original_name);
    // Office documents render through the converted-PDF pipeline (OfficePreview
    // owns its own URL lifecycle) — signing the original here would be a
    // wasted round-trip for a URL nothing renders.
    if (isOfficePreviewMime(file.mime_type)) {
      setUrl(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void signViewUrl(file.id)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, file]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !file) return null;

  const Icon = kindIcon[file.kind];
  // Rename only changes the display name — it never breaks a record's pointer
  // (records reference files by id, not name) — so it's safe to expose wherever
  // the user owns the file, even in record-field previews that pass
  // canEdit=false to hide share/permissions/delete. Owner check mirrors the
  // Files-page logic; the server's RLS is still the authoritative gate.
  const ownsFile = !!currentUserId && file.uploaded_by_user_id === currentUserId;
  const showRename = canEdit || ownsFile;

  const handleDownload = async () => {
    try {
      const res = await signDownloadUrl(file.id);
      window.location.href = res.url;
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleStartRename = () => {
    setRenameDraft(displayName || file.original_name);
    setRenaming(true);
  };

  const handleCommitRename = async () => {
    const next = renameDraft.trim();
    if (!next || next === (displayName || file.original_name)) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    try {
      const updated = await renameFile(file.id, next);
      setDisplayName(updated.original_name);
      setRenaming(false);
      onRenamed?.(updated);
    } catch {
      /* surfaceError already toasted */
    } finally {
      setRenameBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-charcoal/80 backdrop-blur-sm flex flex-col" onClick={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-charcoal/90 text-white gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Icon size={20} className="text-white/80 shrink-0" />
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCommitRename();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  disabled={renameBusy}
                  dir="auto"
                  className="flex-1 min-w-0 bg-white/10 border border-white/20 rounded-md px-2 py-1 text-sm font-bold text-white placeholder-white/40 focus:outline-none focus:border-copper"
                />
                <HeaderBtn
                  icon={Check}
                  label={t('common.save')}
                  onClick={() => void handleCommitRename()}
                />
                <HeaderBtn
                  icon={X}
                  label={t('common.cancel')}
                  onClick={() => setRenaming(false)}
                />
              </div>
            ) : (
              <div className="font-bold truncate" title={displayName || file.original_name}>
                {displayName || file.original_name}
              </div>
            )}
            <div className="text-xs text-white/50">
              {kindLabel(file.kind, isAr)} · {formatBytes(file.size_bytes, isAr)}
            </div>
          </div>
        </div>
        {!renaming && (
          <div className="flex items-center gap-1">
            <HeaderBtn icon={Download} label={t('files.actions.download')} onClick={handleDownload} />
            {showRename && (
              <HeaderBtn icon={Pencil} label={t('files.actions.rename')} onClick={handleStartRename} />
            )}
            {canEdit && (
              <>
                <HeaderBtn icon={Share2} label={t('files.actions.share')} onClick={() => onShare(file)} />
                <HeaderBtn icon={Shield} label={t('files.actions.permissions')} onClick={() => onPermissions(file)} />
              </>
            )}
            {canDelete && (
              <HeaderBtn icon={Trash2} label={t('files.actions.delete')} danger onClick={() => onDelete(file)} />
            )}
            <HeaderBtn icon={X} label={t('common.close')} onClick={onClose} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex items-center justify-center overflow-auto" onClick={(e) => e.stopPropagation()}>
        {isOfficePreviewMime(file.mime_type) ? (
          <OfficePreview file={file} onDownload={handleDownload} />
        ) : (
          <>
            {loading && <Loader2 size={32} className="animate-spin text-white/70" />}
            {!loading && url && <PreviewBody file={file} url={url} onDownload={handleDownload} />}
            {!loading && !url && <div className="text-white/70">{t('files.upload.failed')}</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Office documents (DOC/DOCX/PPT/PPTX/XLS/XLSX): rendered via the cached
 * LibreOffice→PDF conversion. First open of a file kicks the conversion and
 * polls /api/files/office-preview until ready (typically a few seconds);
 * every later open is instant from cache. Failure shows a download card with
 * a Retry button — never a dead spinner.
 */
const OFFICE_POLL_MS = 2_500;
const OFFICE_POLL_TIMEOUT_MS = 150_000;

function OfficePreview({ file, onDownload }: { file: FileRow; onDownload: () => void }) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const isNarrow = useIsNarrow();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to cancel a stale poll chain when the file changes or a retry
   *  starts a fresh one. */
  const pollGenRef = useRef(0);

  const startPolling = (retry: boolean) => {
    const gen = ++pollGenRef.current;
    const startedAt = Date.now();
    setState('loading');
    setPdfUrl(null);
    setError(null);

    const tick = async (isFirst: boolean) => {
      const res = await requestOfficePreview(file.id, isFirst && retry);
      if (pollGenRef.current !== gen) return; // superseded
      if (res.status === 'ready' && res.url) {
        setPdfUrl(res.url);
        setState('ready');
        return;
      }
      if (res.status === 'failed') {
        setError(res.error ?? null);
        setState('failed');
        return;
      }
      if (Date.now() - startedAt > OFFICE_POLL_TIMEOUT_MS) {
        setError(t('files.preview.timeout'));
        setState('failed');
        return;
      }
      window.setTimeout(() => void tick(false), OFFICE_POLL_MS);
    };
    void tick(true);
  };

  useEffect(() => {
    startPolling(false);
    return () => {
      pollGenRef.current += 1; // cancel in-flight chain on unmount/file change
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  if (state === 'loading') {
    return (
      <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4 max-w-md w-full mx-4 text-center">
        <Loader2 size={40} className="animate-spin text-copper" />
        <div className="font-bold text-charcoal">{t('files.preview.preparing')}</div>
        <p className="text-charcoal/60 text-sm">{t('files.preview.preparing_hint')}</p>
      </div>
    );
  }

  if (state === 'failed') {
    const Icon = kindIcon[file.kind];
    return (
      <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4 max-w-md w-full mx-4 text-center">
        <Icon size={48} className="text-charcoal/40" />
        <div className="font-bold text-charcoal">{t('files.preview.unavailable')}</div>
        {error && <p className="text-charcoal/50 text-xs break-words max-w-full">{error}</p>}
        <div className="flex flex-col gap-2 w-full">
          <button
            onClick={() => startPolling(true)}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta transition-colors font-bold"
          >
            <RefreshCw size={16} />
            {t('files.preview.retry')}
          </button>
          <button
            onClick={onDownload}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream transition-colors font-bold"
          >
            <Download size={16} />
            {t('files.actions.download')}
          </button>
        </div>
      </div>
    );
  }

  // ready — same narrow-screen handling as the native PDF branch.
  if (isNarrow && pdfUrl) {
    const Icon = kindIcon[file.kind];
    return (
      <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4 max-w-md w-full mx-4 text-center">
        <Icon size={56} className="text-blue-600" />
        <div className="font-bold text-charcoal">{file.original_name}</div>
        <p className="text-charcoal/60 text-sm">
          {isAr
            ? 'افتح المعاينة في عارض الجهاز للحصول على كامل الصفحات والتكبير.'
            : 'Open the preview in your device viewer for full pages and zoom.'}
        </p>
        <div className="flex flex-col gap-2 w-full">
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta transition-colors font-bold"
          >
            <ExternalLink size={16} />
            {t('files.actions.preview')}
          </a>
          <button
            onClick={onDownload}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream transition-colors font-bold"
          >
            <Download size={16} />
            {t('files.actions.download')}
          </button>
        </div>
      </div>
    );
  }
  return pdfUrl ? (
    <iframe src={pdfUrl} title={file.original_name} className="w-full h-full bg-white" />
  ) : null;
}

/** Phone-or-narrow detector — see PublicShareFilePage for rationale.
 *  Mobile browsers don't render multi-page PDFs in <iframe>. */
function useIsNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

function PreviewBody({ file, url, onDownload }: { file: FileRow; url: string; onDownload: () => void }) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const isNarrow = useIsNarrow();
  const Icon = kindIcon[file.kind];

  if (file.kind === 'image') {
    return (
      <img src={url} alt={file.original_name} className="max-w-full max-h-[85vh] object-contain shadow-2xl" />
    );
  }
  if (file.kind === 'pdf') {
    if (isNarrow) {
      return (
        <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4 max-w-md w-full mx-4 text-center">
          <Icon size={56} className="text-rose-500" />
          <div className="font-bold text-charcoal">{file.original_name}</div>
          <p className="text-charcoal/60 text-sm">
            {isAr
              ? 'افتح ملف PDF في عارض الجهاز للحصول على كامل الصفحات والتكبير.'
              : 'Open the PDF in your device viewer for full pages and zoom.'}
          </p>
          <div className="flex flex-col gap-2 w-full">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta transition-colors font-bold"
            >
              <ExternalLink size={16} />
              {isAr ? 'فتح ملف PDF' : 'Open PDF'}
            </a>
            <button
              onClick={onDownload}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream transition-colors font-bold"
            >
              <Download size={16} />
              {t('files.actions.download')}
            </button>
          </div>
        </div>
      );
    }
    return <iframe src={url} title={file.original_name} className="w-full h-full bg-white" />;
  }
  if (file.kind === 'video') {
    return (
      <video src={url} controls autoPlay className="max-w-full max-h-[85vh] shadow-2xl rounded-lg" />
    );
  }
  if (file.kind === 'audio') {
    return (
      <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4 max-w-md w-full mx-4">
        <Icon size={48} className="text-purple-500" />
        <div className="font-bold text-charcoal text-center">{file.original_name}</div>
        <audio src={url} controls autoPlay className="w-full" />
      </div>
    );
  }
  // document / archive / other → big card with download button.
  return (
    <div className="bg-white rounded-2xl p-10 shadow-xl flex flex-col items-center gap-4 max-w-md w-full mx-4">
      <Icon size={64} className="text-charcoal/40" />
      <div className="font-bold text-charcoal text-center text-lg">{file.original_name}</div>
      <button
        onClick={onDownload}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta transition-colors font-bold"
      >
        <Download size={16} />
        {t('files.actions.download')}
      </button>
    </div>
  );
}

interface HBProps {
  icon: typeof Download;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function HeaderBtn({ icon: Icon, label, onClick, danger }: HBProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`p-2 rounded-lg transition-colors ${
        danger ? 'text-red-400 hover:bg-red-500/20' : 'text-white/80 hover:bg-white/10'
      }`}
    >
      <Icon size={18} />
    </button>
  );
}
