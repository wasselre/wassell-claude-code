/**
 * Seeing and playing an asset, and reading what the analyser found in it.
 *
 * Everything here already existed in the database and was invisible:
 * mkt_raw_assets carries `ai_description`, `transcript` and `ocr_text`, and the
 * background worker fills them — but nothing rendered them, so they were
 * searchable and unreadable. You could FIND a video by a phrase in its
 * transcript and then had no way to read the transcript.
 *
 * The same was true of the media itself. The library showed a 36px thumbnail
 * for images and a file-type ICON for video, so the one question you actually
 * ask a media library — what does this look like, what does it say — could not
 * be answered without downloading the file.
 *
 * SIGNED URLS EXPIRE. wassel-files is private and VIEW_URL_TTL_SECONDS is five
 * minutes, which is shorter than plenty of the videos in here (the first real
 * one is 4m26s). A player that signs once and never again fails the moment
 * somebody pauses, or seeks after the URL has aged out — and it fails as a
 * silent black rectangle. So `useSignedMedia` re-signs on error and the player
 * restores the playhead, which makes expiry invisible instead of mysterious.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Film, Music, FileText, Image as ImageIcon, X, Download, Sparkles, AlertTriangle,
} from 'lucide-react';
import { signViewUrl, signDownloadUrl } from '@/lib/files/client';
import { fmtDate } from '@/pages/MarketingIntelligence/components/shared';

/** The columns this component reads. A loose shape because both callers hand it
 *  a raw `mkt_raw_assets` row. */
export interface AssetRow {
  id?: string;
  asset_name?: string | null;
  asset_type?: string | null;
  asset_class?: string | null;
  file_id?: string | null;
  mime_type?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  size_bytes?: number | null;
  orientation?: string | null;
  recorded_at?: string | null;
  location?: string | null;
  subject?: string | null;
  people?: string[] | null;
  tags?: string[] | null;
  usage_rights?: string | null;
  rights_expires_at?: string | null;
  processing_status?: string | null;
  processing_error?: string | null;
  ai_description?: string | null;
  transcript?: string | null;
  ocr_text?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}

export const isImage = (m?: string | null) => (m ?? '').startsWith('image/');
export const isVideo = (m?: string | null) => (m ?? '').startsWith('video/');
export const isAudio = (m?: string | null) => (m ?? '').startsWith('audio/');

/** Signs a view URL and hands back a `resign` the player calls when the media
 *  element errors — which is what an expired URL looks like from the DOM. */
function useSignedMedia(fileId: string | null | undefined, enabled = true) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sign = useCallback(async () => {
    if (!fileId) return null;
    setLoading(true); setError(null);
    try {
      const r = await signViewUrl(fileId);
      setUrl(r.url);
      return r.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally { setLoading(false); }
  }, [fileId]);

  useEffect(() => {
    if (!fileId || !enabled) return;
    let cancelled = false;
    void sign().then((u) => { if (cancelled && u) setUrl(null); });
    return () => { cancelled = true; };
  }, [fileId, enabled, sign]);

  return { url, error, loading, resign: sign };
}

const fmtDuration = (ms?: number | null) => {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (b?: number | null) =>
  !b ? null : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

// ── the thumbnail ──────────────────────────────────────────────────────────
/** A small square. Images render themselves; video and audio get an icon,
 *  because a poster frame would need a thumbnail the pipeline does not
 *  generate yet and a fake one would be a lie about what is in the file. */
export function AssetThumb({ asset, size = 'sm', onClick, isAr }: {
  asset: AssetRow; size?: 'sm' | 'lg'; onClick?: () => void; isAr: boolean;
}) {
  const img = isImage(asset.mime_type);
  const { url } = useSignedMedia(asset.file_id, img);
  const [broke, setBroke] = useState(false);
  const box = size === 'lg' ? 'h-16 w-16' : 'h-9 w-9';

  const Icon = isVideo(asset.mime_type) ? Film
    : isAudio(asset.mime_type) ? Music
    : img ? ImageIcon : FileText;

  if (!asset.file_id) {
    return (
      <span title={isAr ? 'سجل بلا ملف' : 'record with no file'}
        className={`grid ${box} shrink-0 place-items-center rounded-lg border border-dashed border-amber-300 bg-amber-50 text-amber-600`}>
        <FileText className="h-4 w-4" />
      </span>
    );
  }

  const inner = img && url && !broke
    ? <img src={url} alt={asset.asset_name ?? ''} loading="lazy" onError={() => setBroke(true)}
        className={`${box} shrink-0 rounded-lg border border-sand/50 object-cover`} />
    : <span className={`grid ${box} shrink-0 place-items-center rounded-lg border border-sand/50 bg-cream-light text-charcoal/40`}>
        <Icon className="h-4 w-4" />
      </span>;

  if (!onClick) return inner;
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-lg hover:opacity-80"
      aria-label={isAr ? `فتح ${asset.asset_name ?? ''}` : `Open ${asset.asset_name ?? ''}`}>
      {inner}
    </button>
  );
}

// ── the player ─────────────────────────────────────────────────────────────
/** The actual media, at a size you can judge it at. Video and audio get native
 *  controls; the point is to play it, not to look at a placeholder. */
export function AssetMedia({ asset, isAr, className = '' }: {
  asset: AssetRow; isAr: boolean; className?: string;
}) {
  const { url, error, loading, resign } = useSignedMedia(asset.file_id);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const retried = useRef(false);

  /** An expired signed URL surfaces as a media error with no explanation. Sign
   *  again and put the playhead back, once — a loop would hammer the endpoint
   *  if the file is genuinely gone. */
  const onMediaError = useCallback(async () => {
    if (retried.current) return;
    retried.current = true;
    const at = mediaRef.current?.currentTime ?? 0;
    const fresh = await resign();
    if (fresh && mediaRef.current) {
      mediaRef.current.src = fresh;
      mediaRef.current.currentTime = at;
      void mediaRef.current.play().catch(() => { /* autoplay refused; the user presses play */ });
    }
  }, [resign]);

  if (!asset.file_id) {
    return (
      <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 px-3 py-6 text-center text-[12px] text-amber-800">
        {isAr ? 'هذا سجل بلا ملف — لا توجد بايتات لعرضها.'
              : 'This is a record with no file — there are no bytes to show.'}
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-4 text-[12px] text-red-700">
        {isAr ? 'تعذّر فتح الملف: ' : 'Could not open the file: '}{error}
      </div>
    );
  }
  if (loading && !url) {
    return <div className={`grid h-48 place-items-center rounded-xl border border-sand/50 bg-cream-light text-[12px] text-charcoal/45 ${className}`}>
      {isAr ? 'جارٍ الفتح…' : 'Opening…'}
    </div>;
  }
  if (!url) return null;

  if (isVideo(asset.mime_type)) {
    return (
      <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={url} controls
        preload="metadata" playsInline onError={onMediaError}
        className={`max-h-[70vh] w-full rounded-xl border border-sand/50 bg-black ${className}`} />
    );
  }
  if (isAudio(asset.mime_type)) {
    return <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={url} controls
      onError={onMediaError} className={`w-full ${className}`} />;
  }
  if (isImage(asset.mime_type)) {
    return <img src={url} alt={asset.asset_name ?? ''}
      className={`max-h-[70vh] w-full rounded-xl border border-sand/50 object-contain ${className}`} />;
  }
  // A document or something with no inline renderer. Say so and offer the file.
  return (
    <div className={`rounded-xl border border-sand/50 bg-cream-light px-3 py-6 text-center ${className}`}>
      <FileText className="mx-auto h-6 w-6 text-charcoal/30" />
      <p className="mt-1 text-[12px] text-charcoal/60">
        {isAr ? 'لا يمكن عرض هذا النوع داخل الصفحة' : 'This type cannot be shown inline'}
        <span className="text-charcoal/40"> · {asset.mime_type ?? '—'}</span>
      </p>
    </div>
  );
}

// ── what the analyser found ────────────────────────────────────────────────
const PROC_LABEL: Record<string, { ar: string; en: string; tone: 'ok' | 'wait' | 'warn' }> = {
  not_attempted: { ar: 'لم يُحلَّل بعد', en: 'Not analysed yet', tone: 'wait' },
  pending:       { ar: 'في الطابور', en: 'Queued', tone: 'wait' },
  processing:    { ar: 'قيد التحليل', en: 'Analysing', tone: 'wait' },
  completed:     { ar: 'اكتمل التحليل', en: 'Analysed', tone: 'ok' },
  degraded:      { ar: 'تحليل جزئي', en: 'Partly analysed', tone: 'warn' },
  failed:        { ar: 'فشل التحليل', en: 'Analysis failed', tone: 'warn' },
  unsupported:   { ar: 'لا محلّل لهذا النوع', en: 'No analyser for this type', tone: 'warn' },
};

/** A text block the analyser produced, or an honest statement of why there is
 *  none. "Nothing here" and "nobody has looked" are different claims, and
 *  collapsing them is how an unprocessed asset reads as an empty one. */
function Found({ title, body, status, isAr, mono = false }: {
  title: string; body?: string | null; status?: string | null; isAr: boolean; mono?: boolean;
}) {
  const text = (body ?? '').trim();
  if (text) {
    return (
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-charcoal/50">{title}</div>
        <p className={`max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-sand/50 bg-white px-2.5 py-2 text-[12px] leading-relaxed text-charcoal ${
          mono ? 'font-mono text-[11.5px]' : ''}`}>
          {text}
        </p>
      </div>
    );
  }
  const s = status ?? 'not_attempted';
  const done = s === 'completed';
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-charcoal/50">{title}</div>
      <p className="rounded-lg border border-dashed border-sand/60 bg-cream-light px-2.5 py-2 text-[11.5px] text-charcoal/50">
        {done
          ? (isAr ? 'حُلِّل الملف ولم يُعثَر على شيء هنا.' : 'The file was analysed and nothing was found here.')
          : (isAr ? `لا شيء بعد — ${PROC_LABEL[s]?.ar ?? s}.` : `Nothing yet — ${(PROC_LABEL[s]?.en ?? s).toLowerCase()}.`)}
      </p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-charcoal/45">{label}</div>
      <div className="truncate text-[12px] text-charcoal">{value}</div>
    </div>
  );
}

/** The full panel: the media, its measured metadata, and everything the
 *  analyser read out of it. */
export function AssetDetail({ asset, isAr, onClose }: {
  asset: AssetRow; isAr: boolean; onClose?: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const proc = PROC_LABEL[asset.processing_status ?? 'not_attempted'];
  const video = isVideo(asset.mime_type);

  const download = async () => {
    if (!asset.file_id) return;
    setDownloading(true);
    try {
      const r = await signDownloadUrl(asset.file_id);
      window.open(r.url, '_blank', 'noopener');
    } catch { /* the button re-enables; the toast path is the caller's */ }
    finally { setDownloading(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-[13px] font-semibold text-charcoal">{asset.asset_name}</h4>
          <div className="text-[11px] text-charcoal/50">
            {asset.asset_type}
            {asset.asset_class ? ` · ${asset.asset_class}` : ''}
            {asset.mime_type ? ` · ${asset.mime_type}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {asset.file_id && (
            <button type="button" onClick={download} disabled={downloading}
              className="inline-flex items-center gap-1 text-[11.5px] text-copper hover:underline">
              <Download className="h-3.5 w-3.5" />{isAr ? 'تنزيل' : 'Download'}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} aria-label={isAr ? 'إغلاق' : 'Close'}
              className="rounded-lg p-1 text-charcoal/40 hover:bg-sand/30">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <AssetMedia asset={asset} isAr={isAr} />

      <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-sand/50 bg-white px-3 py-2.5 sm:grid-cols-4">
        <Meta label={isAr ? 'الأبعاد' : 'Dimensions'}
          value={asset.width && asset.height ? `${asset.width}×${asset.height}` : null} />
        <Meta label={isAr ? 'المدة' : 'Duration'} value={fmtDuration(asset.duration_ms)} />
        <Meta label={isAr ? 'الحجم' : 'Size'} value={fmtSize(asset.size_bytes)} />
        <Meta label={isAr ? 'الاتجاه' : 'Orientation'} value={asset.orientation} />
        <Meta label={isAr ? 'تاريخ التصوير' : 'Recorded'}
          value={asset.recorded_at ? fmtDate(asset.recorded_at, isAr) : null} />
        <Meta label={isAr ? 'الموقع' : 'Location'} value={asset.location} />
        <Meta label={isAr ? 'الموضوع' : 'Subject'} value={asset.subject} />
        <Meta label={isAr ? 'الحقوق' : 'Rights'}
          value={asset.usage_rights
            ? asset.usage_rights + (asset.rights_expires_at
                ? ` · ${isAr ? 'تنتهي' : 'until'} ${fmtDate(asset.rights_expires_at, isAr)}` : '')
            : null} />
      </div>

      {((asset.people?.length ?? 0) > 0 || (asset.tags?.length ?? 0) > 0) && (
        <div className="flex flex-wrap gap-1">
          {(asset.people ?? []).map((p) => (
            <span key={`p-${p}`} className="rounded-full border border-sand/60 bg-white px-2 py-0.5 text-[10.5px] text-charcoal/70">
              {p}
            </span>))}
          {(asset.tags ?? []).map((t) => (
            <span key={`t-${t}`} className="rounded-full bg-cream px-2 py-0.5 text-[10.5px] text-charcoal/60">
              #{t}
            </span>))}
        </div>
      )}

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-charcoal/60">
            <Sparkles className="h-3.5 w-3.5" />{isAr ? 'ما قرأه المحلّل' : 'What the analyser read'}
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-[10.5px] ${
            proc?.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : proc?.tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
            : 'border-sand/60 bg-cream-light text-charcoal/55'}`}>
            {isAr ? proc?.ar : proc?.en}
          </span>
        </div>

        {/* The failure text is shown verbatim. A degraded asset whose reason is
            hidden looks like one nobody bothered with. */}
        {asset.processing_error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{asset.processing_error}</span>
          </p>
        )}

        <Found title={isAr ? 'وصف الذكاء الاصطناعي' : 'AI description'}
          body={asset.ai_description} status={asset.processing_status} isAr={isAr} />
        {video && (
          <Found title={isAr ? 'التفريغ الصوتي' : 'Transcript'}
            body={asset.transcript} status={asset.processing_status} isAr={isAr} />
        )}
        {!video && isAudio(asset.mime_type) && (
          <Found title={isAr ? 'التفريغ الصوتي' : 'Transcript'}
            body={asset.transcript} status={asset.processing_status} isAr={isAr} />
        )}
        <Found title={isAr ? 'النص المقروء من الصورة' : 'Text read from the image'}
          body={asset.ocr_text} status={asset.processing_status} isAr={isAr} mono />
      </div>
    </div>
  );
}

/** Full-screen viewer, for when the inline size is not enough. */
export function AssetLightbox({ asset, isAr, onClose }: {
  asset: AssetRow; isAr: boolean; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-charcoal/70 p-4"
      role="dialog" aria-modal="true" onClick={onClose}>
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl bg-cream p-4"
        onClick={(e) => e.stopPropagation()}>
        <AssetDetail asset={asset} isAr={isAr} onClose={onClose} />
      </div>
    </div>
  );
}
