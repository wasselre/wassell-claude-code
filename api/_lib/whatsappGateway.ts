/**
 * The WhatsApp gateway.
 *
 * One provider: the self-hosted WAHA gateway (`api/_lib/waha.ts`). This file
 * used to DISPATCH between WAHA and Haberchat on `whatsapp_numbers.provider`;
 * Haberchat was retired on 2026-07-28 (WA-28) and its adapter deleted, so what
 * remains is the shared surface the `api/haberchat/*` proxies, the browser
 * client and the store already call — plus the things that are genuinely this
 * layer's job:
 *
 *   sendDeviceId()          a chat records the device it was LAST SEEN on, and
 *                           a re-pair retires that session name, so a send
 *                           resolves to an ACTIVE number before it goes out.
 *   maybeScheduleWaha()     WAHA has no server-side deliverAt, so a scheduled
 *                           send goes into our own queue.
 *   listScheduled/cancel    that queue, in the shape the strip already reads.
 *
 * The route paths keep the `haberchat` name because renaming them means
 * changing every caller in the browser for no behavioural gain.
 */

import { makeServiceClient } from './serviceClient.js';
import * as waha from './waha.js';
import { HaberchatError } from './whatsappTypes.js';
import { WahaError } from './waha.js';
import type { HaberchatDevice, HaberchatChat, HaberchatMessage } from './whatsappTypes.js';

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

/**
 * Last provider we RESOLVED successfully for a device, kept without a TTL.
 *
 * Separate from `providerCache` on purpose: that one expires so a provider flip
 * is picked up quickly, this one is the memory of the last verified answer and
 * is only consulted when the lookup itself fails.
 */
const lastKnownProvider = new Map<string, Provider>();

/**
 * Resolve the provider for a device id.
 *
 * A lookup timeout used to resolve to 'haberchat' and CACHE that for 60
 * seconds. Haberchat is retired — its account 403s every request — so a slow
 * database turned into a minute of sends routed to a dead gateway, silently
 * (WA-18, audit 2026-07-28). The default was chosen when Haberchat was the live
 * provider and the safe answer; it stopped being either.
 *
 * On failure we now reuse the last VERIFIED answer for that device, and if
 * there is none we throw. A send that fails loudly can be retried; a send
 * handed to a dead provider is just gone.
 */
export async function providerFor(deviceId: string | null | undefined): Promise<Provider> {
  if (!deviceId || !wahaConfigured()) return 'haberchat';
  const hit = providerCache.get(deviceId);
  if (hit && Date.now() - hit.at < PROVIDER_TTL_MS) return hit.provider;

  const TIMED_OUT = Symbol('timeout');
  const resolved = await withTimeout<Provider | typeof TIMED_OUT>((async () => {
    const svc = svcClient();
    if (!svc) return TIMED_OUT;
    const { data, error } = await svc
      .from('whatsapp_numbers')
      .select('provider')
      .eq('device_id', deviceId)
      .maybeSingle();
    if (error) return TIMED_OUT;
    // Haberchat is RETIRED (2026-07-28, confirmed by the operator: never
    // falling back). An unknown device id used to read as 'haberchat' because
    // that was the older default; routing anything there now guarantees a
    // failure, so an unrecognised device resolves to the live provider.
    return data?.provider === 'haberchat' ? 'haberchat' : 'waha';
  })(), 2500, TIMED_OUT);

  if (resolved === TIMED_OUT) {
    const remembered = lastKnownProvider.get(deviceId);
    if (remembered) {
      console.warn(`[wa-gateway] provider lookup failed for "${deviceId}" — reusing last verified provider "${remembered}"`);
      return remembered;
    }
    throw new HaberchatError(
      503,
      `cannot determine the WhatsApp provider for "${deviceId}" (lookup unavailable) — refusing to guess`,
    );
  }

  providerCache.set(deviceId, { provider: resolved, at: Date.now() });
  lastKnownProvider.set(deviceId, resolved);
  return resolved;
}

// ─── dispatched surface (same signatures the proxies already call) ──────────

/**
 * There is no env-configured default any more. HABERCHAT_DEFAULT_DEVICE_ID named
 * a device on a retired provider and was never set in production; the real
 * default lives in `whatsapp_numbers` and is read by resolveDefaultDeviceId().
 */
export function defaultDeviceId(): string | null {
  return null;
}

/**
 * The device id of the ACTIVE DEFAULT number, whatever provider it is on.
 *
 * Server-side senders (send-document, the workflow runner, the on-due sweeper)
 * historically fell back to `defaultDeviceId()` = HABERCHAT_DEFAULT_DEVICE_ID.
 * After the WAHA cutover that env still names the DEAD Haberchat device, so
 * those paths would keep sending through a dead gateway. Resolve the real
 * default from whatsapp_numbers instead, falling back to the env only when the
 * table has no active default.
 */
export async function resolveDefaultDeviceId(): Promise<string | null> {
  const fallback = defaultDeviceId();
  const svc = svcClient();
  if (!svc) return fallback;
  try {
    return await withTimeout((async (): Promise<string | null> => {
      const { data } = await svc
        .from('whatsapp_numbers')
        .select('device_id')
        .eq('is_active', true)
        .eq('is_default', true)
        .maybeSingle();
      const id = (data as { device_id?: string } | null)?.device_id;
      return (typeof id === 'string' && id) ? id : fallback;
    })(), 2500, fallback);
  } catch {
    // Never let device resolution break a send — fall back to the env value.
    return fallback;
  }
}

/**
 * The device id of the ACTIVE OPERATIONS number, or null if none is designated.
 *
 * The operations line is for INTERNAL operational outreach (notifying project
 * officers that a customer wants to visit) — deliberately a DIFFERENT number
 * from the sales/customer default so the two inboxes and the two outbound
 * identities stay separate. Marked by `is_operations` on whatsapp_numbers so
 * swapping which SIM is "operations" is a one-row change, not a code edit.
 *
 * Returns null (never the sales default) when no ops line is configured — the
 * caller must decide what to do, because silently falling back to the sales
 * number is exactly the mix-up this whole separation exists to prevent.
 */
export async function resolveOperationsDeviceId(): Promise<string | null> {
  const svc = svcClient();
  if (!svc) return null;
  try {
    return await withTimeout((async (): Promise<string | null> => {
      const { data } = await svc
        .from('whatsapp_numbers')
        .select('device_id')
        .eq('is_active', true)
        .eq('is_operations', true)
        .maybeSingle();
      const id = (data as { device_id?: string } | null)?.device_id;
      return (typeof id === 'string' && id) ? id : null;
    })(), 2500, null);
  } catch {
    // Never let device resolution throw into a caller — no ops line resolvable.
    return null;
  }
}

/** Merge devices from both providers. One provider failing never kills the list. */
export async function listDevices(): Promise<HaberchatDevice[]> {
  try {
    return await waha.listDevices();
  } catch (e) {
    console.error('[wa-gateway] waha.listDevices failed:', (e as Error).message);
    return [];
  }
}

export async function listChats(deviceId: string, opts: { size?: number; page?: number } = {}): Promise<HaberchatChat[]> {
  return dispatch(() => waha.listChats(deviceId, opts));
}

export async function listMessages(
  deviceId: string,
  chatWid: string,
  opts: { size?: number; before?: string } = {},
): Promise<HaberchatMessage[]> {
  return dispatch(() => waha.listMessages(deviceId, chatWid, opts));
}

/**
 * The device a send should actually go out on.
 *
 * A chat records the device it was LAST SEEN on, and under WAHA the device id IS
 * the gateway session name. Re-pairing onto a new session (`wassel_main` →
 * `sales`, 2026-07-24) therefore stranded every older conversation: 263 of 310
 * chats still pointed at `wassel_main`, so every send from them died with WAHA
 * 422 `Session "wassel_main" does not exist` — the same number, just an id the
 * gateway had retired.
 *
 * Historical attribution is worth keeping on the message rows, but it must not
 * decide where a NEW message goes: if the chat's device is not an active row,
 * send on the active default instead. Returns the input unchanged whenever it is
 * active, so multi-number setups keep routing per chat.
 */
async function sendDeviceId(deviceId: string | null | undefined): Promise<string | null | undefined> {
  if (!deviceId) return deviceId;
  const svc = svcClient();
  if (!svc) return deviceId;
  try {
    return await withTimeout((async () => {
      const { data } = await svc
        .from('whatsapp_numbers')
        .select('is_active')
        .eq('device_id', deviceId)
        .maybeSingle();
      if ((data as { is_active?: boolean } | null)?.is_active) return deviceId;
      const fallback = await resolveDefaultDeviceId();
      if (fallback && fallback !== deviceId) {
        console.warn(`[whatsappGateway] device "${deviceId}" is retired/unknown — sending on "${fallback}"`);
        return fallback;
      }
      return deviceId;
    })(), 2500, deviceId);
  } catch {
    // Never let device resolution break a send.
    return deviceId;
  }
}

export async function sendMessage(input: Parameters<typeof waha.sendMessage>[0]): ReturnType<typeof waha.sendMessage> {
  const deviceId = await sendDeviceId(input.deviceId);
  const next = deviceId === input.deviceId ? input : { ...input, deviceId };
  return dispatch(() => waha.sendMessage(next as Parameters<typeof waha.sendMessage>[0]));
}

/**
 * Upload media.
 *
 * WAHA has no pre-upload step, so this stashes the bytes in our own bucket and
 * returns a `wt_` ref that sendMessage resolves to a signed URL. The optional
 * `deviceId` is kept in the signature because every caller passes it and WAHA
 * simply does not need it — dropping the parameter would churn call sites to
 * remove an argument that costs nothing.
 */
export async function uploadFile(
  formData: FormData,
  _deviceId?: string,
): Promise<{ fileId: string; mime: string | null; size: number | null; filename: string | null }> {
  return dispatch(() => waha.uploadFile(formData));
}

/**
 * A bare 24-char hex id is a Haberchat ObjectId — an attachment from the
 * retired provider. Its account is gone (the file endpoint answers 403 "The API
 * token provided is invalid" for every id, checked 2026-07-28), so there is
 * nothing to fetch.
 *
 * This has to be decided on the REF, not the device. 565 such rows sit on chats
 * whose `device_id` was re-pointed to the live WAHA session on 2026-07-27, so
 * the provider lookup sends them to WAHA, which answers `404 ENOENT` — a
 * confusing error about the wrong system for a file neither system has.
 */
const HABERCHAT_OBJECT_ID = /^[0-9a-f]{24}$/i;

export async function downloadFile(fileId: string, deviceId?: string): Promise<Response> {
  return dispatch(async () => {
    if (HABERCHAT_OBJECT_ID.test(fileId)) {
      throw new HaberchatError(410, 'legacy_media_unavailable: attachment predates the WhatsApp provider change and is no longer stored');
    }
    // WAHA media refs carry their own prefix (`wt_`/`wf_`), so route on the ref
    // shape first, then fall back to the device's provider.
    if (fileId.startsWith('wt_') || fileId.startsWith('wf_')) return waha.downloadFile(fileId, deviceId);
    return waha.downloadFile(fileId, deviceId);
  });
}

export async function patchChat(
  deviceId: string,
  chatWid: string,
  patch: { status?: 'active' | 'resolved' | 'archived'; labels?: string[] },
): Promise<void> {
  return dispatch(() => waha.patchChat(deviceId, chatWid, patch));
}

// Must match OUTBOUND_BUCKET / TEMP_REF in api/_lib/waha.ts AND the worker's
// copy in worker/src/waha.ts — the wt_ ref is signed against this bucket.
const WA_TEMP_BUCKET = 'wassel-files';
const STORAGE_SIGNED_URL_RE = /\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/;

/**
 * Normalize a mediaFileId into the shape the WORKER's resolver understands:
 * `{fileId: 'wt_<path>'}` (re-signed at send time) or `{url}` (sendable as-is).
 * A signed URL is only valid for minutes while delivery can be hours away, so
 * a signed wassel-files URL is converted back to its re-signable wt_ ref; a
 * signed URL on any other bucket cannot be re-signed by the worker and is
 * rejected loudly at schedule time instead of silently failing at delivery.
 */
function scheduledMediaItem(
  mediaFileId: string,
  caption: string | null,
): { fileId?: string; url?: string; caption: string | null } {
  if (mediaFileId.startsWith('wt_')) return { fileId: mediaFileId, caption };
  if (/^https?:\/\//.test(mediaFileId)) {
    const m = mediaFileId.match(STORAGE_SIGNED_URL_RE);
    if (m) {
      const bucket = decodeURIComponent(m[1]!);
      if (bucket !== WA_TEMP_BUCKET) {
        throw new HaberchatError(400, `Cannot schedule media from a signed '${bucket}' URL — it expires before delivery`);
      }
      return { fileId: `wt_${decodeURIComponent(m[2]!)}`, caption };
    }
    return { url: mediaFileId, caption };
  }
  throw new HaberchatError(400, `Unschedulable media ref for WAHA: ${mediaFileId.slice(0, 24)}`);
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
  const svc = makeServiceClient('api:wa-gateway');
  if (!svc) throw new HaberchatError(500, 'Supabase service client unavailable');
  const phone = input.phone ?? '';
  const digits = phone.replace(/\D/g, '');
  const chatWid = `${digits}@c.us`;
  const media = input.mediaFileId
    ? [scheduledMediaItem(input.mediaFileId, input.mediaCaption ?? null)]
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

  // WhatsApp activity bridge (2026-07-22): SCHEDULING a message means the rep
  // has handled this client NOW — arm the waiting-for-customer state at
  // enqueue time (deadline anchored to the delivery time) instead of leaving
  // the task in "your court" until the worker actually delivers. When the
  // send really happens, the webhook reconciler re-arms with actual
  // timestamps, so any drift self-corrects. Best-effort: a failure here must
  // never fail the schedule (same posture as chatIngest).
  try {
    const { data: clientId, error: findErr } = await svc.rpc('find_client_id_by_phone', { p_phone: phone });
    if (findErr) {
      console.error('[wa-gateway] find_client_id_by_phone failed:', findErr.message);
    } else if (typeof clientId === 'string' && clientId) {
      const { error: recErr } = await svc.rpc('reconcile_outbound_whatsapp', {
        p_client_id: clientId,
        p_message_at: input.deliverAt,
      });
      if (recErr) console.error('[wa-gateway] schedule-time reconcile_outbound_whatsapp failed:', recErr.message);
    }
  } catch (err) {
    console.error('[wa-gateway] schedule-time reconcile threw:', err instanceof Error ? err.message : String(err));
  }

  return { wid: `scheduled:${data}`, status: 'scheduled', reference: input.reference ?? null };
}

// ─── scheduled-message strip (list + cancel), provider-dispatched ────────────

interface QueuedMessage { id: string; phone: string | null; body: string | null; deliverAt: string | null; createdAt: string | null; hasMedia: boolean }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** List queued messages for the open chat. WAHA reads our own queue; Haberchat
 *  reads its native delivery queue. Same ScheduledChatMessage shape either way. */
export async function listScheduled(deviceId: string, phone?: string): Promise<QueuedMessage[]> {
  {
    const svc = makeServiceClient('api:wa-gateway');
    if (!svc) return [];
    const digits = (phone ?? '').replace(/\D/g, '');
    const chatWid = `${digits}@c.us`;
    const { data, error } = await svc.rpc('scheduled_whatsapp_list_for_chat', { p_device_id: deviceId, p_chat_wid: chatWid });
    if (error) throw new HaberchatError(502, `scheduled_whatsapp_list_for_chat failed: ${error.message}`);
    return ((data ?? []) as Array<{ id: string; phone: string | null; body: string | null; deliver_at: string | null; created_at: string | null; has_media: boolean }>)
      .map((r) => ({ id: r.id, phone: r.phone, body: r.body, deliverAt: r.deliver_at, createdAt: r.created_at, hasMedia: r.has_media }));
  }
  // Unreachable: every number is WAHA, handled above.
  return [];
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
  throw new HaberchatError(400, `unrecognised scheduled-message id: ${id}`);
}

// Re-export the Haberchat error type so proxies' `instanceof` checks keep working
// for the common path; WAHA errors are translated to it by dispatch().
export { HaberchatError };
