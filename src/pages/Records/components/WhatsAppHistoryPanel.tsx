import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import MessageBubble from '@/pages/Chats/components/MessageBubble';
import { selectClientChatMessages, type ClientChatRecord } from '@/lib/haberchat/clientHistory';
import type { ChatMessage } from '@/types';

interface WhatsAppHistoryPanelProps {
  clientId: string;
  /**
   * 'card' (default) — wraps the panel in a `card` with its own header.
   * 'naked' — drops the chrome; the surrounding section block already
   *   provides the title.
   */
  chrome?: 'card' | 'naked';
}

/**
 * Unified WhatsApp history for a single client across every Haberchat device
 * (i.e. every one of OUR phone numbers). Each bubble is annotated with the
 * friendly name of the device that handled it so the user can tell which of
 * our numbers a message came through.
 *
 * Mounts the global `subscribeToAllChats()` channel on mount (idempotent —
 * the store handles dedup), then reads from the `chatMessages` slice. New
 * messages stream in live without a manual refresh.
 *
 * Older messages are fetched lazily per-conversation via `loadMessagesForChat`
 * — initial mount triggers one load per chat record so we have something to
 * show even if the user hasn't opened those conversations in the chats UI yet.
 */
export default function WhatsAppHistoryPanel({ clientId, chrome = 'card' }: WhatsAppHistoryPanelProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const waDevices = useAppStore((s) => s.waDevices);
  const loadMessagesForChat = useAppStore((s) => s.loadMessagesForChat);
  const subscribeToAllChats = useAppStore((s) => s.subscribeToAllChats);

  const chatsModelId = useMemo(
    () => models.find((m) => m.name === 'chats')?.id ?? null,
    [models],
  );

  const { messages, chatRecords, chatRecordsByWid } = useMemo(
    () => selectClientChatMessages({ clientId, chatsModelId, records, chatMessages }),
    [clientId, chatsModelId, records, chatMessages],
  );

  const deviceLabelById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of waDevices) {
      const friendly = ((isAr ? d.friendly_name_ar : d.friendly_name_en) ?? '').trim();
      if (d.device_id) map[d.device_id] = friendly || d.phone || d.device_id;
    }
    return map;
  }, [waDevices, isAr]);

  const [loading, setLoading] = useState(true);

  // Subscribe once so live messages flow into the store while the panel is
  // mounted. Idempotent — the store's globalChatsChannel guards against
  // double subscription. We intentionally do NOT unsubscribe on unmount;
  // other parts of the app (the chats list) rely on the same channel.
  useEffect(() => {
    subscribeToAllChats();
  }, [subscribeToAllChats]);

  // Initial fetch: load the most recent page of messages for every chat
  // record linked to this client. This is what lets the panel show history
  // for conversations the user hasn't opened in the dedicated chats page yet.
  useEffect(() => {
    if (chatRecords.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      chatRecords.map((cr) => loadMessagesForChat(cr.chatWid, { size: 50 }).catch(() => undefined)),
    ).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // chatRecords identity changes whenever the underlying chats records do —
    // safe to depend on it directly.
  }, [chatRecords, loadMessagesForChat]);

  if (chatRecords.length === 0 && !loading) {
    return (
      <Wrapper chrome={chrome} isAr={isAr}>
        <p className="text-sm text-charcoal/60">
          {isAr
            ? 'لا توجد محادثات واتساب مرتبطة بهذا العميل بعد.'
            : 'No WhatsApp conversations linked to this client yet.'}
        </p>
      </Wrapper>
    );
  }

  if (loading && messages.length === 0) {
    return (
      <Wrapper chrome={chrome} isAr={isAr}>
        <div className="flex items-center justify-center py-8 text-charcoal/50">
          <Loader2 size={18} className="animate-spin me-2" />
          {isAr ? 'جارٍ تحميل الرسائل…' : 'Loading messages…'}
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper chrome={chrome} isAr={isAr} count={messages.length} numbers={chatRecords.length}>
      <div
        className="flex-1 overflow-y-auto px-1 py-2 space-y-2"
        style={{ maxHeight: '60vh', minHeight: '300px' }}
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-charcoal/40">
            <MessageCircle size={28} className="mb-2 opacity-40" />
            <p className="text-sm">
              {isAr ? 'لا توجد رسائل بعد' : 'No messages yet'}
            </p>
          </div>
        ) : (
          renderGrouped(messages, chatRecordsByWid, deviceLabelById, isAr)
        )}
      </div>
    </Wrapper>
  );
}

function Wrapper({
  chrome,
  isAr,
  count,
  numbers,
  children,
}: {
  chrome: 'card' | 'naked';
  isAr: boolean;
  count?: number;
  numbers?: number;
  children: React.ReactNode;
}) {
  if (chrome === 'naked') {
    return (
      <div className="flex flex-col">
        {(count !== undefined && count > 0) && (
          <p className="text-xs text-charcoal/60 mb-2" dir="ltr">
            {count} {isAr ? 'رسالة' : count === 1 ? 'message' : 'messages'}
            {numbers && numbers > 1 && (
              <> · {numbers} {isAr ? 'محادثة' : 'conversations'}</>
            )}
          </p>
        )}
        {children}
      </div>
    );
  }
  return (
    <section className="card flex flex-col">
      <header className="flex items-center gap-2 mb-3">
        <MessageCircle size={18} style={{ color: '#25D366' }} />
        <h3 className="text-lg font-semibold text-charcoal">
          {isAr ? 'سجل واتساب' : 'WhatsApp History'}
        </h3>
        {count !== undefined && (
          <span className="text-sm text-charcoal/60">({count})</span>
        )}
      </header>
      {children}
    </section>
  );
}

function renderGrouped(
  messages: ChatMessage[],
  chatRecordsByWid: Record<string, ClientChatRecord>,
  deviceLabelById: Record<string, string>,
  isAr: boolean,
) {
  // Group by day for visual anchor; within each day, render in arrival order.
  // Each bubble shows a tiny "via <our device name>" tag so the user can see
  // which of our numbers handled the conversation.
  const groups = groupByDay(messages, isAr);
  return groups.map((g) => (
    <div key={g.key} className="space-y-2">
      <div className="flex items-center justify-center my-2">
        <span className="text-[11px] font-medium text-charcoal/50 bg-cream/80 px-3 py-0.5 rounded-full">
          {g.label}
        </span>
      </div>
      {g.messages.map((m) => {
        const cr = chatRecordsByWid[m.chat_wid];
        const deviceLabel = cr?.deviceId ? (deviceLabelById[cr.deviceId] ?? cr.deviceId) : null;
        const isOut = m.flow === 'out';
        return (
          <div key={m.id} className="space-y-1">
            <MessageBubble message={m} isAr={isAr} />
            {deviceLabel && (
              <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                <span className="text-[10px] text-charcoal/40 px-1">
                  {isAr ? 'عبر' : 'via'} {deviceLabel}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  ));
}

function groupByDay(messages: ChatMessage[], isAr: boolean) {
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups: { key: string; label: string; messages: ChatMessage[] }[] = [];
  for (const m of messages) {
    const d = startOfDay(new Date(m.date));
    const key = d.toISOString().slice(0, 10);
    let label: string;
    if (d.getTime() === today.getTime()) label = isAr ? 'اليوم' : 'Today';
    else if (d.getTime() === yesterday.getTime()) label = isAr ? 'أمس' : 'Yesterday';
    else {
      label = new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
        day: 'numeric',
        month: 'short',
        year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
      }).format(d);
    }
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.messages.push(m);
    else groups.push({ key, label, messages: [m] });
  }
  return groups;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
