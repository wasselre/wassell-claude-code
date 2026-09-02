/**
 * Deterministic asset meta — NO AI, NO human. Width/height/snapped aspect and
 * a top-5 dominant-colour palette computed from the image bytes, then written
 * to `files` with visual_meta_version='det-v1'.
 *
 * Palette: resize to 64×64 with sharp, then a quantized (4 bits/channel)
 * histogram — the same recipe every time, so the same image always yields the
 * same palette. `has_text` stays null here by contract (text detection is the
 * enrich-v2 vision pass's job, not a deterministic computation).
 *
 * sharp is a SOFT dependency (dynamic import, same posture as
 * worker/src/marketing/creativeStore.ts): when it is absent the palette comes
 * back null — loudly, once per process — and dimensions fall back to a pure
 * header parser (PNG/JPEG/GIF/WEBP), so the lane still fills width/height.
 *
 * Worker copy note: snapAspectRatio is a port of src/lib/files/mediaProbe.ts
 * (the worker is a standalone package and cannot import from src/). Keep the
 * snapping table + 4% tolerance in sync with it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface DominantColor {
  hex: string;
  /** 0..1 share of sampled pixels in this colour's bin (rounded to 4 dp). */
  share: number;
}

export interface DeterministicMeta {
  width_px: number | null;
  height_px: number | null;
  /** Snapped display ratio, e.g. "16:9" / "9:16" / "1:1". */
  aspect_ratio: string | null;
  /** Top 5 by share; null when no decoder was available. */
  dominant_colors: DominantColor[] | null;
  /** Always null — text detection belongs to the enrich-v2 vision pass. */
  has_text: null;
}

// ── Aspect snapping (port of src/lib/files/mediaProbe.ts) ────────────────────

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) { [x, y] = [y, x % y]; }
  return x || 1;
}

/** Snap width:height to a common ratio label; fall back to the reduced fraction. */
export function snapAspectRatio(w: number, h: number): string | null {
  if (!w || !h || w < 0 || h < 0) return null;
  const r = w / h;
  const common: Array<[number, number]> = [
    [1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3],
    [21, 9], [4, 5], [5, 4], [2, 1], [1, 2], [16, 10], [10, 16],
  ];
  let best = common[0]!;
  let bestDiff = Infinity;
  for (const c of common) {
    const diff = Math.abs(r - c[0] / c[1]);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  if (bestDiff / (best[0] / best[1]) <= 0.04) return `${best[0]}:${best[1]}`;
  const g = gcd(Math.round(w), Math.round(h));
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

// ── Quantized palette (pure — unit-tested without sharp) ─────────────────────

const PALETTE_TOP = 5;

/**
 * Top-N dominant colours from raw RGBA pixels. Each channel is quantized to 4
 * bits (16 levels); the bin key packs r4/g4/b4. The reported hex is the bin
 * CENTER (+8 per channel), not an averaged pixel — deterministic for a given
 * pixel set and stable across resize implementations.
 */
export function dominantColorsFromPixels(
  rgba: Uint8Array | Buffer,
  pixelCount: number,
  top: number = PALETTE_TOP,
): DominantColor[] {
  if (pixelCount <= 0 || rgba.length < pixelCount * 4) return [];
  const bins = new Map<number, number>();
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    // Fully transparent pixels carry no colour information — skip them.
    if (rgba[o + 3] === 0) continue;
    const key = ((rgba[o]! >> 4) << 8) | ((rgba[o + 1]! >> 4) << 4) | (rgba[o + 2]! >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const total = [...bins.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const to2 = (v: number) => v.toString(16).padStart(2, '0');
  return [...bins.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]) // count desc, then key asc (stable ties)
    .slice(0, top)
    .map(([key, count]) => ({
      hex: `#${to2(((key >> 8) & 0xf) * 16 + 8)}${to2(((key >> 4) & 0xf) * 16 + 8)}${to2((key & 0xf) * 16 + 8)}`,
      share: Math.round((count / total) * 10000) / 10000,
    }));
}

// ── Pure header size parser (fallback when sharp is absent) ──────────────────

/** Read width/height from PNG, JPEG, GIF or WEBP headers. Null when the bytes
 *  are not one of those formats (or are truncated/corrupt). */
export function readImageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    // PNG: 8-byte signature, then IHDR length(4) type(4) width(4) height(4).
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: 'GIF8', width/height little-endian at 6.
    if (buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // WEBP: RIFF....WEBP, then VP8X (10-byte canvas) / VP8L / VP8 (lossy).
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X' && buf.length >= 30) {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fmt === 'VP8L' && buf.length >= 25) {
        const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
      if (fmt === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    // JPEG: SOI then markers; the SOF segment carries height/width big-endian.
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1]!;
        // SOF0..SOF15 except DHT(DC4)/JPG(DC8)/DAC(DCC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) return null;
        off += 2 + len;
      }
      return null;
    }
    return null;
  } catch (e) {
    console.error(`[assetMeta] readImageSize parse failure: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── sharp access (soft dependency) ───────────────────────────────────────────

interface SharpRawResult { data: Buffer; info: { width: number; height: number; channels: number } }
interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number }>;
  ensureAlpha(): SharpPipeline;
  resize(w: number, h: number, opts: { fit: 'fill' }): SharpPipeline;
  raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<SharpRawResult> };
}
type SharpFactory = (input: Buffer) => SharpPipeline;

let sharpTried = false;
let sharpFactory: SharpFactory | null = null;

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpTried) return sharpFactory;
  sharpTried = true;
  try {
    // Computed specifier — sharp is intentionally NOT in worker/package.json
    // yet; when the lead adds it, this import starts succeeding with no code
    // change (same posture as worker/src/marketing/creativeStore.ts).
    const mod = (await import('sharp' as string)) as { default?: unknown };
    sharpFactory = (typeof mod.default === 'function' ? mod.default : null) as SharpFactory | null;
    if (!sharpFactory) console.error('[assetMeta] sharp module loaded but has no callable default export — palette disabled');
  } catch (e) {
    sharpFactory = null;
    console.error(`[assetMeta] sharp is not installed in the worker — dominant_colors will be null until it is added (${e instanceof Error ? e.message : String(e)})`);
  }
  return sharpFactory;
}

// ── computeDeterministicMeta ─────────────────────────────────────────────────

/**
 * Compute width/height/aspect/palette from image bytes. Never throws: an
 * undecodable buffer yields nulls (the lane treats that as a per-file failure
 * to LOG, not a lane failure).
 */
export async function computeDeterministicMeta(buffer: Buffer): Promise<DeterministicMeta> {
  const meta: DeterministicMeta = {
    width_px: null,
    height_px: null,
    aspect_ratio: null,
    dominant_colors: null,
    has_text: null,
  };

  const sharp = await loadSharp();
  if (sharp) {
    try {
      // metadata() reads the ORIGINAL dimensions; the 64×64 resize below is
      // palette sampling only — the snapped aspect must describe the stored
      // image, not the thumbnail.
      const md = await sharp(buffer).metadata();
      if (md.width && md.height && md.width > 0 && md.height > 0) {
        meta.width_px = md.width;
        meta.height_px = md.height;
      }
      const { data, info } = await sharp(buffer)
        .ensureAlpha()
        .resize(64, 64, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      meta.dominant_colors = dominantColorsFromPixels(data, info.width * info.height);
    } catch (e) {
      console.error(`[assetMeta] sharp decode failed (${buffer.length} bytes): ${e instanceof Error ? e.message : String(e)} — falling back to header parse`);
    }
  }

  // Dimensions the decoder couldn't report (or no decoder at all) fall back
  // to the pure header parser.
  if (meta.width_px === null || meta.height_px === null) {
    const size = readImageSize(buffer);
    if (size && size.width > 0 && size.height > 0) {
      meta.width_px = size.width;
      meta.height_px = size.height;
    }
  }
  if (meta.width_px !== null && meta.height_px !== null) {
    meta.aspect_ratio = snapAspectRatio(meta.width_px, meta.height_px);
  }
  return meta;
}

// ── applyDeterministicMeta ───────────────────────────────────────────────────

/** The only slice of a Supabase client this needs (tests inject a fake). */
export type FilesWriteClient = Pick<SupabaseClient, 'from'>;

/**
 * Write the deterministic meta to `files`. The version stamp 'det-v1' is only
 * applied when visual_meta_version is still NULL — a file already at
 * 'enrich-v2' keeps its (richer) stamp; the det pass only fills its missing
 * dims/palette.
 *
 * Throws on a Supabase error (loud — the lane logs it per file and moves on).
 */
export async function applyDeterministicMeta(
  sb: FilesWriteClient,
  fileId: string,
  meta: DeterministicMeta,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (meta.width_px !== null) patch.width_px = meta.width_px;
  if (meta.height_px !== null) patch.height_px = meta.height_px;
  if (meta.aspect_ratio !== null) patch.aspect_ratio = meta.aspect_ratio;
  if (meta.dominant_colors !== null) patch.dominant_colors = meta.dominant_colors;

  if (Object.keys(patch).length > 0) {
    const { error } = await sb.from('files').update(patch).eq('id', fileId);
    if (error) throw new Error(`files update failed for ${fileId}: ${error.message}`);
  }
  const { error: vErr } = await sb
    .from('files')
    .update({ visual_meta_version: 'det-v1' })
    .eq('id', fileId)
    .is('visual_meta_version', null);
  if (vErr) throw new Error(`files version stamp failed for ${fileId}: ${vErr.message}`);
}
