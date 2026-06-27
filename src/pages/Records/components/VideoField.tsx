/**
 * `video` / `multi_video` field types — render a video from a link (or a
 * Drive-backed file) inline, the same way `image` / `multi_image` render a
 * picture.
 *
 * Stored value shape mirrors the image fields exactly:
 *   video        → string  (a `files.id` UUID, or an external http(s) URL)
 *   multi_video  → string[] (array of `files.id` / URLs)
 *
 * A value is playable in one of two ways, decided by `resolveVideoEmbed`:
 *   - direct media (mp4/webm/… or a signed Drive URL) → native <video controls>
 *   - YouTube / Vimeo page link                       → <iframe> embed
 *
 * The form input lets the user EITHER paste a link (the primary use case —
 * e.g. importing listing videos) OR pick an uploaded video from their Drive.
 * Both the form input and the compact table cell share the same embed
 * resolution + lightbox so behaviour is consistent.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Loader2, Play, Plus, X } from 'lucide-react';
import { signViewUrl } from '@/lib/files/client';
import DriveBrowserModal, {
  type DrivePickerResult,
} from '@/pages/Files/components/DriveBrowserModal';

/* ────────────────────────────────────────────────────────────────────────
 * Embed resolution
 * ──────────────────────────────────────────────────────────────────────── */

type VideoEmbed =
  | { kind: 'file'; src: string } // native <video> source (direct media / signed Drive URL)
  | { kind: 'embed'; src: string } // <iframe> source (YouTube / Vimeo player URL)
  | { kind: 'pending' } // a Drive files.id whose signed URL is still loading
  | { kind: 'missing' }; // empty / unresolvable

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** A non-URL, non-empty string is treated as a Drive `files.id`. */
function isFileId(value: string): boolean {
  return value.length > 0 && !isHttpUrl(value);
}

/**
 * Turn an external URL into a player embed. Recognises YouTube + Vimeo (the
 * overwhelmingly common "video link" hosts) and maps them to their iframe
 * player URL; everything else is treated as a direct media file the browser
 * can play in a native <video>.
 */
export function resolveExternalEmbed(url: string): VideoEmbed {
  const yt =
    url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt?.[1]) {
    return { kind: 'embed', src: `https://www.youtube.com/embed/${yt[1]}` };
  }
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo?.[1]) {
    return { kind: 'embed', src: `https://player.vimeo.com/video/${vimeo[1]}` };
  }
  // Cloudflare Stream — listing videos (e.g. imported from Aqar) come as HLS
  // .m3u8 manifests, which a native <video> can't play outside Safari. Map any
  // Stream customer URL to its iframe player, which handles HLS everywhere.
  const cfStream = url.match(
    /^(https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\/[\w-]+)\/(?:manifest\/[\w.]+|iframe|watch|thumbnails)/i,
  );
  if (cfStream?.[1]) {
    return { kind: 'embed', src: `${cfStream[1]}/iframe` };
  }
  return { kind: 'file', src: url };
}

/**
 * Resolve a stored value (URL or `files.id`) into a playable embed. Drive
 * file ids are signed via /api/files/sign-view-url (RLS-gated, short-lived) —
 * those start as `pending` until the signed URL arrives.
 */
function useVideoEmbed(value: string): VideoEmbed {
  const [signed, setSigned] = useState<string | null>(null);

  const needsSign = isFileId(value);
  useEffect(() => {
    if (!needsSign) {
      setSigned(null);
      return;
    }
    let cancelled = false;
    void signViewUrl(value)
      .then((res) => {
        if (!cancelled) setSigned(res.url);
      })
      .catch(() => {
        if (!cancelled) setSigned(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, needsSign]);

  return useMemo<VideoEmbed>(() => {
    if (!value) return { kind: 'missing' };
    if (isHttpUrl(value)) return resolveExternalEmbed(value);
    // Drive files.id — play the signed direct-media URL once it resolves.
    if (signed) return { kind: 'file', src: signed };
    return { kind: 'pending' };
  }, [value, signed]);
}

/* ────────────────────────────────────────────────────────────────────────
 * Players
 * ──────────────────────────────────────────────────────────────────────── */

/** Inline player used inside the form (full width) and the lightbox. */
function VideoPlayer({ embed, className }: { embed: VideoEmbed; className?: string }) {
  if (embed.kind === 'pending') {
    return (
      <div className={`flex items-center justify-center bg-charcoal/5 ${className ?? ''}`}>
        <Loader2 size={20} className="animate-spin text-charcoal/30" />
      </div>
    );
  }
  if (embed.kind === 'missing') {
    return (
      <div className={`flex items-center justify-center bg-charcoal/5 text-charcoal/30 ${className ?? ''}`}>
        <Film size={20} />
      </div>
    );
  }
  if (embed.kind === 'embed') {
    return (
      <iframe
        src={embed.src}
        className={className}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title="video"
      />
    );
  }
  return (
    <video src={embed.src} controls preload="metadata" className={className} />
  );
}

/** Full-screen lightbox shown when a thumbnail is clicked. */
function VideoLightbox({ value, onClose }: { value: string; onClose: () => void }) {
  const embed = useVideoEmbed(value);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="close"
        className="absolute top-4 end-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
      >
        <X size={20} />
      </button>
      <div
        className="w-full max-w-4xl aspect-video bg-black rounded-xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <VideoPlayer embed={embed} className="w-full h-full" />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Thumbnails
 * ──────────────────────────────────────────────────────────────────────── */

/** Small clickable poster used in the form input and (smaller) in cells. */
function VideoThumb({
  value,
  onClick,
  size = 'lg',
}: {
  value: string;
  onClick: () => void;
  size?: 'lg' | 'sm';
}) {
  const embed = useVideoEmbed(value);
  const box = size === 'lg' ? 'w-24 h-24 rounded-xl' : 'w-10 h-10 rounded';
  // For direct media we can render a real first-frame poster via <video>; for
  // iframe embeds (YouTube/Vimeo) and while-pending we fall back to a film tile.
  const showPoster = embed.kind === 'file';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`relative block ${box} overflow-hidden border border-sand/40 bg-charcoal/80 hover:opacity-90 transition-opacity cursor-zoom-in`}
    >
      {showPoster ? (
        <video
          src={embed.src}
          preload="metadata"
          muted
          className="w-full h-full object-cover"
        />
      ) : null}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex items-center justify-center rounded-full bg-white/85 text-charcoal shadow-sm w-7 h-7">
          {embed.kind === 'pending' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Play size={14} className="ms-0.5" />
          )}
        </span>
      </span>
    </button>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared "add a link" composer
 * ──────────────────────────────────────────────────────────────────────── */

function LinkComposer({ onAdd, isAr }: { onAdd: (url: string) => void; isAr: boolean }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Bare domains (e.g. youtu.be/…) get an https:// prefix so the embed
    // resolver + <video>/<iframe> get a fetchable URL.
    onAdd(isHttpUrl(trimmed) ? trimmed : `https://${trimmed}`);
    setDraft('');
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="url"
        dir="ltr"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={isAr ? 'الصق رابط فيديو (YouTube، Vimeo، MP4…)' : 'Paste a video link (YouTube, Vimeo, MP4…)'}
        className="form-input flex-1 text-sm"
      />
      <button
        type="button"
        onClick={commit}
        disabled={!draft.trim()}
        className="px-3 py-2 rounded-lg bg-copper text-white text-xs font-bold hover:bg-terracotta transition-colors disabled:opacity-40"
      >
        {isAr ? 'إضافة' : 'Add'}
      </button>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * VIDEO — single (`video` field)
 * ──────────────────────────────────────────────────────────────────────── */

interface SingleProps {
  value: string;
  onChange: (next: string) => void;
  isAr: boolean;
  acceptMime?: string;
  maxSizeMb?: number;
  defaultFolderId?: string | null;
  modelId?: string | null;
  recordId?: string | null;
}

export function VideoFieldInput({
  value,
  onChange,
  isAr,
  acceptMime = 'video/*',
  maxSizeMb = 200,
  defaultFolderId = null,
  modelId = null,
  recordId = null,
}: SingleProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const handlePicked = (result: DrivePickerResult) => {
    if (result.kind !== 'files') return;
    const first = result.files[0];
    if (first) onChange(first.id);
  };

  const picker = (
    <DriveBrowserModal
      open={pickerOpen}
      mode="pick-files"
      acceptMime={acceptMime}
      maxSizeMb={maxSizeMb}
      initialFolderId={defaultFolderId}
      attachToModelId={modelId}
      attachToRecordId={recordId}
      onClose={() => setPickerOpen(false)}
      onSelect={handlePicked}
    />
  );

  if (!value) {
    return (
      <div className="flex flex-col gap-2">
        <LinkComposer onAdd={onChange} isAr={isAr} />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="self-start text-xs font-bold text-copper hover:text-terracotta transition-colors inline-flex items-center gap-1"
        >
          <Film size={13} />
          {t('fields.attachment.add_from_drive')}
        </button>
        {picker}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <VideoThumb value={value} onClick={() => setLightboxOpen(true)} />
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs font-bold text-copper hover:text-terracotta transition-colors"
        >
          {isAr ? 'تغيير' : 'Replace'}
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-xs font-bold text-charcoal/50 hover:text-red-500 transition-colors"
        >
          {isAr ? 'إزالة' : 'Remove'}
        </button>
      </div>
      {picker}
      {lightboxOpen && <VideoLightbox value={value} onClose={() => setLightboxOpen(false)} />}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MULTI VIDEO — `multi_video` field
 * ──────────────────────────────────────────────────────────────────────── */

interface MultiProps {
  value: string[];
  onChange: (next: string[]) => void;
  isAr: boolean;
  acceptMime?: string;
  maxSizeMb?: number;
  maxItems?: number;
  defaultFolderId?: string | null;
  modelId?: string | null;
  recordId?: string | null;
}

export function MultiVideoFieldInput({
  value,
  onChange,
  isAr,
  acceptMime = 'video/*',
  maxSizeMb = 200,
  maxItems,
  defaultFolderId = null,
  modelId = null,
  recordId = null,
}: MultiProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lightboxValue, setLightboxValue] = useState<string | null>(null);

  const atCap = !!maxItems && value.length >= maxItems;

  const addOne = (entry: string) => {
    if (value.includes(entry)) return;
    const merged = [...value, entry];
    onChange(maxItems ? merged.slice(0, maxItems) : merged);
  };

  const handlePicked = (result: DrivePickerResult) => {
    if (result.kind !== 'files') return;
    const merged = [...value];
    for (const f of result.files) if (!merged.includes(f.id)) merged.push(f.id);
    onChange(maxItems ? merged.slice(0, maxItems) : merged);
  };

  const handleRemove = (entry: string) => onChange(value.filter((v) => v !== entry));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        {value.map((entry) => (
          <div key={entry} className="relative group">
            <VideoThumb value={entry} onClick={() => setLightboxValue(entry)} />
            <button
              type="button"
              onClick={() => handleRemove(entry)}
              aria-label={t('fields.attachment.remove')}
              className="absolute -top-1.5 -end-1.5 p-1 rounded-full bg-white border border-sand/40 text-charcoal/50 hover:text-red-500 hover:border-red-200 transition-colors opacity-0 group-hover:opacity-100 shadow-sm"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {!atCap && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="w-24 h-24 rounded-xl border border-dashed border-sand/60 flex flex-col items-center justify-center gap-1 text-charcoal/40 hover:text-copper hover:border-copper/40 hover:bg-copper/5 transition-colors"
          >
            <Plus size={20} />
            <span className="text-[10px] font-bold">{t('fields.attachment.add_from_drive')}</span>
          </button>
        )}
      </div>
      {!atCap && <LinkComposer onAdd={addOne} isAr={isAr} />}
      <DriveBrowserModal
        open={pickerOpen}
        mode="pick-files"
        acceptMime={acceptMime}
        maxSizeMb={maxSizeMb}
        initialFolderId={defaultFolderId}
        attachToModelId={modelId}
        attachToRecordId={recordId}
        initialSelectedFileIds={value}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePicked}
      />
      {lightboxValue && (
        <VideoLightbox value={lightboxValue} onClose={() => setLightboxValue(null)} />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Cells — compact table renderers
 * ──────────────────────────────────────────────────────────────────────── */

export function VideoCell({ value, isAr }: { value: string; isAr: boolean }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  if (!value) return <span className="text-charcoal/30 italic text-xs">—</span>;
  return (
    <>
      <VideoThumb
        value={value}
        size="sm"
        onClick={() => setLightboxOpen(true)}
      />
      {lightboxOpen && <VideoLightbox value={value} onClose={() => setLightboxOpen(false)} />}
      <span className="sr-only">{isAr ? 'فيديو' : 'video'}</span>
    </>
  );
}

export function MultiVideoCell({ values, isAr }: { values: string[]; isAr: boolean }) {
  const [lightboxValue, setLightboxValue] = useState<string | null>(null);
  if (values.length === 0) return <span className="text-charcoal/30 italic text-xs">—</span>;
  const first = values[0]!;
  const extra = values.length - 1;
  return (
    <>
      <span className="relative inline-block">
        <VideoThumb value={first} size="sm" onClick={() => setLightboxValue(first)} />
        {extra > 0 && (
          <span className="absolute -top-1 -end-1 text-[10px] font-bold bg-copper text-white rounded-full px-1.5 py-0.5">
            +{extra}
          </span>
        )}
      </span>
      {lightboxValue && (
        <VideoLightbox value={lightboxValue} onClose={() => setLightboxValue(null)} />
      )}
      <span className="sr-only">{isAr ? 'فيديوهات' : 'videos'}</span>
    </>
  );
}
