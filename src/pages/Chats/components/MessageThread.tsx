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
  const retryChatMessage = useAppStore((s) => s.retryChatMessage);

  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  // Whether the user is anchored at the newest message. While pinned, any
  // content growth (new messages, media blobs resolving from their fixed-
  // height skeletons into taller images/videos) re-scrolls to the bottom.
  // Scrolling up unpins so reading history is never yanked away.
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  // Initial load on mount / chat switch. Resets loading / error state so a
  // page reused via React key doesn't keep stale flags.
  //
  // INSTANT PAINT (2026-08-24): loadMessagesForChat hydrates the thread
  // synchronously (in-memory copy from an earlier open, else the localStorage
  // thread cache) BEFORE its network round-trip — so by the time the call
  // returns control to us via the microtask below, a previously-seen thread is
  // already in the store. The spinner shows only when there is genuinely
  // nothing to paint (first-ever open of a thread on this device); otherwise
  // the messages render immediately and the fetch corrects them quietly —
  // the native-messaging-app model.
  useEffect(() => {
    pinnedRef.current = true;
    lastScrollTopRef.current = 0;
    setError(null);
    const p = loadMessagesForChat(chatWid, { size: 50 });
    // The synchronous hydration inside the call above has already run.
    setLoading((useAppStore.getState().chatMessages[chatWid] ?? []).length === 0);
    void (async () => {
      try {
        const res = await p;
        setHasMore(res.hasMore);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [chatWid, loadMessagesForChat]);

  // Scroll-to-bottom on fresh load / new messages while pinned. When we
  // append older history via "Load older", we instead preserve scroll
  // position — see loadOlder().
  useLayoutEffect(() => {
    if (loading || loadingOlder) return;
    const el = scrollRef.current;
    if (!el) return;
    if (prevScrollHeightRef.current != null) {
      // Older-history append: restore scroll position so the user stays
      // on the same message that was at the top before.
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
    } else if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading, loadingOlder]);

  // Content settles AFTER the initial scroll-to-bottom: media bubbles swap
  // fixed-height skeletons for the real (taller) image/video when their
  // authenticated blob fetch resolves, and a fresh-cache load reflows every
  // bubble when the Amiri webfont arrives. None of that touches `messages`,
  // so the effect above never re-runs and the thread ends up scrolled short
  // of the newest message. Re-anchor to the bottom whenever the content OR
  // the container resizes, as long as the user is pinned there.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && prevScrollHeightRef.current == null) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(content);
    // The container too: the card is 60vh, so a window resize changes
    // clientHeight without any content change.
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Unpin ONLY on an upward scroll (the user moving away from the bottom).
  // Judging by distance alone misfired: content growing below the viewport
  // increases the distance without any user intent, and a scroll event from
  // a browser-side adjustment would then read as "user scrolled up" and
  // block the ResizeObserver from re-anchoring (live bug 2026-07-04 — a
  // hard refresh re-downloaded Amiri, the post-pin reflow fired exactly
  // such an event, and the newest message stayed below the fold).
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 60) {
      pinnedRef.current = true;
    } else if (el.scrollTop < prev - 1) {
      pinnedRef.current = false;
    }
  };

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

  // Reactions are stored as their own rows pointing at the message they were
  // placed on (`quoted.wid`). They must NOT render as standalone bubbles —
  // split them out and hand each target message its emojis so the bubble can
  // show them as a badge, the way WhatsApp does.
  const { conversational, reactionsByTarget } = useMemo(() => {
    const byTarget = new Map<string, ChatMessage[]>();
    const rest: ChatMessage[] = [];
    for (const m of messages) {
      const targetWid = m.kind === 'reaction' ? m.quoted?.wid : undefined;
      if (targetWid) {
        const list = byTarget.get(targetWid);
        if (list) list.push(m);
        else byTarget.set(targetWid, [m]);
      } else if (m.kind !== 'reaction') {
        rest.push(m);
      }
      // A reaction with no resolvable target is dropped rather than shown as a
      // stray bubble — it carries no meaning on its own.
    }
    return { conversational: rest, reactionsByTarget: byTarget };
  }, [messages]);

  const grouped = useMemo(() => groupByDay(conversational, isAr), [conversational, isAr]);

  return (
    // h-full: fill whatever the parent allocates. ChatDetail wraps this in a
    // flex-1 min-h-0 overflow-hidden slot BELOW the conversation header — the
    // header's height varies with the linked client's preference chips. A
    // fixed height here (the old 60vh) overflowed that slot whenever the
    // header was tall, and overflow-hidden CLIPPED the bottom of this card —
    // hiding the newest message even though the thread was scrolled to the
    // bottom (live bug 2026-07-04, root cause of "the last message doesn't
    // show").
    // Mobile: a plain full-bleed scroll area (the thread IS the screen).
    // Desktop (md+): the framed card, matching the rest of the split view.
    <div className="bg-white overflow-hidden flex flex-col h-full min-h-0 md:rounded-2xl md:border md:border-sand/20 md:shadow-sm">
      {/* Scrollable region. The inner div exists so the ResizeObserver can
          watch content height — observing the scroll container itself only
          reports its border box. overflow-anchor:none disables the
          browser's native scroll anchoring: this component IS the anchoring
          authority (pin-to-bottom + the load-older restore), and Chrome's
          own adjustments during content reflow fired scroll events that
          read as user scrolls and broke the pin. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={contentRef} className="px-4 py-3 space-y-3">
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
              <MessageBubble
                key={m.id}
                message={m}
                isAr={isAr}
                reactions={reactionsByTarget.get(m.id)}
                // Bound to THIS conversation's wid, so a retry can never land
                // in a chat the user has since switched to.
                onRetry={m.flow === 'out' ? () => void retryChatMessage(chatWid, m.id) : undefined}
              />
            ))}
          </div>
        ))}
        </div>
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
