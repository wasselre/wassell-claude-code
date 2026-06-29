import { useMemo, useState, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { normalizePhoneDigits } from '@/lib/haberchat/normalize';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import ChatThreadModal from '@/pages/Chats/components/ChatThreadModal';
import { resolveClientSlugs, recordToPickedClient, type PickedClient } from '@/pages/Chats/components/ClientPicker';
import type { AppRecord } from '@/types';

interface ClientWhatsApp {
  /** Open the in-app WhatsApp popup for a client: jump into the existing
   *  conversation thread if one exists, else open the new-chat composer. */
  openWhatsApp: (clientId: string, phone: string | null) => void;
  /** Render this once in the consumer — the chat modals. */
  whatsAppModals: ReactNode;
}

/**
 * Shared in-app WhatsApp launcher for the Clients surfaces — the SAME flow the
 * Follow-up Workspace uses (existing-conversation popup, or the composer that
 * opens the popup on send). Centralized here so the list rows and the Client 360
 * header reuse the existing chat components instead of duplicating them.
 */
export function useClientWhatsApp(): ClientWhatsApp {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const isAr = useAppStore((s) => s.language === 'ar');

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats') ?? null, [models]);
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);

  const [threadId, setThreadId] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ client: PickedClient | null; phone: string } | null>(null);

  const findExistingChat = (clientId: string, phone: string | null): AppRecord | null => {
    if (!chatsModel) return null;
    const chatRecs = records[chatsModel.id] ?? [];
    const linked = chatRecs.find((r) => (r.data as Record<string, unknown>).client_link === clientId);
    if (linked) return linked;
    const target = normalizePhoneDigits(phone);
    if (target.length < 6) return null;
    return (
      chatRecs.find((r) => {
        const p = normalizePhoneDigits((r.data as Record<string, unknown>).phone as string | null | undefined);
        return p.length >= 6 && (p === target || p.endsWith(target) || target.endsWith(p));
      }) ?? null
    );
  };

  const openWhatsApp = (clientId: string, phone: string | null) => {
    const existing = findExistingChat(clientId, phone);
    if (existing) {
      setThreadId(existing.id);
      return;
    }
    const clientRec = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null : null;
    const picked = clientRec ? recordToPickedClient(clientRec, resolveClientSlugs(clientsModel ?? undefined), isAr) : null;
    setComposer({ client: picked, phone: phone ?? '' });
  };

  const whatsAppModals = (
    <>
      {composer && (
        <StartChatModal
          onClose={() => setComposer(null)}
          initialClient={composer.client}
          initialPhone={composer.phone}
          onSent={(chatId) => {
            setComposer(null);
            setThreadId(chatId);
          }}
        />
      )}
      {threadId && <ChatThreadModal recordId={threadId} onClose={() => setThreadId(null)} />}
    </>
  );

  return { openWhatsApp, whatsAppModals };
}
