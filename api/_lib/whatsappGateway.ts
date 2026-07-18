/**
 * Provider-dispatching WhatsApp gateway. The `api/haberchat/*` proxies import
 * from HERE instead of `./haberchat` directly, so each call is routed to the
 * right backend by the number's `whatsapp_numbers.provider` flag:
 *   'haberchat' (default) → api/_lib/haberchat.ts   (Wassenger whitelabel)
 *   'waha'                → api/_lib/waha.ts         (self-hosted, GOWS)
 *
 * The routing key is `deviceId` (a Haberchat 24-hex id OR a WAHA session name —
 * both opaque strings). This file is the ONLY place that knows two providers
 * exist; the proxies, browser client, normalize, and store are unchanged.
 *
 * Default provider is 'haberchat' for any unknown device id, so the system is
 * inert until a `whatsapp_numbers` row is set to provider='waha'.
 */

import { makeServiceClient } from './serviceClient';
import * as haberchat from './haberchat';
import * as waha from './waha';
import { HaberchatError } from './haberchat';
import { WahaError } from './waha';
import type { HaberchatDevice, HaberchatChat, HaberchatMessage } from './haberchat';

export type Provider = 'haberchat' | 'waha';

/**
 * Translate a WahaError into a HaberchatError so the `api/haberchat/*` proxies'
 * existing `err instanceof HaberchatError` handling maps WAHA failures to the
 * same HTTP responses without any proxy change.
 */
async function dispatch<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WahaError) throw new HaberchatError(e.status, e.message, e.body);
    throw e;
  }
}

// ─── provider resolution (short-TTL cache to avoid a DB hit per proxy call) ──

interface CacheEntry { provider: Provider; at: number }
const providerCache = new Map<string, CacheEntry>();
const PROVIDER_TTL_MS = 60_000;
let anyWahaCache: { value: boolean; at: number } | null = null;

/**
 * WAHA is configured only when WAHA_URL is set (cutover). Until then EVERY
 * number is Haberchat, so the provider lookups short-circuit WITHOUT touching
 * Supabase. This also fixed a live edge-runtime hang: doing the whatsapp_numbers
 * lookup on the hot proxy path timed the edge function out at 25s (devices/chats
 * 504'd) — skipping it when WAHA is off keeps the Haberchat path identical to
 * before, and the timeout guard below makes the lookup fail-safe at cutover.
 */
function wahaConfigured(): boolean {
  return !!process.env.WAHA_URL;
}

// Memoized service client (avoid re-creating per request) + a hard timeout so a
// slow/hung Supabase call can never stall a proxy response.
let cachedSvc: ReturnType<typeof makeServiceClient> | undefined;
function svcClient() {
  if (cachedSvc === undefined) cachedSvc = makeServiceClient('api:wa-gateway');
  return cachedSvc;
}
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}

/** Resolve the provider for a device id. Defaults to 'haberchat' when unknown. */
export async function providerFor(deviceId: string | null | undefined): Promise<Provider> {
  if (!deviceId || !wahaConfigured()) return 'haberchat';
  const hit = providerCache.get(deviceId);
  if (hit && Date.now() - hit.at < PROVIDER_TTL_MS) return hit.provider;

  const provider = await withTimeout((async (): Promise<Provider> => {
    const svc = svcClient();
    if (!svc) return 'haberchat';
    const { data } = await svc
      .from('whatsapp_numbers')
      .select('provider')
      .eq('device_id', deviceId)
      .maybeSingle();
    return data?.provider === 'waha' ? 'waha' : 'haberchat';
  })(), 2500, 'haberchat');
  providerCache.set(deviceId, { provider, at: Date.now() });
  return provider;
}

/**
 * Provider of the default active number — used to route calls that carry no
 * device id (Haberchat's upload is account-scoped, so the app's uploadFile has
 * historically taken no device). Correct for a single-number tenant; a
 * multi-number caller should pass an explicit deviceId.
 */
async function defaultProvider(): Promise<Provider> {
  if (!wahaConfigured()) return 'haberchat';
  return withTimeout((async (): Promise<Provider> => {
    const svc = svcClient();
    if (!svc) return 'haberchat';
    const { data } = await svc
      .from('whatsapp_numbers')
      .select('provider')
      .eq('is_active', true)
      .eq('is_default', true)
      .maybeSingle();
    return data?.provider === 'waha' ? 'waha' : 'haberchat';
  })(), 2500, 'haberchat');
}

/** True if ANY WAHA number is configured (so listDevices should also poll WAHA). */
async function anyWahaConfigured(): Promise<boolean> {
  if (!wahaConfigured()) return false;
  if (anyWahaCache && Date.now() - anyWahaCache.at < PROVIDER_TTL_MS) return anyWahaCache.value;
  const value = await withTimeout((async (): Promise<boolean> => {
    const svc = svcClient();
    if (!svc) return false;
    const { data } = await svc.from('whatsapp_numbers').select('device_id').eq('provider', 'waha').limit(1);
    return Boolean(data && data.length > 0);
  })(), 2500, false);
  anyWahaCache = { value, at: Date.now() };
  return value;
}

// ─── dispatched surface (same signatures the proxies already call) ──────────

export function defaultDeviceId(): string | null {
  return haberchat.defaultDeviceId();
}

/** Merge devices from both providers. One provider failing never kills the list. */
export async function listDevices(): Promise<HaberchatDevice[]> {
  const out: HaberchatDevice[] = [];
  try {
    out.push(...(await haberchat.listDevices()));
  } catch (e) {
    console.error('[wa-gateway] haberchat.listDevices failed:', (e as Error).message);
  }
  if (await anyWahaConfigured()) {
    try {
      out.push(...(await waha.listDevices()));
    } catch (e) {
      console.error('[wa-gateway] waha.listDevices failed:', (e as Error).message);
    }
  }
  return out;
}

export async function listChats(deviceId: string, opts: { size?: number; page?: number } = {}): Promise<HaberchatChat[]> {
  return dispatch(async () => (await providerFor(deviceId)) === 'waha'
    ? waha.listChats(deviceId, opts)
    : haberchat.listChats(deviceId, opts));
}

export async function listMessages(
  deviceId: string,
  chatWid: string,
  opts: { size?: number; before?: string } = {},
): Promise<HaberchatMessage[]> {
  return dispatch(async () => (await providerFor(deviceId)) === 'waha'
    ? waha.listMessages(deviceId, chatWid, opts)
    : haberchat.listMessages(deviceId, chatWid, opts));
}

export async function sendMessage(input: Parameters<typeof haberchat.sendMessage>[0]): ReturnType<typeof haberchat.sendMessage> {
  return dispatch(async () => (await providerFor(input.deviceId)) === 'waha'
    ? waha.sendMessage(input)
    : haberchat.sendMessage(input));
}

/**
 * Upload media. Haberchat's upload is account-scoped (no device), so a call
 * with no deviceId keeps the legacy Haberchat behavior. A WAHA send must pass
 * the WAHA device id so the bytes are temp-stashed for the two-step send.
 */
export async function uploadFile(
  formData: FormData,
  deviceId?: string,
): Promise<{ fileId: string; mime: string | null; size: number | null; filename: string | null }> {
  return dispatch(async () => {
    const provider = deviceId ? await providerFor(deviceId) : await defaultProvider();
    return provider === 'waha' ? waha.uploadFile(formData) : haberchat.uploadFile(formData);
  });
}

export async function downloadFile(fileId: string, deviceId?: string): Promise<Response> {
  return dispatch(async () => {
    // WAHA media refs carry their own prefix (`wt_`/`wf_`), so route on the ref
    // shape first, then fall back to the device's provider.
    if (fileId.startsWith('wt_') || fileId.startsWith('wf_')) return waha.downloadFile(fileId, deviceId);
    return deviceId && (await providerFor(deviceId)) === 'waha'
      ? waha.downloadFile(fileId, deviceId)
      : haberchat.downloadFile(fileId, deviceId);
  });
}

export async function patchChat(
  deviceId: string,
  chatWid: string,
  patch: { status?: 'active' | 'resolved' | 'archived'; labels?: string[] },
): Promise<void> {
  return dispatch(async () => (await providerFor(deviceId)) === 'waha'
    ? waha.patchChat(deviceId, chatWid, patch)
    : haberchat.patchChat(deviceId, chatWid, patch));
}

/**
 * If this is a SCHEDULED send on a WAHA number, enqueue it into the Wassell-
 * owned scheduled_whatsapp_jobs queue (WAHA has no native deliverAt) and return
 * a scheduled result; otherwise return null so the caller sends immediately.
 * Haberchat scheduled sends fall through to null (they use Haberchat's native
 * deliverAt via sendMessage).
 */
export async function maybeScheduleWaha(
  input: { deviceId: string; phone?: string; body?: string; mediaFileId?: string; mediaCaption?: string; reference?: string; deliverAt?: string },
  userId: string,
): Promise<{ wid: string; status: string; reference: string | null } | null> {
  if (!input.deliverAt) return null;
  if ((await providerFor(input.deviceId)) !== 'waha') return null;
  const svc = makeServiceClient('api:wa-gateway');
  if (!svc) throw new HaberchatError(500, 'Supabase service client unavailable');
  const phone = input.phone ?? '';
  const digits = phone.replace(/\D/g, '');
  const chatWid = `${digits}@c.us`;
  const media = input.mediaFileId
    ? [{ fileId: input.mediaFileId, caption: input.mediaCaption ?? null }]
    : [];
  const { data, error } = await svc.rpc('scheduled_whatsapp_enqueue', {
    p_device_id: input.deviceId,
    p_chat_wid: chatWid,
    p_phone: phone || null,
    p_body: input.body ?? null,
    p_media: media,
    p_reference: input.reference ?? null,
    p_deliver_at: input.deliverAt,
    p_user_id: userId,
  });
  if (error) throw new HaberchatError(502, `scheduled_whatsapp_enqueue failed: ${error.message}`);
  return { wid: `scheduled:${data}`, status: 'scheduled', reference: input.reference ?? null };
}

// ─── scheduled-message strip (list + cancel), provider-dispatched ────────────

interface QueuedMessage { id: string; phone: string | null; body: string | null; deliverAt: string | null; createdAt: string | null; hasMedia: boolean }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** List queued messages for the open chat. WAHA reads our own queue; Haberchat
 *  reads its native delivery queue. Same ScheduledChatMessage shape either way. */
export async function listScheduled(deviceId: string, phone?: string): Promise<QueuedMessage[]> {
  if ((await providerFor(deviceId)) === 'waha') {
    const svc = makeServiceClient('api:wa-gateway');
    if (!svc) return [];
    const digits = (phone ?? '').replace(/\D/g, '');
    const chatWid = `${digits}@c.us`;
    const { data, error } = await svc.rpc('scheduled_whatsapp_list_for_chat', { p_device_id: deviceId, p_chat_wid: chatWid });
    if (error) throw new HaberchatError(502, `scheduled_whatsapp_list_for_chat failed: ${error.message}`);
    return ((data ?? []) as Array<{ id: string; phone: string | null; body: string | null; deliver_at: string | null; created_at: string | null; has_media: boolean }>)
      .map((r) => ({ id: r.id, phone: r.phone, body: r.body, deliverAt: r.deliver_at, createdAt: r.created_at, hasMedia: r.has_media }));
  }
  return dispatch(() => haberchat.listQueuedMessages(deviceId, phone));
}

/** Cancel a queued message. A UUID id is one of OUR scheduled_whatsapp_jobs;
 *  anything else is a Haberchat native queue id. */
export async function cancelScheduled(id: string): Promise<void> {
  if (UUID_RE.test(id)) {
    const svc = makeServiceClient('api:wa-gateway');
    if (!svc) throw new HaberchatError(500, 'Supabase service client unavailable');
    const { error } = await svc.rpc('scheduled_whatsapp_cancel', { p_job_id: id });
    if (error) throw new HaberchatError(502, `scheduled_whatsapp_cancel failed: ${error.message}`);
    return;
  }
  return dispatch(() => haberchat.deleteQueuedMessage(id));
}

// Re-export the Haberchat error type so proxies' `instanceof` checks keep working
// for the common path; WAHA errors are translated to it by dispatch().
export { HaberchatError };
