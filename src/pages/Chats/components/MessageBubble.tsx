import { useEffect, useMemo, useState } from 'react';
import { FileText, Image as ImageIcon, Mic, Video, MapPin, Sticker, Download, Loader2, AlertCircle, MessageSquare, ListChecks, User, RotateCcw } from 'lucide-react';
import AckIndicator from './AckIndicator';
import { fetchFileBlob } from '@/lib/haberchat/client';
import { isLegacyHaberchatRef } from '@/lib/chat/legacyMedia';
import { deviceIdString } from '@/lib/haberchat/normalize';
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
  reactions,
  onRetry,
}: {
  message: ChatMessage;
  isAr: boolean;
  /** Reaction rows whose `quoted.wid` targets THIS message (see MessageThread). */
  reactions?: ChatMessage[];
  /** Re-send THIS message. Supplied for outbound bubbles only; rendered as an
   *  explicit Retry action once the bubble has gone `ack: 'failed'`. */
  onRetry?: () => void;
}) {
  const isOut = message.flow === 'out';
  const failed = isOut && message.ack === 'failed';

  // WhatsApp system events (privacy notices, call logs, E2E notices, deleted
  // messages…) aren't conversational messages — Haberchat delivers them
  // without a text body. Render a centered, muted notice instead of an empty
  // left/right bubble that would otherwise show a bare `[kind]` placeholder.
  const notice = systemNoticeText(message, isAr);
  if (notice) {
    return (
      <div className="flex justify-center w-full">
        <span
          dir={isAr ? 'rtl' : 'ltr'}
          className="max-w-[85%] text-center text-[11px] text-charcoal/55 bg-charcoal/5 rounded-full px-3 py-1"
        >
          {notice}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'} w-full`}>
      {/* Column wrapper so any reaction badge hangs off the bubble's bottom
          edge on the same side, instead of becoming its own bubble. */}
      <div className={`flex flex-col max-w-[75%] sm:max-w-[65%] ${isOut ? 'items-end' : 'items-start'}`}>
      <div
        dir={isAr ? 'rtl' : 'ltr'}
        className={`max-w-full rounded-2xl px-3.5 py-2 shadow-sm ${
          isOut
            ? 'bg-copper/10 text-charcoal rounded-br-md'
            : 'bg-sand/20 text-charcoal rounded-bl-md'
        } ${failed ? 'border border-red-300' : ''}`}
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

        {/* A failed send is stated in words, not just a tick colour, and stays
            one click from going out again. The text is never discarded — the
            bubble IS the copy of it. */}
        {failed && (
          <div className="mt-1.5 flex items-center gap-2 border-t border-red-200 pt-1.5 text-[11px] text-red-700">
            <span className="font-medium">{isAr ? 'لم تُرسل' : 'Not sent'}</span>
            {onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-1.5 py-0.5 font-medium transition-colors hover:bg-red-50"
                type="button"
              >
                <RotateCcw size={11} />
                {isAr ? 'إعادة المحاولة' : 'Retry'}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-charcoal/50 justify-end">
          <span>{formatTime(message.date, isAr)}</span>
          <AckIndicator message={message} />
        </div>
      </div>
      {reactions && reactions.length > 0 && (
        <ReactionBadge reactions={reactions} isAr={isAr} />
      )}
      </div>
    </div>
  );
}

/**
 * WhatsApp-style reaction pill hanging off the bubble's bottom edge. Identical
 * emojis are aggregated with a count (several people can send the same one).
 */
function ReactionBadge({ reactions, isAr }: { reactions: ChatMessage[]; isAr: boolean }) {
  const counts = new Map<string, number>();
  for (const r of reactions) {
    const emoji = (r.body ?? '').trim();
    if (!emoji) continue;
    counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div
      dir={isAr ? 'rtl' : 'ltr'}
      title={isAr ? `${total} تفاعل` : `${total} reaction${total > 1 ? 's' : ''}`}
      className="-mt-1.5 flex items-center gap-1 rounded-full bg-white border border-sand/60 shadow-sm px-1.5 py-0.5"
    >
      {[...counts.entries()].map(([emoji, n]) => (
        <span key={emoji} className="text-[13px] leading-none">
          {emoji}
          {n > 1 && <span className="ms-0.5 text-[10px] align-middle text-charcoal/60">{n}</span>}
        </span>
      ))}
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
    // deviceIdString: legacy webhook-created records can carry the whole
    // device object here — a raw cast broke the media URL.
    return rec ? deviceIdString((rec.data as Record<string, unknown>).device_id) ?? undefined : undefined;
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
        {status === 'unavailable' && <MediaUnavailableRow isAr={isAr} />}
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
        {status === 'unavailable' && <MediaUnavailableRow isAr={isAr} />}
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
        {status === 'unavailable' && <MediaUnavailableRow isAr={isAr} />}
        {status === 'ready' && url && (
          // Definite width, NOT w-full: the bubble sizes to its content, so a
          // percentage width on the only child is circular and collapsed the
          // player to ~27px (voice notes looked broken though the audio itself
          // decoded fine — readyState 4, real duration). Reported live 2026-07-19.
          <audio src={url} controls className="w-[260px] max-w-full" />
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

type MediaState = { url: string | null; status: 'loading' | 'ready' | 'error' | 'unavailable'; error: string | null };

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
    // A Haberchat-era attachment is gone for good (see legacyMedia.ts). Say so
    // straight away rather than spending a request per bubble to be told 403 —
    // one thread alone holds 34 of these.
    if (isLegacyHaberchatRef(fileId)) {
      return { url: null, status: 'unavailable', error: null };
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

/**
 * A Haberchat-era attachment. The provider's account is gone (its file endpoint
 * 403s on every id), so these bytes are not coming back — this is a statement
 * of fact, not a failure to retry. Deliberately muted rather than red: nothing
 * is broken and there is nothing for the rep to do.
 */
function MediaUnavailableRow({ isAr }: { isAr: boolean }) {
  return (
    <div className="rounded-xl bg-charcoal/5 border border-sand/50 px-3 py-2 text-xs text-charcoal/60 flex items-center gap-2">
      <FileText size={14} />
      <div className="flex-1">
        <div className="font-medium">
          {isAr ? 'مرفق قديم غير متاح' : 'Older attachment unavailable'}
        </div>
        <div className="text-[11px] text-charcoal/45 mt-0.5">
          {isAr
            ? 'أُرسل عبر مزوّد الواتساب السابق ولم يعد محفوظًا لدينا'
            : 'Sent through the previous WhatsApp provider and no longer stored'}
        </div>
      </div>
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
    // Conversational kinds WhatsApp delivers without a plain-text body — show
    // a friendly label instead of a raw `[kind]` token.
    case 'interactive': return { Icon: MessageSquare, labelAr: 'رسالة تفاعلية', labelEn: 'Interactive message' };
    case 'template': return { Icon: FileText, labelAr: 'رسالة قالب', labelEn: 'Template message' };
    case 'poll': return { Icon: ListChecks, labelAr: 'استطلاع', labelEn: 'Poll' };
    case 'contact':
    case 'vcard': return { Icon: User, labelAr: 'جهة اتصال', labelEn: 'Contact' };
    default: return { Icon: MessageSquare, labelAr: 'رسالة', labelEn: 'Message' };
  }
}

// WhatsApp / Haberchat system-event kinds — delivered without a text body.
// Rendered as a centered notice, not a conversation bubble. Verified against
// the live Haberchat API: e.g. a `notification_template` with subtype
// `biz_privacy_mode_init_fb` is WhatsApp's "another company manages this chat"
// privacy notice; `call_log` rows carry no body either.
const SYSTEM_KINDS = new Set([
  'notification_template',
  'call_log',
  'e2e_notification',
  'notification',
  'gp2',
  'protocol',
  'ciphertext',
  'revoked',
]);

function systemNoticeText(message: ChatMessage, isAr: boolean): string | null {
  if (!SYSTEM_KINDS.has(message.kind)) return null;
  // If a system message unexpectedly carries a real body, prefer showing it.
  if (message.body && message.body.trim()) return message.body;

  const sub = (message.subtype ?? '').toLowerCase();

  if (message.kind === 'call_log') {
    const video = sub.includes('video');
    if (isAr) return video ? '📹 مكالمة فيديو' : '📞 مكالمة صوتية';
    return video ? '📹 Video call' : '📞 Voice call';
  }

  // Business "another company manages this chat" privacy notices.
  if (sub.startsWith('biz_privacy_mode')) {
    return isAr
      ? '🔒 يعمل هذا النشاط التجاري مع شركة أخرى لإدارة هذه المحادثة.'
      : '🔒 This business works with another company to manage this chat.';
  }

  if (message.kind === 'e2e_notification' || sub.includes('e2e') || sub.includes('encrypt')) {
    return isAr
      ? '🔒 الرسائل مشفّرة تمامًا من طرف إلى طرف.'
      : '🔒 Messages are end-to-end encrypted.';
  }

  if (message.kind === 'revoked') {
    return isAr ? '🚫 تم حذف هذه الرسالة' : '🚫 This message was deleted';
  }

  // Generic WhatsApp system notification (unknown subtype).
  return isAr ? 'إشعار من واتساب' : 'WhatsApp notification';
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
