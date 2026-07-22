// ============================================================================
// Permanent creative storage (§2/§3). Meta CDN URLs expire — download the bytes
// once, store them in the public `marketing-assets` bucket keyed by content
// fingerprint (so identical/reused creatives dedup to ONE object), and compute an
// exact sha256 fingerprint + best-effort perceptual dHash (only if an image
// decoder is installed). The original Meta URL is kept as metadata by the caller.
// ============================================================================
import { sha256Hex, dHashFromGrayscale } from './adIntel.js';

const BUCKET = 'marketing-assets';
const PREFIX = 'ad-creatives';

function extFor(url: string, mime: string | null): string {
  if (mime?.includes('mp4') || url.includes('.mp4')) return 'mp4';
  if (mime?.includes('png')) return 'png';
  if (mime?.includes('webp')) return 'webp';
  return 'jpg';
}

export interface StoredCreative { storedUrl: string; fingerprint: string; phash: string | null; mime: string | null }

/** Optional perceptual hash — only if `sharp` is installed (graceful no-op otherwise). */
async function tryPerceptualHash(bytes: Buffer): Promise<string | null> {
  try {
    const sharp = (await import('sharp' as string)).default as (b: Buffer) => {
      resize: (w: number, h: number, o?: unknown) => { grayscale: () => { raw: () => { toBuffer: () => Promise<Buffer> } } };
    };
    const raw = await sharp(bytes).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
    return dHashFromGrayscale(Array.from(raw.subarray(0, 72)));
  } catch { return null; } // sharp absent or non-image → skip perceptual hash
}

/**
 * Download a creative and store it permanently. Dedups at the storage layer by
 * fingerprint (same bytes → same object path → upsert is a no-op, no duplicate).
 * Returns null on any download/store failure (caller keeps the original URL).
 */
export async function storeCreative(url: string): Promise<StoredCreative | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || !url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const mime = res.headers.get('content-type');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) return null; // guard empty / oversized
    const fingerprint = sha256Hex(bytes);
    const path = `${PREFIX}/${fingerprint}.${extFor(url, mime)}`;
    // upsert → identical bytes reuse the same object (no duplicate storage/download cost next time)
    const up = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'content-type': mime ?? 'image/jpeg', 'x-upsert': 'true' },
      body: new Blob([bytes], { type: mime ?? 'image/jpeg' }),
    });
    if (!up.ok && up.status !== 409) return null;
    const phash = mime?.startsWith('image/') ? await tryPerceptualHash(bytes) : null;
    return { storedUrl: `${base}/storage/v1/object/public/${BUCKET}/${path}`, fingerprint, phash, mime };
  } catch { return null; }
}
