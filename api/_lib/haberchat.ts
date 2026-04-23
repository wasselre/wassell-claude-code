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
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);
  return items.map(normalizeChat);
}

type HaberchatChatsResponse =
  | HaberchatChatRaw[]
  | { items?: HaberchatChatRaw[]; data?: HaberchatChatRaw[] };

// Raw chat shape — Haberchat's response nests contact info and the last
// message under sub-objects; flatten what we need, keep everything else in
// `meta` for forward-compat.
interface HaberchatChatRaw {
  wid?: string;
  _id?: string;
  kind?: string;
  type?: string;
  name?: string | null;
  contactName?: string | null;
  contact?: { phone?: string; name?: string | null } | null;
  phone?: string | null;
  status?: string;
  owner?: string | null;
  ownerAgentId?: string | null;
  labels?: string[];
  stats?: { unread?: number } | null;
  unreadCount?: number;
  lastMessage?: { body?: string | null; date?: string | null; kind?: string } | null;
  lastMessageAt?: string | null;
}

function normalizeChat(raw: HaberchatChatRaw): HaberchatChat {
  const wid = raw.wid ?? raw._id ?? '';
  if (!wid) throw new HaberchatError(500, 'Haberchat chat missing wid');
  const kind = (raw.kind ?? raw.type ?? 'user').toLowerCase();
  const contactName = raw.contact?.name ?? null;
  const phone = raw.contact?.phone ?? raw.phone ?? extractPhoneFromWid(wid);
  return {
    wid,
    kind,
    name: raw.name ?? contactName ?? null,
    phone,
    status: raw.status,
    ownerAgentId: raw.owner ?? raw.ownerAgentId ?? null,
    labels: raw.labels ?? [],
    unreadCount: raw.stats?.unread ?? raw.unreadCount ?? 0,
    lastMessageAt: raw.lastMessageAt ?? raw.lastMessage?.date ?? null,
    lastMessagePreview: raw.lastMessage?.body ?? null,
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
