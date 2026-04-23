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
