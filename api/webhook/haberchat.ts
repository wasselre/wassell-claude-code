/**
 * POST /api/webhook/haberchat
 *
 * Receives events from Haberchat's webhook system. Registered once per
 * environment via:
 *   POST https://api.haber.chat/v1/webhooks
 *   Body: {
 *     url: "https://<prod-url>/api/webhook/haberchat",
 *     events: ["message:in:new","message:out:new","message:out:ack","chat:update"],
 *     headers: { "X-Webhook-Secret": "<HABERCHAT_WEBHOOK_SECRET value>" }
 *   }
 *
 * On every event:
 *  1. Verify X-Webhook-Secret header against env (401 on mismatch).
 *  2. Write/update the chat_messages row via service-role Supabase.
 *  3. Optionally update the parent chats record (last_message_preview,
 *     last_message_at, unread_count bump on inbound).
 *  4. Always return 200 + {ok:true} when auth passes, so Haberchat doesn't
 *     retry. Errors inside individual event branches are logged + swallowed.
 *
 * The live SPA's Supabase Realtime subscription on `chat_messages` picks
 * up the insert / update and the browser UI reacts without a reload.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { logWebhookReceipt } from '../_lib/activityLogger.js';
import { patchChat } from '../_lib/haberchat.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    // Plain GET so the admin can sanity-check the endpoint exists without
    // authenticating. Returns a minimal heartbeat.
    return json({ ok: true, hint: 'POST events here with X-Webhook-Secret' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }

  // 1. Signature check ──────────────────────────────────────────────
  // Haberchat's recommended pattern is "?secret=..." in the URL (their
  // own UI hints at this). Some integrations use custom headers — we
  // accept either so the admin can pick whichever their Haberchat plan
  // supports. Constant-time comparison isn't critical here since the
  // secret rotates out of band.
  const expected = process.env.HABERCHAT_WEBHOOK_SECRET;
  if (!expected) {
    return json({ error: 'HABERCHAT_WEBHOOK_SECRET not configured' }, 500);
  }
  const url = new URL(req.url);
  const sent =
    req.headers.get('x-webhook-secret') ??
    url.searchParams.get('secret') ??
    url.searchParams.get('token') ??
    '';
  if (sent !== expected) {
    return json({ error: 'bad secret' }, 401);
  }

  // 2. Parse payload ────────────────────────────────────────────────
  let event: WebhookEvent;
  try {
    event = (await req.json()) as WebhookEvent;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const type = String(event.type ?? event.event ?? '').toLowerCase();
  const deviceId =
    (event.device as string | undefined) ??
    (event.deviceId as string | undefined) ??
    (event.data?.device as string | undefined) ??
    '';

  let handlerError: string | undefined;
  try {
    if (type === 'message:in:new' || type === 'message:out:new') {
      await handleNewMessage(event, deviceId, type === 'message:in:new' ? 'in' : 'out');
    } else if (type === 'message:out:ack' || type === 'message:ack') {
      await handleAck(event);
    } else if (type === 'chat:update') {
      await handleChatUpdate(event, deviceId);
    } else {
      // Log unknown event types but don't fail — future Haberchat events
      // land here harmlessly until we add a handler.
      console.warn('[webhook] ignoring unsupported event type:', type);
    }
  } catch (err) {
    // Swallow per-event errors so one bad payload doesn't cause Haberchat
    // to retry indefinitely. Still visible in the Vercel function log.
    console.error('[webhook] handler error:', err);
    handlerError = err instanceof Error ? err.message : String(err);

    // Audit fix M7: persist the failed event to a DLQ so an admin can
    // triage rather than discovering the data loss six weeks later. We
    // run this fire-and-forget and never let a DLQ insert error
    // propagate — the original handler error is what mattered.
    void writeHaberchatDlq({
      eventType: type,
      deviceWid: deviceId || null,
      payload: event,
      errorClass: err instanceof Error ? err.name : 'unknown',
      errorMessage: handlerError,
    }).catch((dlqErr) => {
      console.error('[webhook] DLQ insert failed:', dlqErr);
    });
  }

  // Fire-and-forget audit-log insert. We always return 200 to Haberchat so
  // they don't retry; the activity row preserves any per-event error in its
  // `error` column for forensics on the /logs page.
  void logWebhookReceipt({
    source: 'haberchat',
    eventType: type || '(unknown)',
    payload: event,
    status: handlerError ? 'error' : 'success',
    error: handlerError,
  });

  return json({ ok: true });
}

// ─── M7: Dead-letter queue for failed Haberchat webhook events ─────
//
// When `handler error` fires above, the message is silently lost from
// the user's perspective — the chat thread doesn't update and there's
// no surface to triage. Persist the payload + error here; an admin
// page (future work) can retry / mark resolved.
async function writeHaberchatDlq(input: {
  eventType: string;
  deviceWid: string | null;
  payload: unknown;
  errorClass: string;
  errorMessage: string;
}): Promise<void> {
  const supa = getServiceSupabase();
  const { error } = await supa.from('haberchat_webhook_dlq').insert({
    event_type: input.eventType,
    device_wid: input.deviceWid,
    payload: input.payload as Record<string, unknown>,
    error_class: input.errorClass,
    error_message: input.errorMessage,
  });
  if (error) {
    console.error('[webhook] haberchat_webhook_dlq insert error:', error.message);
  }
}

// ─── Event handlers ────────────────────────────────────────────────

async function handleNewMessage(event: WebhookEvent, deviceId: string, flow: 'in' | 'out') {
  const raw = pickMessagePayload(event);
  if (!raw) {
    console.warn('[webhook.new] could not locate message payload; keys=', Object.keys(event));
    return;
  }
  const msg = normalizeWebhookMessage(raw, flow, deviceId, event);
  if (!msg) return;

  const supa = getServiceSupabase();

  // Upsert the message row. On conflict (same wid delivered twice due to
  // webhook retry) we update non-ack fields but intentionally DO NOT
  // downgrade ack — the `message:out:ack` branch is the authoritative
  // source of truth for that field.
  const { error: msgErr } = await supa.from('chat_messages').upsert(
    {
      id: msg.id,
      chat_wid: msg.chat_wid,
      conversation_record_id: msg.conversation_record_id,
      device_id: msg.device_id,
      flow: msg.flow,
      kind: msg.kind,
      subtype: msg.subtype,
      body: msg.body,
      from_phone: msg.from_phone,
      to_phone: msg.to_phone,
      ack: msg.ack,
      date: msg.date,
      media_file_id: msg.media_file_id,
      media_mime: msg.media_mime,
      media_size: msg.media_size,
      media_caption: msg.media_caption,
      reference: msg.reference,
      quoted: msg.quoted,
    },
    { onConflict: 'id', ignoreDuplicates: false },
  );
  if (msgErr) console.error('[webhook.new] chat_messages upsert failed:', msgErr.message);

  // Bump the parent conversation record's last_message_* fields so the
  // Chats list reflects the new activity on next sync (Realtime on the
  // `records` table is not enabled by design — the list page refreshes
  // on mount; this write is for cold-load correctness).
  await bumpConversationRecord({
    chatWid: msg.chat_wid,
    deviceId: msg.device_id,
    lastBody: msg.body ?? '[media]',
    lastAt: msg.date,
    lastFlow: flow,
    incrementUnread: flow === 'in',
  });
}

async function handleAck(event: WebhookEvent) {
  const raw = pickMessagePayload(event);
  if (!raw) return;
  const wid =
    (raw.wid as string | undefined) ??
    (raw.id as string | undefined) ??
    (raw._id as string | undefined) ??
    '';
  if (!wid) return;
  const ack = ackFrom(raw as Record<string, unknown>);
  if (!ack) return;

  const supa = getServiceSupabase();
  // Don't downgrade: once a message is 'read', keep it that way even if a
  // late 'delivered' event arrives. Rank by ACK_ORDER.
  const rank = ACK_ORDER[ack];
  // Two-step so we can log both states; a single SQL with comparison would
  // work too but PostgREST doesn't expose `<` on the ack TEXT column
  // cleanly without raw SQL.
  const { data: current } = await supa
    .from('chat_messages')
    .select('ack')
    .eq('id', wid)
    .maybeSingle();
  const currentRank = current?.ack ? (ACK_ORDER[current.ack as keyof typeof ACK_ORDER] ?? -1) : -1;
  if (rank <= currentRank) return;

  const { error } = await supa.from('chat_messages').update({ ack }).eq('id', wid);
  if (error) console.error('[webhook.ack] update failed:', error.message);
}

async function handleChatUpdate(event: WebhookEvent, deviceId: string) {
  const chat = (event.data?.chat ?? event.data ?? event) as Record<string, unknown>;
  const chatWid = pickId(chat) ?? '';
  if (!chatWid) return;

  const patch: Record<string, unknown> = {};
  if (typeof chat.status === 'string') patch.status = chat.status;
  if (typeof chat.owner === 'string' || chat.owner === null) patch.owner = chat.owner;
  if (Array.isArray(chat.labels)) patch.labels = chat.labels;

  if (Object.keys(patch).length === 0) return;

  // Patch-merge the record's data JSONB. Read-modify-write because
  // PostgREST doesn't support JSONB-path updates nicely.
  const supa = getServiceSupabase();
  const modelId = await findChatsModelId();
  if (!modelId) return;
  const recordId = await uuidV5FromWid(chatWid);

  const { data: existing } = await supa
    .from('records')
    .select('data')
    .eq('id', recordId)
    .maybeSingle();

  const nextData = { ...(existing?.data as Record<string, unknown> | null ?? {}), ...patch };
  const { error } = await supa.from('records').upsert({
    id: recordId,
    model_id: modelId,
    data: nextData,
    // device_id may not be in the chat:update payload; keep whatever is
    // already in data so we don't accidentally null it out.
    ...(deviceId && !nextData.device_id ? { data: { ...nextData, device_id: deviceId } } : {}),
  }, { onConflict: 'id' });
  if (error) console.error('[webhook.chat:update] upsert failed:', error.message);
}

async function bumpConversationRecord(args: {
  chatWid: string;
  deviceId: string;
  lastBody: string;
  lastAt: string;
  lastFlow: 'in' | 'out';
  incrementUnread: boolean;
}) {
  const supa = getServiceSupabase();
  const modelId = await findChatsModelId();
  if (!modelId) return;
  const recordId = await uuidV5FromWid(args.chatWid);

  const { data: existing } = await supa
    .from('records')
    .select('data')
    .eq('id', recordId)
    .maybeSingle();

  const prevData = (existing?.data as Record<string, unknown> | null) ?? {};
  const prevUnread = typeof prevData.unread_count === 'number' ? prevData.unread_count : 0;

  // Auto-reopen: a customer message into a closed (resolved/archived)
  // conversation reopens it — the rep must see it under "Open" again.
  const prevStatus = typeof prevData.status === 'string' ? prevData.status : 'active';
  const reopen = args.lastFlow === 'in' && (prevStatus === 'resolved' || prevStatus === 'archived');

  const nextData = {
    ...prevData,
    // Only fill wid / device_id if missing — they're set on first sync.
    wid: prevData.wid ?? args.chatWid,
    device_id: prevData.device_id ?? args.deviceId,
    last_message_at: args.lastAt,
    last_message_preview: truncate(args.lastBody, 120),
    // Direction of the newest message — the Chats list's "needs reply"
    // filter reads this ('in' = the customer spoke last).
    last_message_flow: args.lastFlow,
    unread_count: args.incrementUnread ? prevUnread + 1 : prevUnread,
    ...(reopen ? { status: 'active' } : {}),
  };

  const { error } = await supa.from('records').upsert(
    { id: recordId, model_id: modelId, data: nextData },
    { onConflict: 'id' },
  );
  if (error) console.error('[webhook.bumpRecord] upsert failed:', error.message);

  // Push the reopen to Haberchat too — its chat status is authoritative on
  // the next list sync (mergeChatIntoRecord takes Haberchat's status), so
  // without this the chat would flip back to closed on the next refresh.
  // Best-effort: a failure here must not fail the webhook (the record is
  // already reopened; the next inbound retries).
  if (reopen) {
    try {
      await patchChat(args.deviceId, args.chatWid, { status: 'active' });
    } catch (err) {
      console.error('[webhook.bumpRecord] auto-reopen Haberchat PATCH failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

interface WebhookEvent {
  type?: string;
  event?: string;
  device?: string;
  deviceId?: string;
  data?: Record<string, unknown> & { device?: string; message?: unknown; chat?: unknown };
  [k: string]: unknown;
}

function pickMessagePayload(event: WebhookEvent): Record<string, unknown> | null {
  if (event.data && typeof event.data === 'object') {
    const d = event.data as Record<string, unknown>;
    if (d.message && typeof d.message === 'object') return d.message as Record<string, unknown>;
    // Some events put the message fields right on `data`.
    if (d.wid || d._id || d.id) return d;
  }
  // Or flat at the top level.
  if (event.wid || event._id || event.id) return event as unknown as Record<string, unknown>;
  return null;
}

interface NormalizedWebhookMessage {
  id: string;
  chat_wid: string;
  conversation_record_id: string;
  device_id: string;
  flow: 'in' | 'out';
  kind: string;
  subtype: string | null;
  body: string | null;
  from_phone: string | null;
  to_phone: string | null;
  ack: string | null;
  date: string;
  media_file_id: string | null;
  media_mime: string | null;
  media_size: number | null;
  media_caption: string | null;
  reference: string | null;
  quoted: Record<string, unknown> | null;
}

function normalizeWebhookMessage(
  raw: Record<string, unknown>,
  flow: 'in' | 'out',
  deviceId: string,
  event: WebhookEvent,
): NormalizedWebhookMessage | null {
  const id =
    (raw.wid as string | undefined) ??
    (raw.widFull as string | undefined) ??
    (raw._id as string | undefined) ??
    (raw.id as string | undefined) ??
    (raw.messageId as string | undefined) ??
    '';
  if (!id) return null;

  // Haberchat nests the full chat object under `chat` / `data.chat`. Extract
  // the wid whether it's a bare string or an object with {id|wid}. Same for
  // the event envelope.
  const chatWid =
    pickId(raw.chatWid) ??
    pickId(raw.chat) ??
    pickId((event as Record<string, unknown>).chat) ??
    pickId(event.data?.chat) ??
    pickId(raw.conversationId) ??
    // Fall back to the parties — on inbound, the sender IS the chat wid in
    // 1-to-1 chats; on outbound, the recipient is. These fields might also
    // be objects with {id}/{wid} — pickId handles both shapes.
    (flow === 'in' ? pickId(raw.from) : pickId(raw.to)) ??
    '';
  if (!chatWid) return null;

  const rawKind = String(raw.kind ?? raw.type ?? 'text').toLowerCase();
  const kind =
    rawKind === 'chat' || rawKind === 'textmessage' ? 'text' :
    rawKind === 'img' || rawKind === 'photo' ? 'image' :
    rawKind === 'file' || rawKind === 'doc' ? 'document' :
    rawKind;

  const rawSubtype = raw.subtype;
  const subtype = typeof rawSubtype === 'string' && rawSubtype ? rawSubtype.toLowerCase() : null;

  const body = (raw.body as string | null | undefined) ?? (raw.text as string | null | undefined) ?? (raw.message as string | null | undefined) ?? (raw.caption as string | null | undefined) ?? null;

  const fromPhone = pickPhone(raw.from) ?? pickPhone(raw.sender) ?? null;
  const toPhone = pickPhone(raw.to) ?? pickPhone(raw.recipient) ?? null;

  const date = coerceIsoDate(raw.date ?? raw.timestamp ?? raw.createdAt ?? null) ?? new Date().toISOString();

  const media = (raw.media as Record<string, unknown> | null | undefined) ?? null;
  const mediaFileId = (media?.id as string | undefined) ?? (raw.mediaId as string | undefined) ?? null;
  const mediaMime = (media?.mime as string | undefined) ?? (media?.mimetype as string | undefined) ?? null;
  const mediaSize = typeof media?.size === 'number' ? (media.size as number) : null;
  const mediaCaption = (media?.caption as string | undefined) ?? null;

  const quoted = (raw.quoted as Record<string, unknown> | null | undefined) ?? null;

  const ack = ackFrom(raw) ?? (flow === 'in' ? null : 'sent');

  // Device id fallback chain: event envelope → payload → param.
  const resolvedDevice =
    ((event.device as string | undefined) ??
      (event.deviceId as string | undefined) ??
      (raw.device as string | undefined) ??
      (raw.deviceId as string | undefined) ??
      deviceId) || '';

  return {
    id,
    chat_wid: chatWid,
    conversation_record_id: uuidV5FromWidSync(chatWid),
    device_id: resolvedDevice,
    flow,
    kind,
    subtype,
    body,
    from_phone: fromPhone,
    to_phone: toPhone,
    ack,
    date,
    media_file_id: mediaFileId,
    media_mime: mediaMime,
    media_size: mediaSize,
    media_caption: mediaCaption,
    reference: (raw.reference as string | undefined) ?? null,
    quoted,
  };
}

const ACK_ORDER = {
  failed: -1,
  pending: 0,
  sent: 1,
  delivered: 2,
  played: 3,
  read: 3,
} as const;

function ackFrom(raw: Record<string, unknown>): string | null {
  const v = String(raw.ack ?? raw.status ?? '').toLowerCase();
  if (!v) return null;
  if (v in ACK_ORDER) return v === 'played' ? 'read' : v;
  return null;
}

/**
 * Extract a WhatsApp id/wid from either a bare string or an object with
 * `id` / `wid` / `chatWid`. Haberchat's webhooks frequently nest a whole
 * chat / contact / message object where a simple string would be simplest
 * — we defensively accept both. Returns null for unusable shapes.
 */
function pickId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const candidate = v.id ?? v.wid ?? v.widFull ?? v._id ?? v.chatWid;
    if (typeof candidate === 'string' && candidate) return candidate;
    // `chat.contact.userWid` is another spot where Haberchat stores the
    // 1-to-1 chat wid — e.g. "966555...@c.us" derived from the contact.
    const userWid = (v.userWid ?? (v.contact as Record<string, unknown> | undefined)?.userWid);
    if (typeof userWid === 'string' && userWid) return userWid;
  }
  return null;
}

/**
 * Same idea as pickId but for phone numbers. Accepts a bare string, or an
 * object with { phone } / { contact: { phone } } / { number }.
 */
function pickPhone(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.phone === 'string' && v.phone) return v.phone;
    if (typeof v.number === 'string' && v.number) return v.number;
    const contact = v.contact as Record<string, unknown> | undefined;
    if (contact && typeof contact.phone === 'string' && contact.phone) return contact.phone;
    // Derive from a wid like "966555...@c.us" if nothing else matches.
    const id = pickId(v);
    if (id) {
      const match = id.match(/^(\+?\d+)@c\.us$/);
      if (match) return match[1].startsWith('+') ? match[1] : `+${match[1]}`;
    }
  }
  return null;
}

function coerceIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// UUIDv5 namespace — must match src/lib/haberchat/normalize.ts#CHATS_NAMESPACE.
// Do NOT change — records are stored with ids derived from this namespace.
const CHATS_NAMESPACE = 'a7f3c8d1-5e24-4b3a-9d8e-6c1f2a4b7e90';

/**
 * UUIDv5 using Web Crypto SHA-1. Edge runtime has no `uuid` npm package,
 * so we implement the RFC4122 §4.3 variant inline. Output matches the
 * `uuidv5(wid, CHATS_NAMESPACE)` call on the browser side so webhook
 * inserts and sync writes converge on the same records.id.
 */
async function uuidV5FromWid(wid: string): Promise<string> {
  const nsBytes = uuidToBytes(CHATS_NAMESPACE);
  const nameBytes = new TextEncoder().encode(wid);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', combined));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC4122
  return bytesToUuid(bytes);
}

// Synchronous wrapper for places where we're already building up fields
// and can't await. Hits a tiny memoized cache since many webhook events
// share the same chat wid.
const widCache = new Map<string, string>();
function uuidV5FromWidSync(wid: string): string {
  const cached = widCache.get(wid);
  if (cached) return cached;
  // Compute synchronously using a pure-JS SHA-1 fallback. Kept simple;
  // uuidV5FromWid is used elsewhere for async callers.
  const id = sha1UuidV5(wid);
  widCache.set(wid, id);
  return id;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(b: Uint8Array): string {
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Minimal RFC4122 v5 synchronous implementation using a pure-JS SHA-1.
// Used only by the webhook (Edge runtime, no Node `crypto` module). The
// digest isn't security-critical here — we're generating deterministic
// ids, not verifying signatures.
function sha1UuidV5(name: string): string {
  const nsBytes = uuidToBytes(CHATS_NAMESPACE);
  const nameBytes = new TextEncoder().encode(name);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);
  const digest = sha1(combined);
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function sha1(input: Uint8Array): Uint8Array {
  // Based on RFC 3174 — this is a terse but correct implementation. Only
  // used as a fallback when we can't await crypto.subtle. Processes
  // 64-byte blocks; handles message padding + length.
  const ml = input.length * 8;
  const withOne = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  withOne.set(input);
  withOne[input.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setUint32(withOne.length - 4, ml >>> 0, false);
  view.setUint32(withOne.length - 8, Math.floor(ml / 0x100000000), false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);
  for (let i = 0; i < withOne.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) {
      const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

let chatsModelIdCache: string | null = null;
async function findChatsModelId(): Promise<string | null> {
  if (chatsModelIdCache) return chatsModelIdCache;
  const supa = getServiceSupabase();
  const { data } = await supa
    .from('models')
    .select('id')
    .eq('name', 'chats')
    .maybeSingle();
  chatsModelIdCache = (data?.id as string | undefined) ?? null;
  return chatsModelIdCache;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
