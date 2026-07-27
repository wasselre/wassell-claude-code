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
import { resolveWahaCounterpartyPhone, resolveLidToPhone, type WahaMessageRaw } from '../_lib/waha.js';

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

  // A session we have no active number for is a gateway nobody registered —
  // in practice an old companion device still linked to the same WhatsApp
  // account after a re-pair, reporting every message a second time under its
  // own addressing mode. Ingest is now duplicate-safe (chatIngest merges on the
  // message hash), so this does NOT drop the event; it exists so the operator
  // can SEE the stray gateway instead of inferring it from doubled rows a week
  // later. Diagnosed exactly that way on 2026-07-27.
  void warnIfForeignSession(session);

  let handlerError: string | undefined;
  try {
    if (type === 'message.any') {
      await handleMessage(event, session);
    } else if (type === 'message.ack') {
      await handleAck(event);
    } else if (type === 'message.reaction') {
      await handleReaction(event, session);
    } else if (type === 'message.revoked') {
      await handleRevoked(event);
    } else if (type === 'message.edited') {
      await handleEdited(event);
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
  // Resolution ladder: plain @c.us → nested SenderAlt → WAHA's LID map. The
  // last step is required: a real inbound arrives identified ONLY by LID with
  // no SenderAlt (verified live 2026-07-19).
  let counterpartyPhone = phoneFromJid(rawChat) ?? resolveWahaCounterpartyPhone(p, flow);
  if (!counterpartyPhone && rawChat.endsWith('@lid')) {
    counterpartyPhone = await resolveLidToPhone(session, rawChat);
  }
  // NEVER drop a message we cannot identify. This used to `return`, which threw
  // away every message from a LID-only contact — WhatsApp's LID map is populated
  // by the contact sync at pairing time and covers a minority of chats (16 of
  // 264 after the 2026-07-24 re-pair), so real client messages vanished with
  // nothing but a console warning. Two of them were a client standing at a
  // property asking who would open the door (2026-07-25).
  //
  // Fall back to keying the conversation by its LID. The thread is preserved and
  // visible; only the phone link is missing, and it heals by itself once the LID
  // map fills in. Losing the message is never the better trade.
  const digits = counterpartyPhone?.replace(/\D/g, '') ?? '';
  const chatWid = digits ? `${digits}@c.us` : rawChat;
  if (!counterpartyPhone) {
    if (!rawChat) {
      console.error('[webhook.waha] no chat identity at all for', p.id, '— cannot store');
      return;
    }
    console.warn('[webhook.waha] unresolved phone for', p.id, '— storing under LID', rawChat);
  }

  const mime = p.media?.mimetype ?? null;
  const kind = (p.hasMedia || p.media) ? kindFromMime(mime, p._data?.Info?.MediaType) : 'text';

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
    // Ack is a delivery receipt for messages WE sent. NOWEB reports -1/"ERROR"
    // on INBOUND messages, which rendered delivered client messages as red
    // "failed" bubbles. Only trust ack on outbound. (Live 2026-07-26.)
    ack: flow === 'out' ? (mapAck(p.ackName ?? p.ack) ?? 'sent') : null,
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

  // AI auto-reply (outside working hours only). The RPC is the single gate —
  // it decides enabled / working-hours / human-active / reply-cap and debounces
  // to ONE live job per chat, so a customer firing three messages produces one
  // session that sees all three. Returns null when it declines.
  //
  // Fire-and-forget by design: this webhook must stay fast (WAHA retries on
  // slow responses) and a missed auto-reply is far better than a duplicated
  // one. The actual reply is written by a real Claude Code session on the
  // wa-agent worker, not here.
  // Requires a phone: the agent qualifies the lead against the client record,
  // which is matched by number. A LID-only chat has nothing to match on, so
  // storing the message (above) is the whole job here.
  if (flow === 'in' && isNew && counterpartyPhone) {
    try {
      const { error } = await getServiceSupabase().rpc('whatsapp_ai_enqueue', {
        p_chat_wid: chatWid,
        p_chat_record_id: uuidV5FromWidSync(chatWid),
        p_phone: counterpartyPhone,
        p_device_id: session,
        p_trigger_message: row.body ?? null,
      });
      if (error) console.error('[waha-webhook] whatsapp_ai_enqueue failed:', error.message);
    } catch (err) {
      console.error('[waha-webhook] whatsapp_ai_enqueue threw:', err);
    }
  }
}

/**
 * message.reaction → a `reaction` row pointing at the target message.
 *
 * Payload: `{ payload: { from, fromMe?, reaction: { text, messageId } } }`.
 * An EMPTY `text` means the reaction was REMOVED. Reactions carry no id of their
 * own, so the row id is synthesized per (target, sender) — re-reacting upserts
 * over the previous emoji instead of stacking rows.
 */
async function handleReaction(event: WahaEvent, session: string): Promise<void> {
  const p = event.payload as (WahaMessageRaw & {
    reaction?: { text?: string | null; messageId?: string | null };
  }) | undefined;
  const targetId = p?.reaction?.messageId;
  if (!p || !targetId) return;

  const emoji = (p.reaction?.text ?? '').trim();
  const flow: 'in' | 'out' = p.fromMe ? 'out' : 'in';

  // The conversation is WHO REACTED (payload.from) — NOT the target message id.
  // WhatsApp writes the target id from the REACTOR's perspective
  // ("false_<ourOwnLid>_<hash>"), so deriving the chat from it resolved to our
  // OWN number and filed every reaction into the self-chat (live 2026-07-19).
  const rawChat = String(p.from ?? '') || (chatIdFromMessageId(targetId) ?? '');
  let counterpartyPhone = phoneFromJid(rawChat) ?? resolveWahaCounterpartyPhone(p, flow);
  if (!counterpartyPhone && rawChat.endsWith('@lid')) {
    counterpartyPhone = await resolveLidToPhone(session, rawChat);
  }
  if (!counterpartyPhone) {
    console.warn('[webhook.waha] reaction: could not resolve chat for target', targetId, 'rawChat=', rawChat);
    return;
  }
  const chatWid = `${counterpartyPhone.replace(/\D/g, '')}@c.us`;
  const rowId = `reaction_${targetId}_${flow === 'out' ? 'me' : counterpartyPhone.replace(/\D/g, '')}`;

  // Reaction REMOVED — drop the stored reaction rather than leaving a stale one.
  if (!emoji) {
    const supa = getServiceSupabase();
    const { error } = await supa.from('chat_messages').delete().eq('id', rowId);
    if (error) console.error('[webhook.waha] reaction delete failed:', error.message);
    return;
  }

  const ts = typeof p.timestamp === 'number' ? p.timestamp : Math.floor(Date.now() / 1000);
  await upsertChatMessage({
    id: rowId,
    chat_wid: chatWid,
    conversation_record_id: uuidV5FromWidSync(chatWid),
    device_id: session,
    flow,
    kind: 'reaction',
    subtype: null,
    body: emoji,
    from_phone: flow === 'in' ? counterpartyPhone : null,
    to_phone: flow === 'out' ? counterpartyPhone : null,
    ack: null,
    date: new Date(ts * 1000).toISOString(),
    media_file_id: null,
    media_mime: null,
    media_size: null,
    media_caption: null,
    reference: null,
    // Points at the message that was reacted to.
    quoted: { wid: targetId, body: null, kind: 'text' },
  });
  // Deliberately NOT bumping the conversation record: a reaction should not
  // steal the last-message preview or raise an unread badge.
}

/**
 * message.revoked → the customer DELETED a message ("deleted for everyone").
 *
 * Payload: `{ payload: { revokedMessageId, after: { id } } }`. We keep the row
 * (deleting it would silently rewrite history and hide that a deletion
 * happened) and re-kind it to 'revoked', which the bubble already renders as a
 * muted "message deleted" notice. The original body is cleared — the customer
 * asked for it to be withdrawn.
 */
async function handleRevoked(event: WahaEvent): Promise<void> {
  const p = event.payload as { revokedMessageId?: string | null } | undefined;
  const targetId = p?.revokedMessageId;
  if (!targetId) return;
  const supa = getServiceSupabase();
  const { error } = await supa
    .from('chat_messages')
    .update({ kind: 'revoked', body: null, media_file_id: null })
    .eq('id', targetId);
  if (error) console.error('[webhook.waha] revoke update failed:', error.message);
}

/**
 * message.edited → the customer EDITED a message. Payload:
 * `{ payload: { editedMessageId, body } }`. Update the stored text in place so
 * the thread shows what the message actually says now.
 */
async function handleEdited(event: WahaEvent): Promise<void> {
  const p = event.payload as { editedMessageId?: string | null; body?: string | null } | undefined;
  const targetId = p?.editedMessageId;
  if (!targetId) return;
  const supa = getServiceSupabase();
  const { error } = await supa
    .from('chat_messages')
    .update({ body: p?.body ?? null })
    .eq('id', targetId);
  if (error) console.error('[webhook.waha] edit update failed:', error.message);
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

/**
 * Media kind. WhatsApp stickers are `image/webp` and WAHA additionally reports
 * `_data.Info.MediaType === 'sticker'` — without this they were stored as plain
 * images and lost the sticker rendering the UI already supports (verified live
 * 2026-07-19: an inbound sticker arrived as image/webp).
 */
function kindFromMime(mime: string | null, mediaType?: string | null): string {
  if (mediaType && mediaType.toLowerCase() === 'sticker') return 'sticker';
  if (!mime) return 'document';
  if (mime === 'image/webp') return 'sticker';
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

/**
 * Warn once per session per warm instance when events arrive from a WAHA
 * session that has no active `whatsapp_numbers` row. Fire-and-forget and
 * failure-tolerant: this is diagnostics, and must never delay or fail ingest.
 */
const warnedSessions = new Set<string>();
async function warnIfForeignSession(session: string): Promise<void> {
  if (!session || warnedSessions.has(session)) return;
  warnedSessions.add(session);
  try {
    const { data } = await getServiceSupabase()
      .from('whatsapp_numbers')
      .select('is_active')
      .eq('device_id', session)
      .maybeSingle();
    if (!(data as { is_active?: boolean } | null)?.is_active) {
      console.warn(
        `[webhook.waha] events from UNREGISTERED session "${session}" — a stray gateway is still linked to this WhatsApp account. Unlink it (WhatsApp → Linked Devices) or add it to whatsapp_numbers.`,
      );
    }
  } catch (err) {
    console.error('[webhook.waha] foreign-session check failed:', err instanceof Error ? err.message : String(err));
  }
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
