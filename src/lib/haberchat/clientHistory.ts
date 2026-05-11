import type { AppRecord, ChatMessage } from '@/types';

export interface ClientChatRecord {
  recordId: string;
  chatWid: string;
  deviceId: string | null;
  contactPhone: string | null;
  contactName: string | null;
}

export interface SelectClientChatMessagesResult {
  /** Flat, ascending-by-date message list across every chat linked to the client. */
  messages: ChatMessage[];
  /** Per-chat metadata for badges / device labels. */
  chatRecords: ClientChatRecord[];
  /** chat_wid → chatRecord lookup so renderers can label each bubble with its source device. */
  chatRecordsByWid: Record<string, ClientChatRecord>;
}

interface SelectInput {
  clientId: string;
  /** Chats model id — pre-resolved by the caller via `models.find(m => m.name === 'chats')`. */
  chatsModelId: string | null;
  /** State.records keyed by model id. */
  records: Record<string, AppRecord[]>;
  /** State.chatMessages keyed by chat_wid. */
  chatMessages: Record<string, ChatMessage[]>;
}

/**
 * Aggregates every chat message exchanged with a client, regardless of which
 * Haberchat device (i.e. which of OUR phone numbers) the conversation went
 * through. The same client may have several `chats` records — one per
 * (our_device, their_phone) pair — and this selector flattens them into one
 * chronological thread for the Client 360 view.
 *
 * Pure: derives entirely from the `records` and `chatMessages` slices passed
 * in; no I/O, no subscriptions. Caller is responsible for kicking off
 * `subscribeToAllChats()` once on mount so live messages flow into the
 * `chatMessages` slice that this selector reads.
 */
export function selectClientChatMessages(input: SelectInput): SelectClientChatMessagesResult {
  const { clientId, chatsModelId, records, chatMessages } = input;
  if (!chatsModelId || !clientId) {
    return { messages: [], chatRecords: [], chatRecordsByWid: {} };
  }

  const allChats = records[chatsModelId] ?? [];
  const chatRecords: ClientChatRecord[] = [];
  for (const r of allChats) {
    const data = r.data as Record<string, unknown>;
    if (data.client_link !== clientId) continue;
    const wid = typeof data.wid === 'string' ? data.wid : null;
    if (!wid) continue;
    chatRecords.push({
      recordId: r.id,
      chatWid: wid,
      deviceId: typeof data.device_id === 'string' ? data.device_id : null,
      contactPhone: typeof data.phone === 'string' ? data.phone : null,
      contactName: typeof data.name === 'string' ? data.name : null,
    });
  }

  const chatRecordsByWid: Record<string, ClientChatRecord> = {};
  const byId = new Map<string, ChatMessage>();
  for (const cr of chatRecords) {
    chatRecordsByWid[cr.chatWid] = cr;
    const slice = chatMessages[cr.chatWid] ?? [];
    for (const m of slice) byId.set(m.id, m);
  }

  const messages = Array.from(byId.values()).sort((a, b) => a.date.localeCompare(b.date));
  return { messages, chatRecords, chatRecordsByWid };
}
