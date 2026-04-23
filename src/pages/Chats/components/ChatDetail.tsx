import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MessageCircle, Phone, Hash, Tag, Star } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import MessageThread from './MessageThread';
import Composer from './Composer';

/**
 * Right-pane conversation detail. Embedded inside ChatsSplitPage.
 * Renders the conversation header, scrolling thread, and composer in a
 * full-height flex column so the thread scrolls independently.
 */
export default function ChatDetail({ recordId }: { recordId: string }) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const markChatAsRead = useAppStore((s) => s.markChatAsRead);

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const record = useMemo(() => {
    if (!chatsModel) return null;
    return (records[chatsModel.id] ?? []).find((r) => r.id === recordId) ?? null;
  }, [chatsModel, records, recordId]);

  const data = record?.data as Record<string, unknown> | undefined;
  const chatWid = (data?.wid as string | undefined) ?? null;
  const name = (data?.name as string | null | undefined) ?? (data?.phone as string | null | undefined) ?? '—';
  const phone = (data?.phone as string | null | undefined) ?? null;
  const kind = (data?.kind as string | null | undefined) ?? 'user';
  const status = (data?.status as string | null | undefined) ?? 'active';
  const lastMessageAt = (data?.last_message_at as string | null | undefined) ?? null;
  const labels = Array.isArray(data?.labels) ? (data?.labels as string[]) : [];

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  // Zero out unread_count whenever we open this chat.
  useEffect(() => {
    if (chatWid) markChatAsRead(chatWid);
  }, [chatWid, markChatAsRead]);

  if (!record) {
    return (
      <div className="flex items-center justify-center flex-1 text-charcoal/50">
        <div className="text-center">
          <MessageCircle size={32} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">
            {isAr ? 'المحادثة غير موجودة' : 'Conversation not found'}
          </p>
          <p className="text-xs text-charcoal/40 mt-1">
            {isAr
              ? 'قد تكون قد حُذفت أو لم تتم مزامنتها بعد.'
              : 'It may have been removed or not synced yet.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-sand/20 shrink-0 flex items-start gap-3">
        {/* Back (mobile only — desktop shows split view) */}
        <button
          onClick={() => navigate('/model/chats')}
          className="md:hidden -ms-1 p-1.5 rounded-lg text-charcoal/60 hover:text-copper hover:bg-cream transition-colors"
          aria-label={isAr ? 'رجوع' : 'Back'}
        >
          <BackIcon size={18} />
        </button>
        <div className="w-10 h-10 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0 font-semibold">
          {(name.trim().charAt(0) || '#').toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-base font-bold text-chocolate truncate">{name}</h1>
            <StatusBadge status={status} isAr={isAr} />
          </div>
          {phone && (
            <p className="text-xs text-charcoal/60 mt-0.5 font-mono" dir="ltr">
              <Phone size={10} className="inline me-1" />
              {phone}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[11px] text-charcoal/50 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <Hash size={10} />
              {kindLabel(kind, isAr)}
            </span>
            {lastMessageAt && (
              <span>
                {isAr ? 'آخر رسالة: ' : 'Last: '}
                {formatDateTime(lastMessageAt, isAr)}
              </span>
            )}
            {labels.length > 0 && (
              <span className="inline-flex items-center gap-1 flex-wrap">
                <Tag size={10} />
                {labels.slice(0, 3).join(' · ')}
                {labels.length > 3 && ` +${labels.length - 3}`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Thread (scrolls within its own card) */}
      <div className="flex-1 min-h-0 overflow-hidden px-3 pt-3">
        <MessageThread chatWid={chatWid ?? ''} />
      </div>

      {/* Composer */}
      <div className="px-3 pb-3 shrink-0">
        <Composer chatWid={chatWid ?? ''} disabled={kind !== 'user'} />
        {kind !== 'user' && (
          <p className="text-xs text-charcoal/40 mt-1 text-center">
            {isAr
              ? 'الإرسال للمجموعات والقنوات غير مدعوم حاليًا.'
              : 'Sending to groups and channels is not yet supported.'}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function StatusBadge({ status, isAr }: { status: string; isAr: boolean }) {
  const color = statusColor(status);
  return (
    <span
      className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full"
      style={{ backgroundColor: `${color}14`, color }}
    >
      {statusLabel(status, isAr)}
    </span>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return '#22c55e';
    case 'resolved': return '#6b7280';
    case 'archived': return '#9ca3af';
    default: return '#6b7280';
  }
}

function statusLabel(status: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    active: { ar: 'نشط', en: 'Active' },
    resolved: { ar: 'تم الحل', en: 'Resolved' },
    archived: { ar: 'مؤرشف', en: 'Archived' },
  };
  const entry = map[status];
  if (!entry) return status;
  return isAr ? entry.ar : entry.en;
}

function kindLabel(kind: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    user: { ar: 'محادثة فردية', en: 'Direct chat' },
    group: { ar: 'مجموعة', en: 'Group' },
    channel: { ar: 'قناة', en: 'Channel' },
  };
  const entry = map[kind];
  if (!entry) return kind;
  return isAr ? entry.ar : entry.en;
}

function formatDateTime(iso: string, isAr: boolean): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return iso;
  }
}

// Used by ChatsSplitPage for the no-selection placeholder pane.
export function ChatDetailEmptyPane({ isAr }: { isAr: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center text-charcoal/40">
      <div className="text-center">
        <MessageCircle size={40} className="mx-auto mb-3 opacity-30" />
        <p className="font-medium">
          {isAr ? 'اختر محادثة من القائمة' : 'Select a conversation'}
        </p>
        <p className="text-xs text-charcoal/40 mt-1">
          <Star size={12} className="inline me-1 opacity-40" />
          {isAr ? 'الرسائل الواردة تظهر فوراً دون تحديث.' : 'New messages arrive live without refresh.'}
        </p>
      </div>
    </div>
  );
}
