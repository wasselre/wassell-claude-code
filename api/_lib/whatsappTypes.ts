/**
 * The shared WhatsApp contract: the shapes the API, the browser client and the
 * store all agree on, independent of which gateway produced them.
 *
 * These lived in `api/_lib/haberchat.ts` because Haberchat was once the only
 * provider. That adapter is retired (2026-07-28, WA-28), but the shapes are not
 * Haberchat's — they are ours, and WAHA already maps onto them. Keeping them in
 * a provider file meant deleting a dead provider would have taken the type
 * contract with it.
 *
 * The `Haberchat*` names are kept as aliases at the bottom. Renaming them across
 * the browser client, the store and the proxies is a cosmetic change with a wide
 * blast radius, and it is not what the retirement is about.
 */

/** A connected WhatsApp number. Under WAHA the `id` is the SESSION NAME. */
export interface WhatsappDevice {
  id: string;
  phone: string;              // E.164 of the WhatsApp number
  name?: string | null;
  status?: 'online' | 'offline' | 'disconnected' | 'pending' | string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** One conversation. */
export interface WhatsappChat {
  wid: string;                // conversation id, e.g. "966555...@c.us"
  kind: 'user' | 'group' | 'channel' | string;
  name: string | null;
  phone: string | null;       // extracted from wid/contact when available
  status?: 'active' | 'resolved' | 'archived' | 'muted' | string;
  ownerAgentId?: string | null;
  labels?: string[];
  unreadCount?: number;
  lastMessageAt?: string | null;  // ISO
  lastMessagePreview?: string | null;
  meta?: Record<string, unknown>;
}

/** One message, in the shape `chat_messages` stores. */
export interface WhatsappMessage {
  wid: string;                // message id
  chatWid: string;            // parent conversation id
  flow: 'in' | 'out';
  kind: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'template' | 'contact' | 'poll' | 'interactive' | string;
  /** Discriminates system events (e.g. `biz_privacy_mode_init_fb` on a
   *  `notification_template`) so the UI can render a localized system notice
   *  for body-less system messages. */
  subtype: string | null;
  body: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  ack: 'failed' | 'pending' | 'sent' | 'delivered' | 'read' | 'played' | null;
  date: string;               // ISO
  mediaFileId: string | null;
  mediaMime: string | null;
  mediaSize: number | null;
  mediaCaption: string | null;
  reference: string | null;
  quoted: { wid: string; body: string | null; kind: string } | null;
}

/**
 * A gateway failure carrying the upstream HTTP status.
 *
 * The `api/haberchat/*` proxies branch on `err instanceof HaberchatError` to map
 * a gateway status onto their own response, so the class identity matters more
 * than the name.
 */
export class WhatsappGatewayError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

// ─── legacy names ────────────────────────────────────────────────────────────
// Same objects, older names. Kept so the retirement is a provider removal and
// not a rename sweep across the browser client, the store and every proxy.
export type HaberchatDevice = WhatsappDevice;
export type HaberchatChat = WhatsappChat;
export type HaberchatMessage = WhatsappMessage;
export { WhatsappGatewayError as HaberchatError };
