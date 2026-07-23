// ============================================================================
// Permanent, content-addressed media storage for collected social content.
// Platform CDN URLs (Instagram/TikTok) expire within days — download the bytes
// once and store them in the public `marketing-assets` bucket keyed by sha256,
// so identical bytes dedup to ONE object and a stored asset never re-downloads.
// Generalizes creativeStore.ts (which is Meta-ad-specific) to arbitrary media.
// ============================================================================
import { sha256Hex } from '../adIntel.js';

const BUCKET = 'marketing-assets';
// Hard cap tuned for the 512 MB Fly worker: we buffer the whole body in memory,
// so a very large video would OOM the machine. 50 MB covers reels/shorts; larger
// videos are recorded as an explicit terminal failure (graceful degradation,
// same posture as the office-preview 512 MB limit) rather than crashing the box.
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

export interface StoredMedia {
  storedUrl: string; bucket: string; path: string;
  checksum: string; mime: string | null; bytes: number;
}

function extFor(url: string, mime: string | null, kind: string): string {
  if (mime?.includes('mp4') || url.includes('.mp4') || kind === 'video') return 'mp4';
  if (mime?.includes('png')) return 'png';
  if (mime?.includes('webp')) return 'webp';
  if (mime?.includes('m4a') || mime?.includes('mp4a') || mime?.includes('aac')) return 'm4a';
  return 'jpg';
}

/** Apify key-value-store record URLs (where clockworks stores downloaded TikTok
 *  videos) are PRIVATE — 403 without the account token. Authorize them. */
function authorizeUrl(url: string): string {
  if (/(^|\.)api\.apify\.com\//.test(url) && process.env.APIFY_API_TOKEN && !url.includes('token=')) {
    return url + (url.includes('?') ? '&' : '?') + `token=${process.env.APIFY_API_TOKEN}`;
  }
  return url;
}

/** Raw bytes for a URL. Rejects oversized bodies via Content-Length BEFORE
 *  buffering (so a huge video can't OOM the 512 MB machine mid-download). */
export async function fetchBytes(url: string, timeoutMs = 60_000, maxBytes = VIDEO_MAX_BYTES): Promise<{ bytes: Buffer; mime: string | null }> {
  const res = await fetch(authorizeUrl(url), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const mime = res.headers.get('content-type');
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new Error(`oversized (declared ${Math.round(declared / 1e6)}MB > ${Math.round(maxBytes / 1e6)}MB)`); }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty body');
  if (bytes.length > maxBytes) throw new Error(`oversized ${bytes.length}`);
  return { bytes, mime };
}

/** Upload bytes to a content-addressed path (upsert → dedup). Returns public URL. */
export async function uploadBytes(bytes: Buffer, prefix: string, checksum: string, ext: string, mime: string): Promise<StoredMedia> {
  const base = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('supabase env missing');
  const path = `${prefix}/${checksum}.${ext}`;
  const up = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'content-type': mime, 'x-upsert': 'true' },
    body: new Blob([bytes], { type: mime }),
  });
  if (!up.ok && up.status !== 409) throw new Error(`storage upload ${up.status}: ${(await up.text().catch(() => '')).slice(0, 200)}`);
  return { storedUrl: `${base}/storage/v1/object/public/${BUCKET}/${path}`, bucket: BUCKET, path, checksum, mime, bytes: bytes.length };
}

/**
 * Download one media URL and store it permanently. Content-addressed: identical
 * bytes reuse the same object (idempotent, no duplicate storage). Throws on
 * failure so the caller records an explicit terminal media failure (never a
 * silent skip). Returns the stored asset + the raw bytes (caller may reuse them
 * for transcription/vision without a second download).
 */
export async function downloadAndStore(url: string, kind: 'video' | 'image' | 'thumbnail'): Promise<StoredMedia & { rawBytes: Buffer }> {
  const { bytes, mime } = await fetchBytes(url, kind === 'video' ? 90_000 : 45_000, kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES);
  const checksum = sha256Hex(bytes);
  const prefix = kind === 'video' ? 'content/video' : kind === 'thumbnail' ? 'content/thumb' : 'content/image';
  const stored = await uploadBytes(bytes, prefix, checksum, extFor(url, mime, kind), mime ?? 'application/octet-stream');
  return { ...stored, rawBytes: bytes };
}
