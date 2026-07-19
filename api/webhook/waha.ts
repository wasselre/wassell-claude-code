/**
 * POST /api/webhook/waha
 *
 * Receives events from the self-hosted WAHA gateway (engine GOWS). Registered
 * PER SESSION when the session is created (api/_lib/waha.ts#createSession) with:
 *   events: ['message', 'message.any', 'message.ack', 'session.status']
 *   hmac:   { key: WAHA_WEBHOOK_SECRET }
 *   retries: exponential ×6
 *
 * Auth: WAHA signs each delivery with `X-Webhook-Hmac` = hex HMAC-SHA512 of the
 * RAW body using WAHA_WEBHOOK_SECRET. We verify it before processing.
 *
 * We process `message.any` ONLY (it is the superset incl. fromMe) and ignore the
 * `message` event to avoid double-counting the same message id. Every message
 * flows through the SAME chatIngest helpers as the Haberchat path, so
 * chat_messages rows / record bumps / reply reconciliation are identical.
 *
 * CRITICAL (eval §4b): GOWS delivers the inbound sender as a LID
 * (`<n>@lid`), phone only in `_data.Info.SenderAlt`. We resolve the phone
 * (resolveWahaPhone) and derive a canonical `<digits>@c.us` chat_wid so the
 * conversation record id (uuidv5) and phone→client matching line up with what
 * the chats-list sync produces.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { logWebhookReceipt } from '../_lib/activityLogger.js';
import {
  upsertChatMessage,
  bumpConversationRecord,
  applyAck,
  uuidV5FromWidSync,
  type ChatMessageRow,
} from '../_lib/chatIngest.js';
import { resolveWahaPhone, type WahaMessageRaw } from '../_lib/waha.js';

export const config = {
  runtime: 'edge',
};

interface WahaEvent {
  id?: string;
  event?: string;
  session?: string;
  timestamp?: number;
  payload?: WahaMessageRaw & { id?: string; ack?: number | string; ackName?: string };
  [k: string]: unknown;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'POST WAHA events here (HMAC-SHA512 signed)' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }

  const secret = process.env.WAHA_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'WAHA_WEBHOOK_SECRET not configured' }, 500);

  // Read the RAW body once — HMAC is computed over these exact bytes.
  const rawBody = await req.text();
  const sig = req.headers.get('x-webhook-hmac');
  const ok = await verifyHmacSha512(rawBody, secret, sig);
  if (!ok) {
    console.warn('[webhook.waha] 401 bad HMAC — sigPresent:', sig !== null);
    return json({ error: 'bad signature' }, 401);
  }

  let event: WahaEvent;
  try {
    event = JSON.parse(rawBody) as WahaEvent;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const type = String(event.event ?? '').toLowerCase();
  const session = String(event.session ?? '');

  // In-instance dedupe on the WAHA event id (retries + any accidental double
  // registration). chat_messages upsert is also idempotent, but this keeps the
  // unread bump / reply RPC from firing twice within a warm instance.
  //
  // The key MUST include the event TYPE: WhatsApp emits an inbound message as
  // BOTH `message` and `message.any` sharing one envelope id, so keying on the
  // id alone let the ignored `message` consume the slot and silently skip the
  // `message.any` that does the actual write — inbound messages never landed
  // while outbound (which only fires `message.any`) worked. Caught live
  // 2026-07-19.
  if (event.id && seenEvent(`${type}:${event.id}`)) {
    return json({ ok: true, dedup: true });
  }

  let handlerError: string | undefined;
  try {
    if (type === 'message.any') {
      await handleMessage(event, session);
    } else if (type === 'message.ack') {
      await handleAck(event);
    } else if (type === 'message' || type === 'session.status') {
      // `message` is a duplicate of `message.any`; session.status has no
      // chat_messages effect (device state is polled by the watchdog). No-op.
    } else {
      console.warn('[webhook.waha] ignoring event type:', type);
    }
  } catch (err) {
    console.error('[webhook.waha] handler error:', err);
    handlerError = err instanceof Error ? err.message : String(err);
    void writeDlq(type, session, event, err).catch((e) => console.error('[webhook.waha] DLQ failed:', e));
  }

  void logWebhookReceipt({
    source: 'waha',
    eventType: type || '(unknown)',
    payload: event,
    status: handlerError ? 'error' : 'success',
    error: handlerError,
  });

  return json({ ok: true });
}

// ─── message.any → chat_messages ─────────────────────────────────────

async function handleMessage(event: WahaEvent, session: string): Promise<void> {
  const p = event.payload;
  if (!p || !p.id) {
    console.warn('[webhook.waha] message.any without payload id');
    return;
  }
  const flow: 'in' | 'out' = p.fromMe ? 'out' : 'in';

  // Counterparty phone → canonical <digits>@c.us chat wid.
  //
  // Primary source is the CHAT ID embedded in the message id
  // ("<true|false>_<chatId>_<hash>"): WAHA sends `to: null` on outbound
  // messages, so relying on `to` silently dropped every message we sent
  // (caught live 2026-07-19). Falls back to from/to, then to the LID->phone
  // SenderAlt resolution for inbound messages whose `from` is a @lid.
  const rawChat =
    chatIdFromMessageId(p.id) ??
    (flow === 'in' ? String(p.from ?? '') : String(p.to ?? ''));
  const counterpartyPhone = phoneFromJid(rawChat) ?? (flow === 'in' ? resolveWahaPhone(p) : null);
  if (!counterpartyPhone) {
    console.warn('[webhook.waha] could not resolve counterparty phone for', p.id, 'rawChat=', rawChat);
    return;
  }
  const digits = counterpartyPhone.replace(/\D/g, '');
  const chatWid = `${digits}@c.us`;

  const mime = p.media?.mimetype ?? null;
  const kind = (p.hasMedia || p.media) ? kindFromMime(mime) : 'text';

  let mediaFileId: string | null = null;
  if (p.media?.url) {
    const fname = p.media.url.split('/').pop() ?? '';
    if (fname) mediaFileId = `wf_${session}/${fname}`;
  }

  const ts = typeof p.timestamp === 'number' ? p.timestamp : (typeof event.timestamp === 'number' ? Math.floor(event.timestamp / 1000) : null);
  const date = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();

  const row: ChatMessageRow = {
    id: p.id,
    chat_wid: chatWid,
    conversation_record_id: uuidV5FromWidSync(chatWid),
    device_id: session,
    flow,
    kind,
    subtype: null,
    body: p.body ?? null,
    from_phone: flow === 'in' ? counterpartyPhone : null,
    to_phone: flow === 'out' ? counterpartyPhone : null,
    ack: mapAck(p.ackName ?? p.ack) ?? (flow === 'out' ? 'sent' : null),
    date,
    media_file_id: mediaFileId,
    media_mime: mime,
    media_size: null,
    media_caption: null,
    reference: null, // WAHA has no send-time reference; optimistic swap uses the send-response wid
    quoted: p.replyTo?.id ? { wid: p.replyTo.id, body: p.replyTo.body ?? null, kind: 'text' } : null,
  };

  const { isNew } = await upsertChatMessage(row);

  await bumpConversationRecord({
    chatWid,
    deviceId: session,
    lastBody: row.body ?? '[media]',
    lastAt: date,
    lastFlow: flow,
    // Only a genuinely new inbound message bumps unread (retry-safe).
    incrementUnread: flow === 'in' && isNew,
    // No reopen push-back for WAHA — chat status is fully CRM-owned.
  });
}

async function handleAck(event: WahaEvent): Promise<void> {
  const p = event.payload;
  const wid = p?.id;
  if (!wid) return;
  const ack = mapAck(p?.ackName ?? p?.ack);
  if (!ack) return;
  await applyAck(wid, ack);
}

// ─── helpers ─────────────────────────────────────────────────────────

function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^\+?(\d+)@c\.us$/) ?? jid.match(/^\+?(\d+)@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : null;
}

/**
 * WhatsApp message ids embed the chat they belong to:
 *   "<true|false>_<chatId>_<hash>[_<participant>]"
 * e.g. "true_966554620315@c.us_3EB0..." → "966554620315@c.us".
 * This is the ONLY field present in both directions (outbound payloads have
 * `to: null`), so it is the primary chat resolver.
 */
function chatIdFromMessageId(id: string | undefined): string | null {
  if (!id) return null;
  const parts = id.split('_');
  return parts.length >= 3 && parts[1]?.includes('@') ? parts[1]! : null;
}

function kindFromMime(mime: string | null): string {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** WAHA ack int/name → the chatIngest ack vocabulary (played folds to read). */
function mapAck(ack: number | string | null | undefined): string | null {
  if (ack == null) return null;
  const s = String(ack).toUpperCase();
  if (s === 'ERROR' || s === '-1') return 'failed';
  if (s === 'PENDING' || s === '0') return 'pending';
  if (s === 'SERVER' || s === '1') return 'sent';
  if (s === 'DEVICE' || s === '2') return 'delivered';
  if (s === 'READ' || s === '3') return 'read';
  if (s === 'PLAYED' || s === '4') return 'read';
  return null;
}

// In-instance recent-event dedupe (bounded ring).
const seen = new Set<string>();
const seenOrder: string[] = [];
function seenEvent(id: string): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 2000) {
    const evicted = seenOrder.shift();
    if (evicted) seen.delete(evicted);
  }
  return false;
}

async function verifyHmacSha512(body: string, secret: string, headerHex: string | null): Promise<boolean> {
  if (!headerHex) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const computed = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time-ish compare.
  const a = computed.toLowerCase();
  const b = headerHex.trim().toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function writeDlq(eventType: string, session: string, payload: unknown, err: unknown): Promise<void> {
  const supa = getServiceSupabase();
  const { error } = await supa.from('haberchat_webhook_dlq').insert({
    event_type: `waha:${eventType}`,
    device_wid: session || null,
    payload: payload as Record<string, unknown>,
    error_class: err instanceof Error ? err.name : 'unknown',
    error_message: err instanceof Error ? err.message : String(err),
  });
  if (error) console.error('[webhook.waha] DLQ insert error:', error.message);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
