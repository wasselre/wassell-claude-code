/**
 * Send-only WAHA client for the Fly worker's scheduled-message queue.
 *
 * The worker is a standalone npm package and cannot import from `api/_lib`
 * (same posture as `worker/src/imageGen.ts`), so the send surface WAHA needs is
 * duplicated here. Keep in sync with the send half of `api/_lib/waha.ts`.
 *
 * Media refs in a scheduled_whatsapp_jobs row:
 *   { fileId: 'wt_<path>' }  → private wassel-files temp object → signed URL
 *   { url: 'https://…' }      → a directly-sendable public URL (gallery items)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const OUTBOUND_BUCKET = 'wassel-files';
const MIRROR_PREFIX = 'whatsapp-media';
const TEMP_REF = 'wt_';
const SIGNED_URL_TTL_S = 600;

export interface WahaSendConfig {
  url: string;      // WAHA_URL
  apiKey: string;   // WAHA_API_KEY
  supabase: SupabaseClient; // for resolving wt_ temp media to a signed URL
}

export interface ScheduledMediaItem {
  fileId?: string;
  url?: string;
  kind?: 'image' | 'video' | 'audio' | 'document';
  caption?: string | null;
}

interface WahaSendResponse {
  id?: string | { _serialized?: string; id?: string };
  key?: { id?: string; remoteJid?: string; fromMe?: boolean };
}

/**
 * The serialized message id (`<fromMe>_<chatId>_<HASH>`), across engines. GOWS
 * answers with a top-level serialized `id`; NOWEB (the Doha gateway) answers with
 * a bare hash under `key.id`. Reading only `json.id` returned '' on every NOWEB
 * send. Mirrors sentMessageWid in api/_lib/waha.ts — keep both in step.
 */
function sentWid(raw: WahaSendResponse, chatId: string): string {
  if (typeof raw.id === 'string' && raw.id) return raw.id;
  if (raw.id && typeof raw.id === 'object' && raw.id._serialized) return raw.id._serialized;
  const hash = raw.key?.id ?? (raw.id && typeof raw.id === 'object' ? raw.id.id : undefined);
  if (!hash) return '';
  const remote = (raw.key?.remoteJid ?? chatId).replace('@s.whatsapp.net', '@c.us');
  const fromMe = raw.key?.fromMe !== false;
  return `${fromMe}_${remote}_${hash}`;
}

async function post(cfg: WahaSendConfig, path: string, payload: unknown, chatId: string): Promise<{ id: string }> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WAHA ${path} failed: ${res.status} ${body.slice(0, 160)}`);
  }
  const json = (await res.json().catch(() => ({}))) as WahaSendResponse;
  return { id: sentWid(json, chatId) };
}

export async function sendText(cfg: WahaSendConfig, session: string, chatId: string, text: string): Promise<string> {
  const { id } = await post(cfg, '/api/sendText', { session, chatId, text }, chatId);
  return id;
}

// ─── session status / restart (for the zombie watchdog) ──────────────

export interface WahaSessionStatus { name: string; status: string; activityTs: number | null }

export async function getSessionStatus(cfg: WahaSendConfig, session: string): Promise<WahaSessionStatus> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(session)}`, {
    headers: { 'X-Api-Key': cfg.apiKey },
  });
  if (!res.ok) throw new Error(`WAHA session status ${session}: ${res.status}`);
  const j = (await res.json()) as { name?: string; status?: string; timestamps?: { activity?: number | null } | null };
  return { name: j.name ?? session, status: j.status ?? 'UNKNOWN', activityTs: j.timestamps?.activity ?? null };
}

export async function restartSession(cfg: WahaSendConfig, session: string): Promise<void> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(session)}/restart`, {
    method: 'POST',
    headers: { 'X-Api-Key': cfg.apiKey },
  });
  if (!res.ok) throw new Error(`WAHA restart ${session}: ${res.status}`);
}

/**
 * Take a session down. Used to end Baileys' 2-second reconnect loop when a
 * restart failed to bring the session back (WA-32) — an unrecovered session left
 * running hammers WhatsApp's login endpoint until it earns a ban.
 *
 * `/stop` HALTS the session but keeps its credentials on disk, so `/start` (or
 * the next watchdog pass) brings it straight back. This must never be `/logout`,
 * which unpairs the device and forces a physical re-scan on the owner's phone.
 */
export async function stopSession(cfg: WahaSendConfig, session: string): Promise<void> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(session)}/stop`, {
    method: 'POST',
    headers: { 'X-Api-Key': cfg.apiKey },
  });
  if (!res.ok) throw new Error(`WAHA stop ${session}: ${res.status}`);
}

const EXT_KIND: Record<string, NonNullable<ScheduledMediaItem['kind']>> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', wav: 'audio', m4a: 'audio',
};

function kindFor(item: ScheduledMediaItem): NonNullable<ScheduledMediaItem['kind']> {
  if (item.kind) return item.kind;
  // Infer from the ref/url file extension (mime isn't known at enqueue time).
  const ref = item.fileId ?? item.url ?? '';
  const ext = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1).split(/[?#]/)[0]!.toLowerCase() : '';
  return EXT_KIND[ext] ?? 'document';
}

const STORAGE_SIGNED_URL_RE = /\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/;

async function signTempPath(cfg: WahaSendConfig, path: string): Promise<{ url: string; filename?: string }> {
  const { data, error } = await cfg.supabase.storage.from(OUTBOUND_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
  if (error || !data?.signedUrl) throw new Error(`temp media signed-url failed: ${error?.message ?? 'no url'}`);
  return { url: data.signedUrl, filename: path.split('/').pop() };
}

async function resolveMediaUrl(cfg: WahaSendConfig, item: ScheduledMediaItem): Promise<{ url: string; filename?: string }> {
  if (item.url) return { url: item.url };
  const ref = item.fileId ?? '';
  if (ref.startsWith(TEMP_REF)) return signTempPath(cfg, ref.slice(TEMP_REF.length));
  if (/^https?:\/\//.test(ref)) {
    // Legacy rows (enqueued before 2026-07-23) stored the raw URL in fileId.
    // A signed wassel-files URL has certainly expired by delivery time — re-sign
    // its storage path; any other URL (public buckets, external) sends as-is.
    const m = ref.match(STORAGE_SIGNED_URL_RE);
    if (m && decodeURIComponent(m[1]!) === OUTBOUND_BUCKET) {
      return signTempPath(cfg, decodeURIComponent(m[2]!));
    }
    return { url: ref };
  }
  throw new Error(`unresolvable scheduled media item: ${JSON.stringify(item).slice(0, 80)}`);
}

export async function sendMedia(cfg: WahaSendConfig, session: string, chatId: string, item: ScheduledMediaItem): Promise<string> {
  const { url, filename } = await resolveMediaUrl(cfg, item);
  const kind = kindFor(item);
  const path =
    kind === 'image' ? '/api/sendImage' :
    kind === 'video' ? '/api/sendVideo' :
    kind === 'audio' ? '/api/sendVoice' : '/api/sendFile';
  const file: Record<string, unknown> = { url };
  if (filename) file.filename = filename;
  const payload: Record<string, unknown> = { session, chatId, file };
  if (kind !== 'audio' && item.caption) payload.caption = item.caption;
  if (kind === 'audio' || kind === 'video') payload.convert = true;
  const { id } = await post(cfg, path, payload, chatId);
  await mirrorOutboundMedia(cfg, session, id, url, filename);
  return id;
}

/**
 * Mirror the just-sent media into our own namespace so the chat thread can render
 * it after WAHA drops its transient /api/files copy. Same purpose and target path
 * as mirrorOutboundMedia in api/_lib/waha.ts — keep both in step. Best-effort:
 * any failure only logs and never fails the (already-delivered) send.
 */
async function mirrorOutboundMedia(
  cfg: WahaSendConfig,
  session: string,
  wid: string,
  url: string,
  filename?: string,
): Promise<void> {
  try {
    const hash = wid.split('_').pop() ?? '';
    if (!hash) return;
    const fromName = (filename ?? url).split(/[?#]/)[0] ?? '';
    const ext = fromName.includes('.') ? fromName.slice(fromName.lastIndexOf('.') + 1).toLowerCase() : 'bin';
    const target = `${MIRROR_PREFIX}/${session}/${hash}.${ext}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`[waha.mirrorOutboundMedia] source fetch ${res.status} for ${session}/${hash}`);
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const { error } = await cfg.supabase.storage.from(OUTBOUND_BUCKET).upload(target, bytes, { contentType, upsert: true });
    if (error) console.error(`[waha.mirrorOutboundMedia] mirror upload failed for ${target}:`, error.message);
  } catch (err) {
    console.error('[waha.mirrorOutboundMedia] unexpected error:', err instanceof Error ? err.message : String(err));
  }
}
