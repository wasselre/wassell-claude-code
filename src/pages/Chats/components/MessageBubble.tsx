import { useEffect, useMemo, useState } from 'react';
import { FileText, Image as ImageIcon, Mic, Video, MapPin, Sticker, Download, Loader2, AlertCircle } from 'lucide-react';
import AckIndicator from './AckIndicator';
import { fetchFileBlob } from '@/lib/haberchat/client';
import { useAppStore } from '@/stores/appStore';
import type { ChatMessage } from '@/types';

/**
 * One message bubble. Outbound on the right (copper), inbound on the left
 * (warm sand). Alignment is keyed off `flow`, not document direction — an
 * Arabic message from "you" still appears on the right in RTL mode.
 *
 * Renders inline media via an authenticated blob fetch (see
 * useMediaBlob). Download URLs never leave the server; <img src> would
 * bypass the auth header and can't access the Haberchat token anyway.
 */
export default function MessageBubble({
  message,
  isAr,
}: {
  message: ChatMessage;
  isAr: boolean;
}) {
  const isOut = message.flow === 'out';

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'} w-full`}>
      <div
        dir={isAr ? 'rtl' : 'ltr'}
        className={`max-w-[75%] sm:max-w-[65%] rounded-2xl px-3.5 py-2 shadow-sm ${
          isOut
            ? 'bg-copper/10 text-charcoal rounded-br-md'
            : 'bg-sand/20 text-charcoal rounded-bl-md'
        } ${message.ack === 'failed' ? 'border border-red-300' : ''}`}
      >
        {message.quoted && (
          <div className="mb-1.5 pl-2 border-s-2 border-copper/40 text-xs text-charcoal/60">
            <div className="font-medium opacity-80">
              {isAr ? 'ردًّا على:' : 'Replying to:'}
            </div>
            <div className="truncate">
              {message.quoted.body ?? `[${message.quoted.kind}]`}
            </div>
          </div>
        )}

        <MessageBody message={message} isAr={isAr} />

        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-charcoal/50 justify-end">
          <span>{formatTime(message.date, isAr)}</span>
          <AckIndicator message={message} />
        </div>
      </div>
    </div>
  );
}

// ─── Body ───────────────────────────────────────────────────────────

function MessageBody({ message, isAr }: { message: ChatMessage; isAr: boolean }) {
  const hasMedia = !!message.media_file_id;

  if (hasMedia) {
    return <MediaRenderer message={message} isAr={isAr} />;
  }

  if (message.body) {
    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
        {message.body}
      </p>
    );
  }

  // No body, no media — non-text kinds without an attachment (location,
  // sticker, system event, etc.). Show a generic icon chip.
  const kind = message.kind;
  const { Icon, labelAr, labelEn } = iconFor(kind);
  return (
    <div className="flex items-center gap-2 text-charcoal/70">
      <div className="w-9 h-9 rounded-lg bg-charcoal/5 flex items-center justify-center">
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{isAr ? labelAr : labelEn}</div>
      </div>
    </div>
  );
}

// ─── Media renderer ─────────────────────────────────────────────────

function MediaRenderer({ message, isAr }: { message: ChatMessage; isAr: boolean }) {
  // Message media lives in Haberchat's DEVICE-scoped namespace (separate
  // from the ACCOUNT-scoped /v1/files/ where our template pre-uploads
  // go). Haberchat even re-ids the file during send (e.g. transcoding
  // audio/ogg → audio/mp3) and the new id is only resolvable with the
  // deviceId. Pull the device_id from the parent chat record.
  const deviceId = useAppStore((s) => {
    const chatsModel = s.models.find((m) => m.name === 'chats');
    if (!chatsModel) return undefined;
    const rec = (s.records[chatsModel.id] ?? []).find((r) =>
      ((r.data as Record<string, unknown>).wid as string | undefined) === message.chat_wid,
    );
    return rec ? ((rec.data as Record<string, unknown>).device_id as string | undefined) ?? undefined : undefined;
  });

  const { url, status, error } = useMediaBlob(message.media_file_id, deviceId);

  const mime = message.media_mime ?? '';
  const kind = message.kind;
  const caption = message.media_caption ?? message.body ?? null;

  // Image
  if (kind === 'image' || mime.startsWith('image/')) {
    return (
      <div className="-mx-1">
        {status === 'loading' && <MediaLoadingSkeleton />}
        {status === 'error' && <MediaErrorRow message={error} isAr={isAr} />}
        {status === 'ready' && url && (
          <a href={url} target="_blank" rel="noreferrer">
            <img
              src={url}
              alt={caption ?? ''}
              className="rounded-xl max-w-full max-h-80 object-cover"
              loading="lazy"
            />
          </a>
        )}
        {caption && (
          <p className="text-sm mt-1.5 whitespace-pre-wrap break-words">{caption}</p>
        )}
      </div>
    );
  }

  // Video
  if (kind === 'video' || mime.startsWith('video/')) {
    return (
      <div className="-mx-1">
        {status === 'loading' && <MediaLoadingSkeleton />}
        {status === 'error' && <MediaErrorRow message={error} isAr={isAr} />}
        {status === 'ready' && url && (
          <video src={url} controls className="rounded-xl max-w-full max-h-80 bg-black" />
        )}
        {caption && (
          <p className="text-sm mt-1.5 whitespace-pre-wrap break-words">{caption}</p>
        )}
      </div>
    );
  }

  // Audio — compact inline player.
  if (kind === 'audio' || mime.startsWith('audio/')) {
    return (
      <div>
        {status === 'loading' && <MediaLoadingSkeleton compact />}
        {status === 'error' && <MediaErrorRow message={error} isAr={isAr} />}
        {status === 'ready' && url && (
          <audio src={url} controls className="w-full max-w-[260px]" />
        )}
        {caption && (
          <p className="text-sm mt-1.5 whitespace-pre-wrap break-words">{caption}</p>
        )}
      </div>
    );
  }

  // Document / generic file — styled as a download chip.
  const filename = deriveFilename(message);
  return (
    <div>
      <a
        href={url ?? '#'}
        download={filename ?? undefined}
        target="_blank"
        rel="noreferrer"
        className={`flex items-center gap-2.5 rounded-xl bg-charcoal/5 hover:bg-charcoal/10 px-3 py-2 transition-colors ${
          status === 'ready' ? '' : 'pointer-events-none opacity-70'
        }`}
      >
        <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0">
          {status === 'loading'
            ? <Loader2 size={18} className="animate-spin text-charcoal/60" />
            : status === 'error'
              ? <AlertCircle size={18} className="text-red-500" />
              : <FileText size={18} className="text-charcoal/70" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{filename ?? (isAr ? 'مستند' : 'Document')}</div>
          <div className="text-[10px] text-charcoal/50">
            {formatFileSize(message.media_size, isAr)}
            {status === 'error' && <span className="ms-1 text-red-600">· {error}</span>}
          </div>
        </div>
        {status === 'ready' && url && <Download size={14} className="text-charcoal/40 shrink-0" />}
      </a>
      {caption && (
        <p className="text-sm mt-1.5 whitespace-pre-wrap break-words">{caption}</p>
      )}
    </div>
  );
}

// ─── Media fetching hook ────────────────────────────────────────────

type MediaState = { url: string | null; status: 'loading' | 'ready' | 'error'; error: string | null };

/**
 * Fetch a media blob via the authenticated proxy and expose it as a
 * blob: URL. Revokes the URL on unmount / input change so we don't
 * leak memory. A tiny in-memory cache keyed by (fileId, deviceId)
 * avoids re-fetching when the user scrolls the same message back into
 * view. deviceId matters because the same id can resolve to different
 * content (or not resolve at all) across namespaces.
 */
const mediaCache = new Map<string, string>(); // key = fileId|deviceId, value = blob: URL

function useMediaBlob(fileId: string | null, deviceId: string | undefined): MediaState {
  const cacheKey = fileId ? `${fileId}|${deviceId ?? ''}` : null;
  const initial = useMemo<MediaState>(() => {
    if (!fileId) {
      return { url: null, status: 'error', error: 'missing file id' };
    }
    const cached = cacheKey ? mediaCache.get(cacheKey) : null;
    if (cached) return { url: cached, status: 'ready', error: null };
    return { url: null, status: 'loading', error: null };
  }, [fileId, cacheKey]);
  const [state, setState] = useState<MediaState>(initial);

  useEffect(() => {
    setState(initial);
    if (initial.status !== 'loading' || !fileId || !cacheKey) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    void (async () => {
      try {
        const blob = await fetchFileBlob(fileId, deviceId);
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        createdUrl = objectUrl;
        mediaCache.set(cacheKey, objectUrl);
        setState({ url: objectUrl, status: 'ready', error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          url: null,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
      // Don't revoke cached URLs — other bubbles may still be using them.
      // The blob stays alive until the page unloads; acceptable trade-off
      // for avoiding re-fetches while scrolling.
      if (createdUrl && !mediaCache.has(cacheKey)) URL.revokeObjectURL(createdUrl);
    };
  }, [fileId, deviceId, cacheKey, initial]);

  return state;
}

// ─── Helpers ────────────────────────────────────────────────────────

function MediaLoadingSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`rounded-xl bg-charcoal/5 flex items-center justify-center ${
        compact ? 'h-10 w-40' : 'h-40 w-full min-w-[240px]'
      }`}
    >
      <Loader2 size={20} className="animate-spin text-charcoal/40" />
    </div>
  );
}

function MediaErrorRow({ message, isAr }: { message: string | null; isAr: boolean }) {
  return (
    <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
      <AlertCircle size={14} />
      <div className="flex-1">
        <div className="font-medium">{isAr ? 'تعذّر تحميل الملف' : 'Could not load file'}</div>
        {message && <div className="text-[11px] text-red-600/80 mt-0.5 truncate">{message}</div>}
      </div>
    </div>
  );
}

function iconFor(kind: string): { Icon: typeof FileText; labelAr: string; labelEn: string } {
  switch (kind) {
    case 'image': return { Icon: ImageIcon, labelAr: 'صورة', labelEn: 'Image' };
    case 'video': return { Icon: Video, labelAr: 'فيديو', labelEn: 'Video' };
    case 'audio': return { Icon: Mic, labelAr: 'رسالة صوتية', labelEn: 'Audio' };
    case 'document': return { Icon: FileText, labelAr: 'مستند', labelEn: 'Document' };
    case 'sticker': return { Icon: Sticker, labelAr: 'ملصق', labelEn: 'Sticker' };
    case 'location': return { Icon: MapPin, labelAr: 'موقع', labelEn: 'Location' };
    default: return { Icon: FileText, labelAr: `[${kind}]`, labelEn: `[${kind}]` };
  }
}

function deriveFilename(message: ChatMessage): string | null {
  // Haberchat message payloads sometimes include a filename in media;
  // our normalizer currently drops it — fall back to the mime-derived
  // default or the file id.
  if (message.body) return null;
  if (message.media_mime) {
    const ext = message.media_mime.split('/')[1] ?? 'bin';
    return `${message.media_file_id ?? 'file'}.${ext}`;
  }
  return message.media_file_id ?? null;
}

function formatFileSize(bytes: number | null, isAr: boolean): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} ${isAr ? 'ب' : 'B'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} ${isAr ? 'ك.ب' : 'KB'}`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ${isAr ? 'م.ب' : 'MB'}`;
}

function formatTime(iso: string, isAr: boolean): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return '';
  }
}
