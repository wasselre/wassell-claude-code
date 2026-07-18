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

async function post(cfg: WahaSendConfig, path: string, payload: unknown): Promise<{ id: string }> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WAHA ${path} failed: ${res.status} ${body.slice(0, 160)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: json.id ?? '' };
}

export async function sendText(cfg: WahaSendConfig, session: string, chatId: string, text: string): Promise<string> {
  const { id } = await post(cfg, '/api/sendText', { session, chatId, text });
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

async function resolveMediaUrl(cfg: WahaSendConfig, item: ScheduledMediaItem): Promise<{ url: string; filename?: string }> {
  if (item.url) return { url: item.url };
  if (item.fileId && item.fileId.startsWith(TEMP_REF)) {
    const path = item.fileId.slice(TEMP_REF.length);
    const { data, error } = await cfg.supabase.storage.from(OUTBOUND_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
    if (error || !data?.signedUrl) throw new Error(`temp media signed-url failed: ${error?.message ?? 'no url'}`);
    return { url: data.signedUrl, filename: path.split('/').pop() };
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
  const { id } = await post(cfg, path, payload);
  return id;
}
