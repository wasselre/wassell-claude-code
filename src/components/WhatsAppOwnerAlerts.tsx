import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { isDeviceSubscribed } from '@/lib/push/client';
import { chatData, chatDisplayName, chatUrl, type ChatData } from './whatsappOwner';

/**
 * App-level watcher that pops an in-app alert the moment a client YOU own sends
 * a WhatsApp message — wherever you are in the app (2026-08-31).
 *
 * It watches the live `records[chats]` slice (kept current app-wide by the
 * RealtimeOrchestrator's `records` channel — the WAHA webhook bumps the chat's
 * last_message_* / unread_count / client_owner on every inbound message). No
 * extra subscription; the same slice the header bell reads.
 *
 * Pairs with:
 *  - WhatsAppOwnerBell — the persistent "clients waiting for you" list. This
 *    component is only the transient ping; the bell is the standing surface.
 *  - The DB push pipeline (chat_messages_enqueue_push → push_outbox → Fly
 *    worker), which delivers the SAME event to the owner's DEVICE (OS-level,
 *    app closed). When this device is push-subscribed we skip the local OS
 *    Notification here so the alert doesn't show twice — the in-app toast still
 *    fires (that one isn't a duplicate of the OS push).
 *
 * This deliberately REPLACES the old "customer replied" branch of
 * SalesNotifications: that fired off a follow-up flipping to `replied`, an
 * indirect proxy for the same inbound message. Watching the chat directly is
 * both more complete (fires for every owned inbound, not only when a follow-up
 * exists) and more actionable (deep-links to the thread, not the follow-up).
 */
export default function WhatsAppOwnerAlerts() {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const language = useAppStore((s) => s.language);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = language === 'ar';

  // chatRecordId → last-seen inbound timestamp; null until the first seeding
  // pass so a page load never fires a burst of alerts for already-there messages.
  const seenRef = useRef<Map<string, string> | null>(null);

  // When this device has a push subscription the server already delivers the
  // `whatsapp_inbound` push to the OS, so ALSO firing a local Notification here
  // would double up. The in-app toast still fires either way.
  const pushOwnsOsNotifications = useRef(false);
  useEffect(() => {
    void isDeviceSubscribed().then((sub) => {
      pushOwnsOsNotifications.current = sub;
    });
  }, []);

  const chatsModel = models.find((m) => m.name === 'chats');
  const clientsModel = models.find((m) => m.name === 'clients');
  const chats = chatsModel ? records[chatsModel.id] : undefined;
  const clients = clientsModel ? records[clientsModel.id] : undefined;

  useEffect(() => {
    if (!chats || !currentUserId) return;

    // The freshest inbound timestamp on a conversation, or '' when the newest
    // message isn't inbound (so a reply I send never counts as "waiting").
    const inboundAt = (d: ChatData): string =>
      d.last_message_flow === 'in' && typeof d.last_message_at === 'string' ? d.last_message_at : '';

    // First pass: seed silently.
    if (seenRef.current === null) {
      const seed = new Map<string, string>();
      for (const r of chats) seed.set(r.id, inboundAt(chatData(r)));
      seenRef.current = seed;
      return;
    }
    const seen = seenRef.current;

    const clientsById = new Map((clients ?? []).map((c) => [c.id, c]));

    for (const r of chats) {
      const d = chatData(r);
      const at = inboundAt(d);
      const prev = seen.get(r.id);
      seen.set(r.id, at);

      // Only my clients, only a genuinely NEW inbound message (a later inbound
      // timestamp than last seen), and only while it's actually unread.
      if (d.client_owner !== currentUserId) continue;
      if (!at || prev === undefined || at <= prev) continue;
      if (typeof d.unread_count === 'number' && d.unread_count <= 0) continue;

      const name = chatDisplayName(d, clientsById, isAr);
      const preview =
        typeof d.last_message_preview === 'string' && d.last_message_preview
          ? d.last_message_preview
          : '';
      const title = isAr ? '💬 رسالة واتساب من عميلك' : '💬 WhatsApp from your client';
      const body = preview ? `${name} — ${preview}` : name;

      addToast(`${title} — ${body}`, 'info');

      if (pushOwnsOsNotifications.current) continue;
      try {
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'default') void Notification.requestPermission();
          if (Notification.permission === 'granted') {
            const n = new Notification(title, { body, tag: `wa-owner-${r.id}` });
            n.onclick = () => {
              window.focus();
              navigate(chatUrl(r.id));
              n.close();
            };
          }
        }
      } catch (err) {
        // Notification API unavailable (unsupported browser / insecure context)
        // — the toast above already surfaced the event.
        console.error('[WhatsAppOwnerAlerts] Notification failed:', err);
      }
    }

    // Drop rows that vanished so the map can't grow without bound.
    if (seen.size > chats.length * 2) {
      const live = new Set(chats.map((r) => r.id));
      for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
    }
  }, [chats, clients, currentUserId, isAr, addToast, navigate]);

  return null;
}
