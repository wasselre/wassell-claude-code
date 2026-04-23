import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Loader2, ChevronUp } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import MessageBubble from './MessageBubble';
import type { ChatMessage } from '@/types';

/**
 * Scrollable message thread. On mount: calls loadMessagesForChat to fetch
 * the latest page, then scrolls to the bottom. "Load older" button at the
 * top fetches the previous page using `before=<oldest.date>` as cursor.
 *
 * Day separators (Today / Yesterday / dd-MMM-yyyy) group bubbles into
 * chunks — cheap visual anchor when scrolling history.
 */
export default function MessageThread({ chatWid }: { chatWid: string }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const messages = useAppStore((s) => s.chatMessages[chatWid] ?? EMPTY);
  const loadMessagesForChat = useAppStore((s) => s.loadMessagesForChat);

  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);

  // Initial load on mount / chat switch. Resets loading / error state so a
  // page reused via React key doesn't keep stale flags.
  useEffect(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await loadMessagesForChat(chatWid, { size: 50 });
        setHasMore(res.hasMore);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [chatWid, loadMessagesForChat]);

  // Scroll-to-bottom on fresh load. When we append older history via
  // "Load older", we instead preserve scroll position — see loadOlder().
  useLayoutEffect(() => {
    if (loading || loadingOlder) return;
    const el = scrollRef.current;
    if (!el) return;
    if (prevScrollHeightRef.current != null) {
      // Older-history append: restore scroll position so the user stays
      // on the same message that was at the top before.
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading, loadingOlder]);

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    try {
      const res = await loadMessagesForChat(chatWid, { before: oldest.date, size: 50 });
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const grouped = useMemo(() => groupByDay(messages, isAr), [messages, isAr]);

  return (
    <div className="card p-0 overflow-hidden flex flex-col" style={{ height: '60vh', minHeight: '400px' }}>
      {/* Scrollable region */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* Head: loading or load-older */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-charcoal/50">
            <Loader2 size={18} className="animate-spin me-2" />
            {isAr ? 'جارٍ تحميل الرسائل...' : 'Loading messages…'}
          </div>
        )}
        {!loading && hasMore && (
          <div className="flex justify-center py-2">
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="inline-flex items-center gap-1.5 text-xs text-charcoal/60 hover:text-copper px-3 py-1.5 rounded-full bg-charcoal/5 disabled:opacity-50"
            >
              {loadingOlder ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
              {isAr ? 'تحميل الرسائل الأقدم' : 'Load older messages'}
            </button>
          </div>
        )}

        {error && (
          <div className="card p-3 text-center text-xs text-red-700 bg-red-50 border-red-200">
            {error}
          </div>
        )}

        {!loading && !error && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-charcoal/40">
            <MessageCircle size={32} className="mb-2 opacity-40" />
            <p className="text-sm">
              {isAr ? 'لا توجد رسائل في هذه المحادثة بعد' : 'No messages in this conversation yet'}
            </p>
          </div>
        )}

        {/* Grouped bubbles */}
        {grouped.map((group) => (
          <div key={group.key} className="space-y-2">
            <DaySeparator label={group.label} />
            {group.messages.map((m) => (
              <MessageBubble key={m.id} message={m} isAr={isAr} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center my-2">
      <span className="text-[11px] font-medium text-charcoal/50 bg-cream/80 px-3 py-0.5 rounded-full">
        {label}
      </span>
    </div>
  );
}

interface DayGroup {
  key: string;
  label: string;
  messages: ChatMessage[];
}

function groupByDay(messages: ChatMessage[], isAr: boolean): DayGroup[] {
  const groups: DayGroup[] = [];
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  for (const m of messages) {
    const d = startOfDay(new Date(m.date));
    const key = d.toISOString().slice(0, 10);
    let label: string;
    if (d.getTime() === today.getTime()) {
      label = isAr ? 'اليوم' : 'Today';
    } else if (d.getTime() === yesterday.getTime()) {
      label = isAr ? 'أمس' : 'Yesterday';
    } else {
      label = new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
        day: 'numeric',
        month: 'short',
        year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
      }).format(d);
    }
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.messages.push(m);
    } else {
      groups.push({ key, label, messages: [m] });
    }
  }
  return groups;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

// Stable empty-array reference so selector returns the same identity when
// the chat has no messages yet — prevents unnecessary re-renders.
const EMPTY: ChatMessage[] = [];
