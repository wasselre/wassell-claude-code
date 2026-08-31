import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { chatData, chatDisplayName, chatUrl, isOwnedWaiting } from './whatsappOwner';
import type { AppRecord } from '@/types';

/**
 * Header bell: the persistent "clients waiting for you" surface (2026-08-31).
 *
 * Lists every conversation the current user OWNS whose customer messaged last
 * and is still unread — derived live from the `records[chats]` slice (the same
 * slice WhatsAppOwnerAlerts watches; kept current app-wide by the realtime
 * `records` channel). Opening a row marks it read and deep-links to the thread,
 * which drops it from the list. No new table — the badge is a pure projection of
 * the chats already in memory.
 *
 * The dropdown is portalled to <body> and positioned off the button's rect: the
 * header is `sticky` with a backdrop blur, and an absolutely-positioned panel
 * inside it renders under later stacking contexts.
 */

function timeAgo(iso: string | undefined, isAr: boolean): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return isAr ? 'الآن' : 'now';
  if (mins < 60) return isAr ? `قبل ${mins} د` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return isAr ? `قبل ${hours} س` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return isAr ? 'أمس' : '1d';
  return isAr ? `قبل ${days} ي` : `${days}d`;
}

export default function WhatsAppOwnerBell() {
  const language = useAppStore((s) => s.language);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const markChatAsRead = useAppStore((s) => s.markChatAsRead);
  const navigate = useNavigate();
  const isAr = language === 'ar';

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const chatsModel = models.find((m) => m.name === 'chats');
  const clientsModel = models.find((m) => m.name === 'clients');
  const chats = chatsModel ? records[chatsModel.id] : undefined;
  const clients = clientsModel ? records[clientsModel.id] : undefined;

  const waiting = useMemo(() => {
    if (!chats || !currentUserId) return [] as AppRecord[];
    return chats
      .filter((r) => isOwnedWaiting(r, currentUserId))
      .sort((a, b) => {
        const at = chatData(a).last_message_at ?? '';
        const bt = chatData(b).last_message_at ?? '';
        return bt.localeCompare(at); // newest first
      });
  }, [chats, currentUserId]);

  const clientsById = useMemo(
    () => new Map((clients ?? []).map((c) => [c.id, c])),
    [clients],
  );

  const count = waiting.length;

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rtl = document.documentElement.dir === 'rtl';
    setPos(
      rtl
        ? { top: rect.bottom + 8, left: Math.max(8, rect.left) }
        : { top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) },
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openChat = (rec: AppRecord): void => {
    const d = chatData(rec);
    if (d.wid) markChatAsRead(d.wid);
    setOpen(false);
    navigate(chatUrl(rec.id));
  };

  return (
    <span className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="pill relative hover:bg-white/80 transition-colors"
        aria-label={isAr ? 'عملاء بانتظار الرد' : 'Clients waiting for a reply'}
        title={isAr ? 'عملاء بانتظار الرد' : 'Clients waiting for a reply'}
      >
        <MessageCircle size={15} className="text-charcoal/70" />
        {count > 0 && (
          <span className="absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full bg-terracotta text-white text-[11px] font-bold leading-[18px] text-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            dir={isAr ? 'rtl' : 'ltr'}
            className="fixed z-50 w-80 max-w-[calc(100vw-16px)] rounded-2xl bg-white shadow-xl ring-1 ring-sand/60 overflow-hidden"
            style={pos}
            role="dialog"
            aria-label={isAr ? 'عملاء بانتظار الرد' : 'Clients waiting for a reply'}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-sand/40">
              <h4 className="font-bold text-chocolate text-sm">
                {isAr ? 'بانتظار ردّك' : 'Waiting for your reply'}
              </h4>
              {count > 0 && (
                <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-terracotta/15 text-terracotta text-xs font-bold leading-5 text-center">
                  {count}
                </span>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {count === 0 ? (
                <div className="px-4 py-6 text-sm text-charcoal/50 text-center">
                  {isAr ? 'لا يوجد عملاء بانتظار الرد.' : 'No clients waiting for a reply.'}
                </div>
              ) : (
                waiting.map((rec) => {
                  const d = chatData(rec);
                  const name = chatDisplayName(d, clientsById, isAr);
                  const preview = d.last_message_preview ?? '';
                  return (
                    <button
                      key={rec.id}
                      type="button"
                      onClick={() => openChat(rec)}
                      className="w-full flex items-start gap-2 px-4 py-3 text-start hover:bg-cream-light/70 border-b border-sand/25 last:border-0 transition-colors"
                    >
                      <span className="mt-0.5 shrink-0 w-2 h-2 rounded-full bg-terracotta" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-bold text-charcoal text-sm truncate">{name}</span>
                          <span className="text-[11px] text-charcoal/40 shrink-0">
                            {timeAgo(d.last_message_at, isAr)}
                          </span>
                        </span>
                        {preview && (
                          <span className="block text-xs text-charcoal/55 truncate mt-0.5">{preview}</span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
