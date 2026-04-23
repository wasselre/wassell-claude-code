import { FileText, Image as ImageIcon, Mic, Video, MapPin, Sticker } from 'lucide-react';
import AckIndicator from './AckIndicator';
import type { ChatMessage } from '@/types';

/**
 * One message bubble. Outbound on the right (copper), inbound on the left
 * (warm sand). Alignment is keyed off `flow`, not document direction — an
 * Arabic message from "you" still appears on the right in RTL mode.
 *
 * Step 6 covers text + a minimal placeholder for non-text kinds. Media
 * rendering (actual <img>/<audio>/<video>) lands in Step 9.
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

        {/* Body / media placeholder */}
        <MessageBody message={message} isAr={isAr} />

        {/* Footer: time + ack */}
        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-charcoal/50 justify-end">
          <span>{formatTime(message.date, isAr)}</span>
          <AckIndicator message={message} />
        </div>
      </div>
    </div>
  );
}

function MessageBody({ message, isAr }: { message: ChatMessage; isAr: boolean }) {
  if (message.body) {
    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
        {message.body}
      </p>
    );
  }
  // Non-text placeholders — real rendering lands in Step 9.
  const kind = message.kind;
  const caption = message.media_caption;
  const { Icon, labelAr, labelEn } = iconFor(kind);
  return (
    <div className="flex items-center gap-2 text-charcoal/70">
      <div className="w-9 h-9 rounded-lg bg-charcoal/5 flex items-center justify-center">
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{isAr ? labelAr : labelEn}</div>
        {caption && <div className="text-xs text-charcoal/60 truncate">{caption}</div>}
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
