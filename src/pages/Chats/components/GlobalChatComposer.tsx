import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { normalizePhone } from '@/lib/phone';
import { resolveClientLink, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import StartChatModal from './StartChatModal';
import ChatThreadModal from './ChatThreadModal';
import { recordToPickedClient, resolveClientSlugs, type PickedClient } from './ClientPicker';

/**
 * App-level WhatsApp composer host (mounted once in AppLayout). Any phone
 * WhatsApp action — the inline phone-cell icon, the Follow-up Workspace button,
 * etc. — calls `openChatComposer({ phone, clientRecordId })` on the store, and
 * this single host shows the Start-Chat popup and, after the first message is
 * sent, the conversation thread popup — WITHOUT navigating, so the caller stays
 * exactly where they were. It pre-connects to the matching client (explicit id
 * first, else a phone match), falling back to the manual-number flow.
 */
export default function GlobalChatComposer() {
  const target = useAppStore((s) => s.chatComposerTarget);
  const closeChatComposer = useAppStore((s) => s.closeChatComposer);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const isAr = useAppStore((s) => s.language === 'ar');
  const [threadId, setThreadId] = useState<string | null>(null);

  const initialClient = useMemo<PickedClient | null>(() => {
    if (!target) return null;
    const clientsModel = models.find((m) => m.name === 'clients');
    if (!clientsModel) return null;
    const clients = records[clientsModel.id] ?? [];
    const slugs = resolveClientSlugs(clientsModel);
    // Explicit client id wins; otherwise resolve by a matching phone (same
    // canonicalized matcher startNewChat uses to auto-link).
    if (target.clientRecordId) {
      const rec = clients.find((r) => r.id === target.clientRecordId);
      if (rec) return recordToPickedClient(rec, slugs, isAr);
    }
    if (target.phone) {
      const e164 = normalizePhone(target.phone);
      const id = e164 ? resolveClientLink(e164, clients, phoneFieldSlugs(clientsModel)) : null;
      const rec = id ? clients.find((r) => r.id === id) : null;
      if (rec) return recordToPickedClient(rec, slugs, isAr);
    }
    return null;
  }, [target, models, records, isAr]);

  return (
    <>
      {target && (
        <StartChatModal
          onClose={closeChatComposer}
          initialClient={initialClient}
          initialPhone={target.phone}
          onSent={(id) => { closeChatComposer(); setThreadId(id); }}
        />
      )}
      {threadId && (
        <ChatThreadModal recordId={threadId} onClose={() => setThreadId(null)} />
      )}
    </>
  );
}
