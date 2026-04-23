import { useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MessageCircle, Phone, Hash, Tag, Star } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import MessageThread from './components/MessageThread';
import Composer from './components/Composer';

/**
 * Placeholder detail page for a single conversation. Replaces the generic
 * RecordFormPage for /model/chats/:recordId (see dispatcher in App.tsx).
 *
 * Renders the conversation's identity + state read-only from the records
 * store, plus a "message thread + composer coming soon" area. Steps 6 and 7
 * fill in the thread and composer.
 */
export default function ChatDetailPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const record = useMemo(() => {
    if (!chatsModel || !recordId) return null;
    return (records[chatsModel.id] ?? []).find((r) => r.id === recordId) ?? null;
  }, [chatsModel, records, recordId]);

  const chatWid = (record?.data as Record<string, unknown> | undefined)?.wid as string | undefined ?? null;
  const subscribeToChat = useAppStore((s) => s.subscribeToChat);
  const unsubscribeFromChat = useAppStore((s) => s.unsubscribeFromChat);

  // Subscribe to Supabase Realtime on mount so the webhook → DB → UI path
  // is live while this page is open. Cleanup on unmount removes the channel.
  useEffect(() => {
    if (!chatWid) return;
    subscribeToChat(chatWid);
    return () => unsubscribeFromChat(chatWid);
  }, [chatWid, subscribeToChat, unsubscribeFromChat]);

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  if (!record) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <button
          onClick={() => navigate('/model/chats')}
          className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-copper mb-6"
        >
          <BackIcon size={16} />
          {isAr ? 'العودة للمحادثات' : 'Back to chats'}
        </button>
        <div className="card p-10 text-center text-charcoal/50">
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

  const data = record.data as Record<string, unknown>;
  const name = (data.name as string | null) ?? (data.phone as string | null) ?? '—';
  const phone = (data.phone as string | null) ?? null;
  const kind = (data.kind as string | null) ?? 'user';
  const status = (data.status as string | null) ?? 'active';
  const unreadCount = typeof data.unread_count === 'number' ? data.unread_count : 0;
  const lastMessageAt = (data.last_message_at as string | null) ?? null;
  const labels = Array.isArray(data.labels) ? (data.labels as string[]) : [];

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      {/* Back */}
      <button
        onClick={() => navigate('/model/chats')}
        className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-copper mb-5"
      >
        <BackIcon size={16} />
        {isAr ? 'العودة للمحادثات' : 'Back to chats'}
      </button>

      {/* Header card — identity + state */}
      <div className="card p-5 mb-5">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-2xl bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <MessageCircle size={26} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-chocolate truncate">{name}</h1>
              <StatusBadge status={status} isAr={isAr} />
              {unreadCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-copper/10 text-copper">
                  <Star size={12} fill="currentColor" />
                  {isAr ? `${unreadCount} غير مقروءة` : `${unreadCount} unread`}
                </span>
              )}
            </div>
            {phone && (
              <p className="text-sm text-charcoal/60 mt-1 font-mono" dir="ltr">
                <Phone size={12} className="inline me-1" />
                {phone}
              </p>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs text-charcoal/50">
              <span className="inline-flex items-center gap-1">
                <Hash size={12} />
                {kindLabel(kind, isAr)}
              </span>
              {lastMessageAt && (
                <span>
                  {isAr ? 'آخر رسالة: ' : 'Last: '}
                  {formatDateTime(lastMessageAt, isAr)}
                </span>
              )}
            </div>
            {labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {labels.map((l) => (
                  <span
                    key={l}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-charcoal/5 text-charcoal/70"
                  >
                    <Tag size={10} />
                    {l}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Message thread + composer. Disabled for groups/channels since v1
          only supports direct chats (send proxy rejects non-user kinds). */}
      <MessageThread chatWid={(data.wid as string) ?? ''} />
      <Composer
        chatWid={(data.wid as string) ?? ''}
        disabled={kind !== 'user'}
      />
      {kind !== 'user' && (
        <p className="text-xs text-charcoal/40 mt-2 text-center">
          {isAr
            ? 'الإرسال للمجموعات والقنوات غير مدعوم حاليًا.'
            : 'Sending to groups and channels is not yet supported.'}
        </p>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function StatusBadge({ status, isAr }: { status: string; isAr: boolean }) {
  const color = statusColor(status);
  return (
    <span
      className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full"
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
    case 'muted': return '#6b7280';
    default: return '#6b7280';
  }
}

function statusLabel(status: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    active: { ar: 'نشط', en: 'Active' },
    resolved: { ar: 'تم الحل', en: 'Resolved' },
    archived: { ar: 'مؤرشف', en: 'Archived' },
    muted: { ar: 'صامت', en: 'Muted' },
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
