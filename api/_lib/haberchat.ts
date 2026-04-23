/**
 * Server-side typed wrapper around the Haberchat REST API.
 *
 * Never imported from `src/*` — the token lives in `process.env.HABERCHAT_TOKEN`
 * and CORS is blocked at Haberchat's edge, so the browser cannot call this
 * API directly. All browser-initiated calls flow through an `api/haberchat/*`
 * handler which then calls the helpers here.
 */

const BASE_URL = 'https://api.haber.chat/v1';

export class HaberchatError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

function token(): string {
  const t = process.env.HABERCHAT_TOKEN;
  if (!t) throw new HaberchatError(500, 'HABERCHAT_TOKEN is not set');
  return t;
}

export function defaultDeviceId(): string | null {
  return process.env.HABERCHAT_DEFAULT_DEVICE_ID ?? null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Token: token(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    throw new HaberchatError(res.status, `Haberchat ${init.method ?? 'GET'} ${path} failed: ${res.status}`, body);
  }
  return (await res.json()) as T;
}

// ─── Types (normalized from Haberchat responses) ─────────────────────
// Only the fields the app actually uses. Extend as more endpoints land.

export interface HaberchatDevice {
  id: string;                 // 24-hex device id
  phone: string;              // E.164 of the WhatsApp number
  name?: string | null;       // Haberchat-assigned device name
  status?: 'online' | 'offline' | 'disconnected' | 'pending' | string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HaberchatChat {
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

export interface HaberchatMessage {
  wid: string;                // message id
  chatWid: string;            // parent conversation id
  flow: 'in' | 'out';
  kind: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'template' | 'contact' | 'poll' | 'interactive' | string;
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

// ─── Endpoints ────────────────────────────────────────────────────────

/**
 * List every device (connected WhatsApp number) on the Haberchat account.
 * The endpoint shape is `GET /devices` and returns an array of device objects.
 * Fields that vary between Haberchat plans are optional in `HaberchatDevice`.
 */
export async function listDevices(): Promise<HaberchatDevice[]> {
  // Haberchat paginates listings — request a generous page size so a single
  // call covers realistic account sizes (most tenants have 1-5 devices).
  const raw = await request<HaberchatDevicesResponse>(`/devices?size=50&page=0`);
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);
  return items.map(normalizeDevice);
}

// Raw response shape — Haberchat list endpoints are sometimes `T[]` and
// sometimes `{ items: T[] }`. Accept both.
type HaberchatDevicesResponse =
  | HaberchatDeviceRaw[]
  | { items?: HaberchatDeviceRaw[]; data?: HaberchatDeviceRaw[] };

interface HaberchatDeviceRaw {
  id?: string;
  _id?: string;
  phone?: string;
  number?: string;
  name?: string | null;
  alias?: string | null;
  status?: string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * List every chat (conversation) on a single device. Haberchat's endpoint
 * is `GET /chat/{deviceId}/chats?size=...&page=...`. For v1 we request a
 * single generous page (100 items); pagination is a later concern.
 */
export async function listChats(deviceId: string, opts: { size?: number; page?: number } = {}): Promise<HaberchatChat[]> {
  if (!deviceId) throw new HaberchatError(400, 'deviceId is required');
  const size = opts.size ?? 100;
  const page = opts.page ?? 0;
  const raw = await request<HaberchatChatsResponse>(`/chat/${encodeURIComponent(deviceId)}/chats?size=${size}&page=${page}`);
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? raw.chats ?? []);
  // Skip (don't throw) on individual chats we can't identify — one bad row
  // shouldn't fail the entire page.
  return items.map(normalizeChat).filter((c): c is HaberchatChat => c !== null);
}

type HaberchatChatsResponse =
  | HaberchatChatRaw[]
  | { items?: HaberchatChatRaw[]; data?: HaberchatChatRaw[]; chats?: HaberchatChatRaw[] };

// Raw chat shape — Haberchat's response is inconsistently shaped across plans
// and API versions. Accept every id field we've seen in the wild, let
// normalizeChat pick the first populated one, and skip rows where nothing
// identifies the conversation.
interface HaberchatChatRaw {
  // Identifier candidates (Haberchat has used all of these in different contexts)
  wid?: string;
  widFull?: string;
  _id?: string;
  id?: string;
  chatId?: string;
  chat_id?: string;
  chatWid?: string;
  // Chat type
  kind?: string;
  type?: string;
  isGroup?: boolean;
  // Display
  name?: string | null;
  title?: string | null;
  contactName?: string | null;
  pushName?: string | null;
  contact?: { phone?: string; name?: string | null; pushName?: string | null; wid?: string } | null;
  phone?: string | null;
  number?: string | null;
  // State
  status?: string;
  state?: string;
  archived?: boolean;
  resolved?: boolean;
  // Assignment / labels
  owner?: string | null;
  ownerAgentId?: string | null;
  labels?: string[];
  // Stats
  stats?: { unread?: number; unreadCount?: number } | null;
  unread?: number;
  unreadCount?: number;
  // Last message — might be nested under `lastMessage`, or flat (lastMessageAt,
  // lastMessageBody), or under `last`.
  lastMessage?: { body?: string | null; text?: string | null; date?: string | null; timestamp?: number | string; kind?: string; type?: string } | null;
  last?: { body?: string | null; date?: string | null } | null;
  lastMessageAt?: string | null;
  lastMessageBody?: string | null;
  lastMessageDate?: string | null;
  lastActivity?: string | null;
  updatedAt?: string | null;
  // Allow anything else through so we don't lose forward-compat data
  [k: string]: unknown;
}

function normalizeChat(raw: HaberchatChatRaw): HaberchatChat | null {
  const wid =
    raw.wid ??
    raw.widFull ??
    raw.chatWid ??
    raw.chatId ??
    raw.chat_id ??
    raw._id ??
    raw.id ??
    raw.contact?.wid ??
    '';
  if (!wid) {
    // One-line log so we can see what Haberchat actually sent — inspect via
    // Vercel function logs.
    try {
      console.warn('[haberchat.normalizeChat] skipping chat with no id; keys=', Object.keys(raw).join(','));
    } catch { /* ignore */ }
    return null;
  }
  const rawKind = (raw.kind ?? raw.type ?? (raw.isGroup ? 'group' : 'user')).toString().toLowerCase();
  const kind = rawKind === 'user' || rawKind === 'group' || rawKind === 'channel' ? rawKind : 'user';

  const contactName = raw.contact?.name ?? raw.contact?.pushName ?? null;
  const displayName = raw.name ?? raw.title ?? contactName ?? raw.pushName ?? raw.contactName ?? null;
  const phone = raw.contact?.phone ?? raw.phone ?? raw.number ?? extractPhoneFromWid(wid);

  const status =
    raw.status ??
    raw.state ??
    (raw.archived ? 'archived' : raw.resolved ? 'resolved' : 'active');

  const unreadCount =
    raw.stats?.unread ??
    raw.stats?.unreadCount ??
    raw.unread ??
    raw.unreadCount ??
    0;

  const lastMessageAt =
    raw.lastMessageAt ??
    raw.lastMessage?.date ??
    raw.last?.date ??
    raw.lastMessageDate ??
    raw.lastActivity ??
    raw.updatedAt ??
    null;

  const lastMessagePreview =
    raw.lastMessage?.body ??
    raw.lastMessage?.text ??
    raw.last?.body ??
    raw.lastMessageBody ??
    null;

  return {
    wid,
    kind,
    name: displayName,
    phone,
    status,
    ownerAgentId: raw.owner ?? raw.ownerAgentId ?? null,
    labels: raw.labels ?? [],
    unreadCount,
    lastMessageAt,
    lastMessagePreview,
    meta: {},
  };
}

/**
 * List messages in one chat. Haberchat's endpoint is
 * `GET /chat/{deviceId}/chats/{chatWid}/sync?size=...&before=...`. Pass
 * `before` to paginate backwards through history. Returns ascending by date
 * so the UI can append without re-sorting.
 */
export async function listMessages(
  deviceId: string,
  chatWid: string,
  opts: { size?: number; before?: string } = {},
): Promise<HaberchatMessage[]> {
  if (!deviceId) throw new HaberchatError(400, 'deviceId is required');
  if (!chatWid) throw new HaberchatError(400, 'chatWid is required');
  const size = opts.size ?? 50;
  const params = new URLSearchParams({ size: String(size) });
  if (opts.before) params.set('before', opts.before);
  const path = `/chat/${encodeURIComponent(deviceId)}/chats/${encodeURIComponent(chatWid)}/sync?${params.toString()}`;
  const raw = await request<HaberchatMessagesResponse>(path);
  const items: HaberchatMessageRaw[] = Array.isArray(raw)
    ? raw
    : (raw.messages ?? raw.items ?? raw.data ?? []);
  const normalized = items
    .map((r) => normalizeMessage(r, chatWid))
    .filter((m): m is HaberchatMessage => m !== null);
  // Oldest first — Haberchat sometimes returns newest-first, which the UI
  // would have to reverse anyway. Sort defensively.
  normalized.sort((a, b) => a.date.localeCompare(b.date));
  return normalized;
}

type HaberchatMessagesResponse =
  | HaberchatMessageRaw[]
  | { messages?: HaberchatMessageRaw[]; items?: HaberchatMessageRaw[]; data?: HaberchatMessageRaw[] };

// Raw Haberchat message — field-name drift tolerated same as chats.
interface HaberchatMessageRaw {
  // id candidates
  wid?: string;
  widFull?: string;
  _id?: string;
  id?: string;
  messageId?: string;
  // parent conversation
  chatWid?: string;
  chat?: string;
  conversationId?: string;
  // direction
  flow?: string;
  direction?: string;
  fromMe?: boolean;
  // body
  body?: string | null;
  text?: string | null;
  message?: string | null;
  caption?: string | null;
  // kind
  kind?: string;
  type?: string;
  // parties
  from?: string | null;
  to?: string | null;
  sender?: string | null;
  recipient?: string | null;
  // delivery
  ack?: string | null;
  status?: string | null;
  // time
  date?: string | number | null;
  timestamp?: string | number | null;
  createdAt?: string | null;
  // media
  media?: {
    id?: string;
    mime?: string;
    mimetype?: string;
    size?: number;
    caption?: string | null;
    filename?: string;
  } | null;
  mediaId?: string;
  // reply
  quoted?: {
    wid?: string;
    _id?: string;
    id?: string;
    body?: string | null;
    text?: string | null;
    kind?: string;
    type?: string;
  } | null;
  quotedMessageId?: string | null;
  // client correlation key
  reference?: string | null;
  [k: string]: unknown;
}

function normalizeMessage(raw: HaberchatMessageRaw, fallbackChatWid: string): HaberchatMessage | null {
  const wid = raw.wid ?? raw.widFull ?? raw._id ?? raw.id ?? raw.messageId ?? '';
  if (!wid) {
    try {
      console.warn('[haberchat.normalizeMessage] skipping message with no id; keys=', Object.keys(raw).join(','));
    } catch { /* ignore */ }
    return null;
  }

  const rawFlow = (raw.flow ?? raw.direction ?? (raw.fromMe ? 'out' : 'in')).toString().toLowerCase();
  const flow: 'in' | 'out' = rawFlow === 'out' || rawFlow === 'outbound' || rawFlow === 'sent' ? 'out' : 'in';

  const rawKind = (raw.kind ?? raw.type ?? 'text').toString().toLowerCase();
  // Normalize a few Haberchat synonyms to our canonical set.
  const kind =
    rawKind === 'chat' || rawKind === 'textmessage' ? 'text' :
    rawKind === 'img' || rawKind === 'photo' ? 'image' :
    rawKind === 'file' || rawKind === 'doc' ? 'document' :
    rawKind;

  const body = raw.body ?? raw.text ?? raw.message ?? raw.caption ?? null;

  const fromPhone = raw.from ?? raw.sender ?? null;
  const toPhone = raw.to ?? raw.recipient ?? null;

  const rawAck = (raw.ack ?? raw.status ?? '').toString().toLowerCase();
  const ack: HaberchatMessage['ack'] =
    rawAck === 'failed' || rawAck === 'pending' || rawAck === 'sent' ||
    rawAck === 'delivered' || rawAck === 'read' || rawAck === 'played'
      ? rawAck
      : rawAck === ''
        ? null
        : null;

  // Date: prefer ISO strings, else coerce numeric (seconds or millis) to ISO.
  const date = coerceIsoDate(raw.date ?? raw.timestamp ?? raw.createdAt ?? null);
  if (!date) {
    try {
      console.warn('[haberchat.normalizeMessage] skipping message with no date; wid=', wid);
    } catch { /* ignore */ }
    return null;
  }

  // Media
  const mediaFileId = raw.media?.id ?? raw.mediaId ?? null;
  const mediaMime = raw.media?.mime ?? raw.media?.mimetype ?? null;
  const mediaSize = raw.media?.size ?? null;
  const mediaCaption = raw.media?.caption ?? null;

  // Quoted reply — Haberchat sometimes returns just the id, sometimes the
  // full nested object. Build what we can.
  let quoted: HaberchatMessage['quoted'] = null;
  if (raw.quoted && typeof raw.quoted === 'object') {
    const qw = raw.quoted.wid ?? raw.quoted._id ?? raw.quoted.id ?? '';
    if (qw) {
      quoted = {
        wid: qw,
        body: raw.quoted.body ?? raw.quoted.text ?? null,
        kind: (raw.quoted.kind ?? raw.quoted.type ?? 'text').toString().toLowerCase(),
      };
    }
  } else if (raw.quotedMessageId) {
    quoted = { wid: raw.quotedMessageId, body: null, kind: 'text' };
  }

  const chatWid = raw.chatWid ?? raw.chat ?? raw.conversationId ?? fallbackChatWid;

  return {
    wid,
    chatWid,
    flow,
    kind,
    body,
    fromPhone,
    toPhone,
    ack,
    date,
    mediaFileId,
    mediaMime,
    mediaSize,
    mediaCaption,
    reference: raw.reference ?? null,
    quoted,
  };
}

function coerceIsoDate(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    // If it parses as a date, return its ISO form for consistency.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values below 10^12 are seconds, else millis.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  return null;
}

/**
 * Send a single message. Haberchat's endpoint is `POST /messages`. The
 * target is one of `phone` (direct chat), `group`, or `channel`. v1 only
 * supports direct chats (phone); groups/channels come later.
 *
 * `reference` is a client-side correlation key — we echo it back in the
 * webhook so the browser can match the optimistic placeholder to the
 * server-assigned wid when the send ack arrives.
 */
export async function sendMessage(input: {
  deviceId: string;
  phone?: string;
  group?: string;
  channel?: string;
  body?: string;
  mediaFileId?: string;
  mediaCaption?: string;
  quotedWid?: string;
  reference?: string;
}): Promise<{ wid: string; status: string; reference: string | null }> {
  if (!input.deviceId) throw new HaberchatError(400, 'deviceId is required');
  const targets = [input.phone, input.group, input.channel].filter(Boolean);
  if (targets.length !== 1) {
    throw new HaberchatError(400, 'exactly one of phone / group / channel is required');
  }
  if (!input.body && !input.mediaFileId) {
    throw new HaberchatError(400, 'body or mediaFileId is required');
  }
  const payload: Record<string, unknown> = {
    device: input.deviceId,
  };
  if (input.phone)    payload.phone = input.phone;
  if (input.group)    payload.group = input.group;
  if (input.channel)  payload.channel = input.channel;
  if (input.body)     payload.message = input.body;
  if (input.mediaFileId) {
    payload.media = { file: input.mediaFileId };
    if (input.mediaCaption) payload.caption = input.mediaCaption;
  }
  if (input.quotedWid) payload.quoted = input.quotedWid;
  if (input.reference) payload.reference = input.reference;

  const raw = await request<Record<string, unknown>>(`/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const wid = (raw.id as string) ?? (raw.wid as string) ?? (raw._id as string) ?? '';
  const status = (raw.status as string) ?? 'queued';
  const reference = (raw.reference as string) ?? input.reference ?? null;
  if (!wid) {
    throw new HaberchatError(502, 'Haberchat POST /messages returned no id');
  }
  return { wid, status, reference };
}

/**
 * Upload a file to Haberchat's `POST /files`. Browser forwards multipart
 * form-data through our proxy; we replay it with the token header.
 * Returns the Haberchat file id plus mime/size so the caller can embed
 * the file in a subsequent POST /messages.
 */
export async function uploadFile(formData: FormData): Promise<{ fileId: string; mime: string | null; size: number | null; filename: string | null }> {
  // Note: we do NOT set Content-Type here — `fetch` computes the correct
  // multipart/form-data boundary automatically when given FormData.
  const res = await fetch(`${BASE_URL}/files`, {
    method: 'POST',
    headers: { Token: token() },
    body: formData,
  });
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    throw new HaberchatError(res.status, `Haberchat POST /files failed: ${res.status}`, body);
  }
  const raw = (await res.json()) as unknown;
  // Haberchat's /files response shape is inconsistent across versions —
  // try every common variant before giving up.
  const found = extractFilePayload(raw);
  if (!found) {
    // Include the response shape in the error so operators can see what
    // Haberchat actually returned. Logged server-side by the proxy.
    const keys = raw && typeof raw === 'object'
      ? Object.keys(raw as Record<string, unknown>).join(',')
      : typeof raw;
    throw new HaberchatError(502, `Haberchat /files returned no id (keys: ${keys})`);
  }
  return found;
}

function extractFilePayload(raw: unknown): { fileId: string; mime: string | null; size: number | null; filename: string | null } | null {
  // Array → take first element
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const f = extractFilePayload(item);
      if (f) return f;
    }
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Nested wrappers Haberchat sometimes uses.
  if (obj.file && typeof obj.file === 'object') {
    const nested = extractFilePayload(obj.file);
    if (nested) return nested;
  }
  if (obj.data && typeof obj.data === 'object') {
    const nested = extractFilePayload(obj.data);
    if (nested) return nested;
  }
  if (obj.result && typeof obj.result === 'object') {
    const nested = extractFilePayload(obj.result);
    if (nested) return nested;
  }

  // Look for an id-like field on this object directly.
  const fileId =
    asString(obj.id) ??
    asString(obj._id) ??
    asString(obj.fileId) ??
    asString(obj.file_id) ??
    asString(obj.uuid) ??
    null;
  if (!fileId) return null;

  return {
    fileId,
    mime: asString(obj.mime) ?? asString(obj.mimetype) ?? asString(obj.contentType) ?? asString(obj.content_type) ?? null,
    size: asNumber(obj.size) ?? asNumber(obj.length) ?? null,
    filename: asString(obj.filename) ?? asString(obj.name) ?? asString(obj.originalName) ?? null,
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Patch a single chat — change status (resolved / active / archived) and /
 * or labels. Haberchat's endpoint is `PATCH /chat/{deviceId}/chats` in bulk
 * "action" form; we fan out one request per semantic change so we can
 * report on each separately. Calls are issued sequentially; on first
 * failure we stop and throw (caller's optimistic state gets reverted).
 *
 * Status mapping:
 *   'resolved'   → { action: 'resolve',   wids: [...] }
 *   'active'     → { action: 'unresolve', wids: [...] } (+ unarchive if was archived)
 *   'archived'   → { action: 'archive',   wids: [...] }
 */
export async function patchChat(
  deviceId: string,
  chatWid: string,
  patch: { status?: 'active' | 'resolved' | 'archived'; labels?: string[] },
): Promise<void> {
  if (!deviceId) throw new HaberchatError(400, 'deviceId is required');
  if (!chatWid) throw new HaberchatError(400, 'chatWid is required');
  const path = `/chat/${encodeURIComponent(deviceId)}/chats`;

  if (patch.status) {
    const action =
      patch.status === 'resolved' ? 'resolve' :
      patch.status === 'archived' ? 'archive' :
      'unresolve';
    await request<Record<string, unknown>>(path, {
      method: 'PATCH',
      body: JSON.stringify({ action, wids: [chatWid] }),
    });
    // Going from archived → active also needs an unarchive call.
    if (patch.status === 'active') {
      try {
        await request<Record<string, unknown>>(path, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'unarchive', wids: [chatWid] }),
        });
      } catch {
        // Not all Haberchat plans expose unarchive as its own action —
        // swallow a 400/405 here since the primary 'unresolve' above
        // already succeeded.
      }
    }
  }

  if (patch.labels) {
    await request<Record<string, unknown>>(path, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'label', wids: [chatWid], labels: patch.labels }),
    });
  }
}

/**
 * Stream a file download from Haberchat. We return the raw Response so
 * the proxy handler can pipe it straight back to the browser without
 * buffering — the whole point is to keep the token server-side.
 */
export async function downloadFile(deviceId: string, fileId: string): Promise<Response> {
  if (!deviceId) throw new HaberchatError(400, 'deviceId is required');
  if (!fileId) throw new HaberchatError(400, 'fileId is required');
  const res = await fetch(`${BASE_URL}/chat/${encodeURIComponent(deviceId)}/files/${encodeURIComponent(fileId)}/download`, {
    headers: { Token: token() },
  });
  if (!res.ok) {
    // Read once so the response body can be abandoned cleanly.
    const preview = await res.text().catch(() => '');
    throw new HaberchatError(res.status, `Haberchat file download failed: ${res.status} ${preview.slice(0, 120)}`);
  }
  return res;
}

/**
 * Haberchat conversation WIDs embed the E.164 phone. `966555...@c.us` for
 * a user; `...@g.us` for a group. Only meaningful for user chats.
 */
function extractPhoneFromWid(wid: string): string | null {
  const m = wid.match(/^(\+?\d+)@c\.us$/);
  if (!m) return null;
  return m[1].startsWith('+') ? m[1] : `+${m[1]}`;
}

function normalizeDevice(raw: HaberchatDeviceRaw): HaberchatDevice {
  const id = raw.id ?? raw._id ?? '';
  if (!id) throw new HaberchatError(500, 'Haberchat device missing id');
  return {
    id,
    phone: raw.phone ?? raw.number ?? '',
    name: raw.name ?? raw.alias ?? null,
    status: raw.status,
    plan: raw.plan,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
