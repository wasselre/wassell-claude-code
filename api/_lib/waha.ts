/**
 * Server-side typed adapter for the self-hosted WAHA gateway (WhatsApp HTTP
 * API, engine GOWS). Mirrors the EXPORTED FUNCTION SURFACE of
 * `api/_lib/haberchat.ts` so `api/_lib/whatsappGateway.ts` can dispatch to
 * either provider by the number's `provider` flag, and the `api/haberchat/*`
 * proxies + browser client + store keep working unchanged.
 *
 * A WAHA "device id" is the SESSION NAME (e.g. 'wassel_main'), stored in the
 * same `device_id` columns the app already treats as an opaque string.
 *
 * Auth: `X-Api-Key: WAHA_API_KEY`. Base URL: `WAHA_URL`.
 *
 * Media model (WAHA has no pre-upload step):
 *   - uploadFile()   stashes the bytes in the private `wassel-files` bucket under
 *                    `waha-outbound/<uuid>.<ext>` and returns an opaque fileId
 *                    `wt_<path>`. This preserves the app's two-step
 *                    upload→send flow across two HTTP requests.
 *   - sendMessage()  resolves a `wt_` ref to a short-lived SIGNED URL and hands
 *                    it to WAHA's sendImage/sendFile/sendVideo/sendVoice
 *                    ({file:{url}}); WAHA fetches it server-side.
 *   - downloadFile() streams either a `wt_` temp object (pre-webhook outbound
 *                    bubble) or a `wf_<session>/<file>` WAHA-hosted media file
 *                    (inbound / post-echo) back through the proxy.
 *
 * See docs/evaluations/2026-07-18-waha-vs-haberchat.md §4b/§5 for the LID and
 * media-URL findings this adapter is built around.
 */

import { makeServiceClient } from './serviceClient.js';
import type { HaberchatDevice, HaberchatChat, HaberchatMessage } from './whatsappTypes.js';

const OUTBOUND_BUCKET = 'wassel-files';
const OUTBOUND_PREFIX = 'waha-outbound';
const TEMP_REF = 'wt_'; // temp-uploaded outbound media (Supabase Storage)
const WAHA_REF = 'wf_'; // WAHA-hosted media (session/filename under /api/files)
/**
 * Mirrored inbound/outbound media (Supabase Storage) — `wm_<session>/<file>`.
 *
 * WAHA keeps media on the GATEWAY's disk, so a media_file_id is only as durable
 * as the box that served it. Retiring the Fly gateway orphaned 293 messages
 * (their bytes lived under session `wassel_main`), and every re-pair or
 * container restart threatens the rest. Mirroring into our own bucket makes the
 * bytes outlive any gateway. `wf_` refs stay readable: downloadFile falls back
 * to the mirror, and populates it on the way through.
 */
const MIRROR_REF = 'wm_';
const MIRROR_PREFIX = 'whatsapp-media';
const SIGNED_URL_TTL_S = 600;

export class WahaError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

/**
 * WAHA base URL — the PROXY when one is configured.
 *
 * WAHA refuses Vercel's egress with 403 while accepting the Fly worker
 * (verified live 2026-07-26: identical API key, 200 from the worker, 403 from a
 * Vercel function — network-level, not credentials). Setting WAHA_PROXY_URL
 * routes every call in this module through `wassel-wa-agent`, which forwards it
 * with the real key. Unset it and we go direct again, unchanged.
 *
 * The proxy mounts WAHA under `/waha`, so paths stay identical.
 */
function usingProxy(): boolean {
  return Boolean(process.env.WAHA_PROXY_URL);
}

function wahaUrl(): string {
  const proxy = process.env.WAHA_PROXY_URL;
  if (proxy) return `${proxy.replace(/\/+$/, '')}/waha`;
  const u = process.env.WAHA_URL;
  if (!u) throw new WahaError(500, 'WAHA_URL is not set');
  return u.replace(/\/+$/, '');
}

/**
 * Auth header value. Direct calls carry the WAHA API key; proxied calls carry
 * the shared proxy secret instead (the worker attaches the real key), so the
 * gateway credential never has to exist in Vercel's environment.
 */
function wahaKey(): string {
  if (usingProxy()) {
    const s = process.env.WHATSAPP_AI_SECRET;
    if (!s) throw new WahaError(500, 'WHATSAPP_AI_SECRET is not set (required for the WAHA proxy)');
    return s;
  }
  const k = process.env.WAHA_API_KEY;
  if (!k) throw new WahaError(500, 'WAHA_API_KEY is not set');
  return k;
}

/** Header name differs: the proxy authenticates callers, WAHA authenticates us. */
function wahaAuthHeaders(): Record<string, string> {
  return usingProxy()
    ? { 'x-wassel-proxy-secret': wahaKey() }
    : { 'X-Api-Key': wahaKey() };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${wahaUrl()}${path}`, {
    ...init,
    headers: {
      ...wahaAuthHeaders(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    // Put WAHA's own explanation in the MESSAGE, not just the body. The status
    // alone is close to useless — a bare "failed: 422" was shown to the operator
    // while the body said `Session "wassel_main" does not exist`, and that one
    // line was the whole diagnosis. The toast is often the only thing anyone sees.
    const detail = typeof body === 'string'
      ? body
      : (body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : (body != null ? JSON.stringify(body) : ''));
    const suffix = detail ? ` ${detail.slice(0, 200)}` : '';
    throw new WahaError(res.status, `WAHA ${init.method ?? 'GET'} ${path} failed: ${res.status}${suffix}`, body);
  }
  // Some WAHA endpoints (start/stop) return empty bodies.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function svc() {
  const c = makeServiceClient('api:waha');
  if (!c) throw new WahaError(500, 'Supabase service client unavailable (SUPABASE_URL / SERVICE_ROLE_KEY missing)');
  return c;
}

// ─── Identity helpers ────────────────────────────────────────────────

/** A WAHA chat/user id: `<digits>@c.us` (user) or `<digits>@g.us` (group). */
function extractPhoneFromWid(wid: string): string | null {
  const m = wid.match(/^\+?(\d+)@c\.us$/);
  return m ? `+${m[1]}` : null;
}

/**
 * CRITICAL (eval §4b): on GOWS an inbound message's top-level `from` is a LID
 * (`<n>@lid`) with NO phone in the flat payload — the real phone is nested at
 * `_data.Info.SenderAlt = "<digits>@s.whatsapp.net"`. Resolve it so downstream
 * phone→client matching keeps working. Exported for the webhook to reuse.
 */
export function resolveWahaPhone(msg: WahaMessageRaw): string | null {
  const from = typeof msg.from === 'string' ? msg.from : '';
  if (from.endsWith('@c.us')) return extractPhoneFromWid(from);
  // LID or other — dig for SenderAlt / participant phone.
  const alt = msg._data?.Info?.SenderAlt ?? msg._data?.Info?.Sender ?? null;
  if (typeof alt === 'string') {
    const m = alt.match(/^\+?(\d+)@s\.whatsapp\.net$/) ?? alt.match(/^\+?(\d+)@c\.us$/);
    if (m) return `+${m[1]}`;
  }
  return extractPhoneFromWid(from);
}

/**
 * The COUNTERPARTY's phone, in either direction.
 *
 * Inbound, that is the sender (`resolveWahaPhone`). Outbound it is the
 * recipient, and `to` is null on GOWS — the phone lives at
 * `_data.Info.RecipientAlt`, mirroring SenderAlt. Without the outbound leg a
 * LID-addressed message we SENT could not be resolved at all, so it was filed
 * under `<lid>@lid` and spawned a phantom conversation record beside the real
 * one (live 2026-07-27). Inbound never hit this because SenderAlt is usually
 * present — the resolution was one-legged, not absent.
 */
export function resolveWahaCounterpartyPhone(msg: WahaMessageRaw, flow: 'in' | 'out'): string | null {
  if (flow === 'in') return resolveWahaPhone(msg);
  const info = msg._data?.Info;
  for (const cand of [info?.RecipientAlt, info?.Chat, typeof msg.to === 'string' ? msg.to : null]) {
    if (typeof cand !== 'string' || !cand) continue;
    const m = cand.match(/^\+?(\d+)@(?:s\.whatsapp\.net|c\.us)$/);
    if (m) return `+${m[1]}`;
  }
  return null;
}

/**
 * Resolve a WhatsApp LID (`<n>@lid`) to its phone number via WAHA's LID map
 * (`GET /api/{session}/lids/{lid}` → `{lid, pn}`).
 *
 * Needed because inbound webhooks often identify the chat ONLY by LID, and the
 * nested `_data.Info.SenderAlt` phone is not always present (verified live
 * 2026-07-19: a real inbound arrived as `187763857031330@lid` with no
 * SenderAlt). Without this, phone→client matching silently drops the message.
 * Results are cached — the mapping is stable.
 */
const lidCache = new Map<string, string | null>();
export async function resolveLidToPhone(session: string, lid: string): Promise<string | null> {
  const key = `${session}:${lid}`;
  const hit = lidCache.get(key);
  if (hit !== undefined) return hit;
  let phone: string | null = null;
  try {
    const raw = await request<{ lid?: string; pn?: string }>(
      `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
    );
    const m = (raw.pn ?? '').match(/^\+?(\d+)@(?:c\.us|s\.whatsapp\.net)$/);
    if (m) phone = `+${m[1]}`;
  } catch (e) {
    console.error('[waha.resolveLidToPhone] failed for', lid, (e as Error).message);
  }
  lidCache.set(key, phone);
  return phone;
}

/** WAHA ack integer/name → our ack enum. */
function mapAck(ack: number | string | null | undefined): HaberchatMessage['ack'] {
  if (ack == null) return null;
  const s = String(ack).toUpperCase();
  if (s === 'ERROR' || s === '-1') return 'failed';
  if (s === 'PENDING' || s === '0') return 'pending';
  if (s === 'SERVER' || s === '1') return 'sent';
  if (s === 'DEVICE' || s === '2') return 'delivered';
  if (s === 'READ' || s === '3') return 'read';
  if (s === 'PLAYED' || s === '4') return 'played';
  return null;
}

/**
 * WAHA media mimetype → our message kind. Mirrors the webhook's classifier:
 * WhatsApp stickers are image/webp (and WAHA reports MediaType 'sticker'), so
 * they must not be flattened into plain images.
 */
function kindFromMime(mime: string | null | undefined, mediaType?: string | null): HaberchatMessage['kind'] {
  if (mediaType && mediaType.toLowerCase() === 'sticker') return 'sticker';
  if (!mime) return 'document';
  if (mime === 'image/webp') return 'sticker';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// ─── Raw WAHA shapes (only fields we read) ───────────────────────────

interface WahaSessionRaw {
  name?: string;
  status?: string;
  me?: { id?: string; pushName?: string | null } | null;
}

interface WahaChatOverviewRaw {
  id?: string;
  name?: string | null;
  picture?: string | null;
  lastMessage?: { body?: string | null; timestamp?: number | null; fromMe?: boolean } | null;
  _chat?: { conversationTimestamp?: number | null } | null;
}

export interface WahaMessageRaw {
  id?: string;
  timestamp?: number | null;      // seconds
  from?: string | null;
  to?: string | null;
  fromMe?: boolean;
  body?: string | null;
  hasMedia?: boolean;
  media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null;
  ack?: number | string | null;
  ackName?: string | null;
  replyTo?: { id?: string; body?: string | null; participant?: string | null } | null;
  _data?: {
    Info?: {
      Sender?: string | null;
      SenderAlt?: string | null;
      // The counterparty on a message WE sent (the mirror of SenderAlt).
      Chat?: string | null;
      RecipientAlt?: string | null;
      PushName?: string | null;
      Type?: string | null;
      MediaType?: string | null;
    } | null;
  } | null;
  [k: string]: unknown;
}

// ─── Sessions (devices) ──────────────────────────────────────────────

/** List WAHA sessions as devices. Maps a session → HaberchatDevice shape. */
export async function listDevices(): Promise<HaberchatDevice[]> {
  const raw = await request<WahaSessionRaw[]>(`/api/sessions?all=true`);
  const items = Array.isArray(raw) ? raw : [];
  return items.map((s) => {
    const meId = s.me?.id ?? '';
    const phone = meId ? (extractPhoneFromWid(meId) ?? meId.replace(/@.*$/, '')) : '';
    return {
      id: s.name ?? '',
      phone,
      name: s.me?.pushName ?? s.name ?? null,
      status: (s.status ?? '').toLowerCase(),
    } satisfies HaberchatDevice;
  }).filter((d) => d.id);
}

export interface WahaSessionStatus {
  name: string;
  status: string;
  me: { id: string; pushName: string | null } | null;
  activityTs: number | null;
}

/** Full status for one session — feeds the pairing UI + the zombie watchdog. */
export async function getSessionStatus(session: string): Promise<WahaSessionStatus> {
  const raw = await request<WahaSessionRaw & { timestamps?: { activity?: number | null } | null }>(
    `/api/sessions/${encodeURIComponent(session)}`,
  );
  return {
    name: raw.name ?? session,
    status: raw.status ?? 'UNKNOWN',
    me: raw.me?.id ? { id: raw.me.id, pushName: raw.me.pushName ?? null } : null,
    activityTs: raw.timestamps?.activity ?? null,
  };
}

/**
 * Create a session (idempotent-ish: a 422 "already exists" is swallowed) with a
 * per-session webhook pointing at our WAHA webhook, HMAC-signed + retried.
 */
export async function createSession(session: string, webhookUrl: string, hmacKey: string): Promise<void> {
  const config = {
    webhooks: [{
      url: webhookUrl,
      events: ['message', 'message.any', 'message.ack', 'session.status'],
      hmac: { key: hmacKey },
      retries: { policy: 'exponential', delaySeconds: 2, attempts: 6 },
    }],
  };
  try {
    await request(`/api/sessions`, { method: 'POST', body: JSON.stringify({ name: session, start: true, config }) });
  } catch (e) {
    // If it already exists, (re)apply the config + start instead of failing.
    if (e instanceof WahaError && (e.status === 422 || e.status === 409)) {
      await request(`/api/sessions/${encodeURIComponent(session)}`, {
        method: 'PUT', body: JSON.stringify({ config }),
      }).catch(() => { /* PUT may be unsupported on older builds; start still works */ });
      await startSession(session).catch(() => { /* already running */ });
      return;
    }
    throw e;
  }
}

export async function startSession(session: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(session)}/start`, { method: 'POST' });
}

export async function restartSession(session: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(session)}/restart`, { method: 'POST' });
}

/** QR value for pairing (raw string form). */
export async function getQr(session: string): Promise<{ value: string | null }> {
  const raw = await request<{ value?: string | null }>(`/api/${encodeURIComponent(session)}/auth/qr?format=raw`);
  return { value: raw.value ?? null };
}

/** Raw QR image bytes (PNG) for the in-app pairing screen. */
export async function getQrImage(session: string): Promise<Response> {
  const res = await fetch(`${wahaUrl()}/api/${encodeURIComponent(session)}/auth/qr?format=image`, {
    headers: wahaAuthHeaders(),
  });
  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new WahaError(res.status, `WAHA QR image failed: ${res.status} ${preview.slice(0, 120)}`);
  }
  return res;
}

// ─── Chats ───────────────────────────────────────────────────────────

export async function listChats(deviceId: string, opts: { size?: number; page?: number } = {}): Promise<HaberchatChat[]> {
  if (!deviceId) throw new WahaError(400, 'deviceId (session) is required');
  const limit = opts.size ?? 100;
  const offset = (opts.page ?? 0) * limit;
  const raw = await request<WahaChatOverviewRaw[]>(
    `/api/${encodeURIComponent(deviceId)}/chats/overview?limit=${limit}&offset=${offset}`,
  );
  const items = Array.isArray(raw) ? raw : [];
  return items.map((c): HaberchatChat | null => {
    const wid = c.id ?? '';
    if (!wid) return null;
    const kind = wid.endsWith('@g.us') ? 'group' : wid.endsWith('@newsletter') ? 'channel' : 'user';
    const ts = c.lastMessage?.timestamp ?? c._chat?.conversationTimestamp ?? null;
    return {
      wid,
      kind,
      name: c.name ?? null,
      phone: extractPhoneFromWid(wid),
      // WAHA has no per-chat status concept — status is CRM-owned in
      // records.data.status; mergeChatIntoRecord preserves it, so 'active' here
      // is only a seed for a brand-new chat.
      status: 'active',
      ownerAgentId: null,
      labels: [],
      unreadCount: 0,
      lastMessageAt: ts ? new Date(ts * 1000).toISOString() : null,
      lastMessagePreview: c.lastMessage?.body ?? null,
      meta: {},
    };
  }).filter((c): c is HaberchatChat => c !== null);
}

// ─── Messages ────────────────────────────────────────────────────────

export async function listMessages(
  deviceId: string,
  chatWid: string,
  opts: { size?: number; before?: string; downloadMedia?: boolean } = {},
): Promise<HaberchatMessage[]> {
  if (!deviceId) throw new WahaError(400, 'deviceId (session) is required');
  if (!chatWid) throw new WahaError(400, 'chatWid is required');
  const limit = Math.max(1, opts.size ?? 50);
  // downloadMedia defaults TRUE for the thread: with it false WAHA omits the
  // `media` object, so every media message came back with no mimetype and no
  // url — photos, stickers and voice notes all rendered as generic "Document"
  // chips with nothing to open (reported live 2026-07-19).
  // The BACKFILL passes false: it only needs the text history, and making WAHA
  // fetch bytes for thousands of historical messages is far too slow (a
  // 5-chat batch blew past 45s).
  const params = new URLSearchParams({
    limit: String(limit),
    downloadMedia: String(opts.downloadMedia ?? true),
  });
  // `before` is an ISO cursor in the app; WAHA paginates by timestamp.lte (secs).
  if (opts.before) {
    const t = new Date(opts.before).getTime();
    if (Number.isFinite(t)) params.set('timestamp.lte', String(Math.floor(t / 1000) - 1));
  }
  const raw = await request<WahaMessageRaw[]>(
    `/api/${encodeURIComponent(deviceId)}/chats/${encodeURIComponent(chatWid)}/messages?${params.toString()}`,
  );
  const items = Array.isArray(raw) ? raw : [];
  const out = items.map((m) => mapWahaMessage(m, chatWid, deviceId)).filter((m): m is HaberchatMessage => m !== null);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Map a raw WAHA message → the shared HaberchatMessage shape. */
export function mapWahaMessage(m: WahaMessageRaw, fallbackChatWid: string, session: string): HaberchatMessage | null {
  const wid = m.id ?? '';
  if (!wid) return null;
  const flow: 'in' | 'out' = m.fromMe ? 'out' : 'in';
  const mime = m.media?.mimetype ?? null;
  const kind = m.hasMedia || m.media ? kindFromMime(mime, m._data?.Info?.MediaType) : 'text';

  // Media ref: store a compact WAHA-hosted ref `wf_<session>/<filename>` so
  // downloadFile can fetch it back through the proxy (the media.url WAHA returns
  // is a localhost/base URL that the browser cannot reach directly).
  let mediaFileId: string | null = null;
  if (m.media?.url) {
    const fname = m.media.url.split('/').pop() ?? '';
    mediaFileId = fname ? `${WAHA_REF}${session}/${fname}` : null;
  }

  const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
  const date = ts ? new Date(ts * 1000).toISOString() : null;
  if (!date) return null;

  const fromPhone = flow === 'in' ? resolveWahaPhone(m) : null;
  const toPhone = flow === 'out' ? extractPhoneFromWid(String(m.to ?? '')) : null;

  let quoted: HaberchatMessage['quoted'] = null;
  if (m.replyTo?.id) {
    quoted = { wid: m.replyTo.id, body: m.replyTo.body ?? null, kind: 'text' };
  }

  return {
    wid,
    chatWid: fallbackChatWid,
    flow,
    kind,
    subtype: null,
    body: m.body ?? null,
    fromPhone,
    toPhone,
    // Ack is a DELIVERY receipt for messages WE sent. The NOWEB engine reports
    // ack -1 / "ERROR" on INBOUND messages (there is no delivery state to
    // report on someone else's message), which the UI rendered as a red
    // "failed" bubble on perfectly-delivered client messages. Only trust ack
    // on outbound. (Seen live 2026-07-26 after the NOWEB cutover.)
    ack: flow === 'out' ? mapAck(m.ackName ?? m.ack) : null,
    date,
    mediaFileId,
    mediaMime: mime,
    mediaSize: null,
    mediaCaption: null,
    reference: null,
    quoted,
  };
}

// ─── Send ────────────────────────────────────────────────────────────

/**
 * Send a message. WAHA sends are immediate (scheduling is handled by our own
 * queue, not here). Routes by media kind; resolves a `wt_` upload ref to a
 * signed URL. `reference` is not a WAHA concept — we echo the caller's value
 * back so the browser's optimistic-swap keyed by reference still works; the
 * webhook echo then dedups by message id.
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
  deliverAt?: string; // ignored here — see scheduler queue
}): Promise<{ wid: string; status: string; reference: string | null }> {
  if (!input.deviceId) throw new WahaError(400, 'deviceId (session) is required');
  const target = input.phone ?? input.group ?? input.channel;
  if (!target) throw new WahaError(400, 'exactly one of phone / group / channel is required');
  if (!input.body && !input.mediaFileId) throw new WahaError(400, 'body or mediaFileId is required');

  const chatId = toChatId(target, Boolean(input.group), Boolean(input.channel));
  const session = input.deviceId;
  const reply_to = input.quotedWid || undefined;

  let path: string;
  let payload: Record<string, unknown>;

  if (input.mediaFileId) {
    const file = await resolveMediaFile(input.mediaFileId);
    const caption = input.mediaCaption ?? input.body ?? undefined;
    // 'sticker' (image/webp) is sent as an IMAGE — there is no separate sticker
    // send here, and routing it to sendFile would deliver a webp attachment.
    const k = kindFromMime(file.mimetype);
    path =
      k === 'image' || k === 'sticker' ? '/api/sendImage' :
      k === 'video' ? '/api/sendVideo' :
      k === 'audio' ? '/api/sendVoice' : '/api/sendFile';
    payload = { session, chatId, file, reply_to };
    if (k !== 'audio' && caption) payload.caption = caption;
    if (k === 'audio' || k === 'video') payload.convert = true;
  } else {
    path = '/api/sendText';
    payload = { session, chatId, text: input.body, reply_to };
  }

  const raw = await request<{ id?: string; _data?: unknown }>(path, { method: 'POST', body: JSON.stringify(payload) });
  const wid = raw.id ?? '';
  if (!wid) throw new WahaError(502, `WAHA ${path} returned no id`);
  return { wid, status: 'sent', reference: input.reference ?? null };
}

/**
 * The recipient's chat id — the LAST place a phone number can still be wrong.
 *
 * This used to strip non-digits and append `@c.us`, with no country-code logic
 * at all, so a local-format number became `0558333733@c.us`: an unroutable id
 * for a chat nobody has. Normalization existed only in the browser, which is
 * the one caller that did not need it — every server-side sender (workflows,
 * document send, integrations) passes a raw record field straight through
 * (WA-21).
 *
 * Same rules as SQL ksa_phone_canon and the browser's normalizePhone, so all
 * three agree on what "the same number" means. A number that cannot be
 * canonicalized is REJECTED rather than guessed at: sending to the wrong person
 * is worse than not sending.
 */
function toChatId(target: string, isGroup: boolean, isChannel: boolean): string {
  if (target.includes('@')) return target; // already a wid
  const raw = target.replace(/[^\d]/g, '');
  if (isGroup) return `${raw}@g.us`;
  if (isChannel) return `${raw}@newsletter`;

  let d = raw;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `966${d.slice(1)}`;
  else if (d.length === 9) d = `966${d}`;
  if (d.length < 8 || d.length > 15) {
    throw new WahaError(400, `unroutable recipient "${target}" — not a usable phone number`);
  }
  return `${d}@c.us`;
}

/**
 * Extension → mime. The outbound ref carries no content type of its own, and
 * WITHOUT a mime the send classifier fell through to 'document', so every photo
 * we sent arrived as a FILE attachment instead of an inline image (reported
 * live 2026-07-19). Infer it from the stored filename instead.
 */
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

function mimeFromRef(ref: string): string | undefined {
  const clean = ref.split(/[?#]/)[0] ?? '';
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_MIME[clean.slice(dot + 1).toLowerCase()];
}

/** Resolve a mediaFileId to a WAHA `file` payload ({url} or passthrough). */
async function resolveMediaFile(mediaFileId: string): Promise<{ url: string; mimetype?: string; filename?: string }> {
  if (mediaFileId.startsWith('http://') || mediaFileId.startsWith('https://')) {
    return { url: mediaFileId, mimetype: mimeFromRef(mediaFileId) };
  }
  if (mediaFileId.startsWith(TEMP_REF)) {
    const path = mediaFileId.slice(TEMP_REF.length);
    const { data, error } = await svc().storage.from(OUTBOUND_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
    if (error || !data?.signedUrl) throw new WahaError(502, `WAHA media temp signed-url failed: ${error?.message ?? 'no url'}`);
    return { url: data.signedUrl, filename: path.split('/').pop(), mimetype: mimeFromRef(path) };
  }
  if (mediaFileId.startsWith(MIRROR_REF)) {
    const path = `${MIRROR_PREFIX}/${mediaFileId.slice(MIRROR_REF.length)}`;
    const { data, error } = await svc().storage.from(OUTBOUND_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
    if (error || !data?.signedUrl) throw new WahaError(502, `WAHA mirrored media signed-url failed: ${error?.message ?? 'no url'}`);
    return { url: data.signedUrl, filename: path.split('/').pop(), mimetype: mimeFromRef(path) };
  }
  throw new WahaError(400, `Unresolvable mediaFileId for WAHA: ${mediaFileId.slice(0, 24)}`);
}

// ─── File upload (temp-store the bytes for the two-step send) ─────────

export async function uploadFile(formData: FormData): Promise<{ fileId: string; mime: string | null; size: number | null; filename: string | null }> {
  const file = formData.get('file');
  // Duck-type the multipart entry: a Blob/File exposes arrayBuffer() + type;
  // (`File` isn't a value type in the API tsconfig lib set).
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    throw new WahaError(400, 'multipart field "file" is required');
  }
  const blob = file as Blob & { name?: string };
  const name = typeof blob.name === 'string' && blob.name ? blob.name : 'upload.bin';
  const mime = blob.type || 'application/octet-stream';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : (mime.split('/')[1] ?? 'bin');
  // Deterministic-enough unique path (no Date.now/random constraints here — this
  // runs in the Vercel runtime, not a workflow script).
  const uid = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  const path = `${OUTBOUND_PREFIX}/${uid}.${ext}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error } = await svc().storage.from(OUTBOUND_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new WahaError(502, `WAHA outbound temp upload failed: ${error.message}`);
  return { fileId: `${TEMP_REF}${path}`, mime, size: bytes.byteLength, filename: name };
}

// ─── File download (proxy streams media back to the browser) ─────────

export async function downloadFile(fileId: string, _deviceId?: string): Promise<Response> {
  if (!fileId) throw new WahaError(400, 'fileId is required');

  // Temp outbound object (pre-webhook optimistic bubble) → stream from storage.
  if (fileId.startsWith(TEMP_REF)) {
    const path = fileId.slice(TEMP_REF.length);
    const { data, error } = await svc().storage.from(OUTBOUND_BUCKET).download(path);
    if (error || !data) throw new WahaError(404, `WAHA temp media not found: ${error?.message ?? path}`);
    return new Response(data, { headers: { 'Content-Type': data.type || 'application/octet-stream' } });
  }

  // Mirrored media `wm_<session>/<filename>` → our own bucket, gateway-independent.
  if (fileId.startsWith(MIRROR_REF)) {
    const path = fileId.slice(MIRROR_REF.length);
    return mirrorResponse(path);
  }

  // WAHA-hosted media `wf_<session>/<filename>` → fetch WAHA's file endpoint
  // with the API key (the browser can't send the key, so we proxy it).
  const path = fileId.startsWith(WAHA_REF) ? fileId.slice(WAHA_REF.length) : fileId;
  const res = await fetch(`${wahaUrl()}/api/files/${path}`, { headers: wahaAuthHeaders() });
  if (!res.ok) {
    // The gateway no longer has it (retired host, re-pair, restart — WAHA's file
    // dir is per-gateway). Serve the mirror if we took a copy; only report the
    // gateway's failure when we have no copy either, so a stale `wf_` ref keeps
    // working instead of rendering as a broken bubble.
    const preview = await res.text().catch(() => '');
    try {
      return await mirrorResponse(path);
    } catch {
      throw new WahaError(res.status, `WAHA file download failed: ${res.status} ${preview.slice(0, 120)}`);
    }
  }

  // Cache-through: keep a copy so this media survives the gateway that served
  // it. Buffered because the body can only be consumed once. Never fatal — a
  // mirroring failure must not break the download the user asked for.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  void svc().storage.from(OUTBOUND_BUCKET)
    .upload(`${MIRROR_PREFIX}/${path}`, bytes, { contentType, upsert: false })
    .then(({ error }) => {
      // "already exists" is the steady state once mirrored, not a problem.
      if (error && !/exists/i.test(error.message)) {
        console.error('[waha.downloadFile] mirror upload failed for', path, error.message);
      }
    });
  return new Response(bytes, { headers: { 'Content-Type': contentType } });
}

/** Stream mirrored bytes for `<session>/<filename>`; throws if we hold no copy. */
async function mirrorResponse(path: string): Promise<Response> {
  const { data, error } = await svc().storage.from(OUTBOUND_BUCKET).download(`${MIRROR_PREFIX}/${path}`);
  if (error || !data) throw new WahaError(404, `mirrored media not found: ${error?.message ?? path}`);
  return new Response(data, {
    headers: { 'Content-Type': data.type || mimeFromRef(path) || 'application/octet-stream' },
  });
}

// ─── Chat status / labels ────────────────────────────────────────────

/**
 * WAHA has no per-chat "status" (active/resolved/archived) concept — that is
 * Wassenger CRM sugar. Under WAHA, status is fully CRM-owned in
 * records.data.status, so the status half of a patch is a deliberate NO-OP.
 * Labels map to WAHA's label API (best-effort; failures don't block).
 */
export async function patchChat(
  deviceId: string,
  chatWid: string,
  patch: { status?: 'active' | 'resolved' | 'archived'; labels?: string[] },
): Promise<void> {
  if (!deviceId || !chatWid) throw new WahaError(400, 'deviceId and chatWid are required');
  if (patch.labels) {
    // WAHA: PUT /api/{session}/chats/{chatId}/labels body {labels:[{id}]}. Label
    // ids differ from Haberchat's free-text labels; this is best-effort and the
    // app currently has no label-editing UI, so a failure is swallowed.
    try {
      await request(`/api/${encodeURIComponent(deviceId)}/chats/${encodeURIComponent(chatWid)}/labels`, {
        method: 'PUT',
        body: JSON.stringify({ labels: patch.labels.map((id) => ({ id })) }),
      });
    } catch { /* labels are non-critical under WAHA v1 */ }
  }
  // status: intentionally no-op (CRM-owned).
}
