#!/usr/bin/env node
/**
 * Generate the home-screen icon set from the Wassel castle mark.
 *
 * Why this exists instead of `sharp`/ImageMagick: the only transform we need
 * is "downscale one known PNG and flatten it onto an opaque tile", and the
 * source format is fixed (8-bit RGBA, non-interlaced). Pulling a native image
 * dependency into the toolchain for that is not worth it — this script uses
 * only Node built-ins and fails loudly on any input it wasn't written for.
 *
 * Two things about the source mark drive the design here:
 *   1. It has an alpha channel. iOS does NOT honor transparency in
 *      `apple-touch-icon` — transparent pixels render BLACK. So every output
 *      is flattened onto an opaque background.
 *   2. The castle's outer towers bleed to the very edge of the canvas. iOS
 *      masks home-screen icons to a rounded rect ("squircle"), which would
 *      clip them. So the mark is inset (see MARK_SCALE) rather than used
 *      edge-to-edge. The same inset keeps us inside Android's maskable safe
 *      zone (a circle of 80% diameter), which is why one set can serve both.
 *
 * Usage: node scripts/generate-app-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The 2026 brand mark. `brand/` is the tracked source of truth — see brand/README.md. */
const SOURCE = path.join(ROOT, 'brand/الأيقونة.png');
const OUT_DIR = path.join(ROOT, 'public/assets');

/** Soft Cream #F8F5E9 — the 2026 palette. NOT the retired #F5EDE0. */
const BACKGROUND = { r: 0xf8, g: 0xf5, b: 0xe9 };

/**
 * Fraction of the tile width the mark spans, after cropping to its own
 * bounding box.
 *
 * The mark is wide (aspect ~1.45) and is centred vertically, so its extremes
 * sit on the tile's horizontal midline — exactly where both the iOS squircle
 * and Android's 80%-diameter safe circle are at their widest. 0.76 therefore
 * clears both with margin, while keeping the line art large enough to read at
 * 180px.
 */
const MARK_SCALE = 0.76;

const TARGETS = [
  { file: 'icon-180.png', size: 180 }, // apple-touch-icon (iPhone @3x)
  { file: 'icon-192.png', size: 192 }, // manifest, standard
  { file: 'icon-512.png', size: 512 }, // manifest, splash generation
];

// ── PNG decode ──────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit RGBA non-interlaced PNG to { width, height, data }. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  const idat = [];

  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      // Deliberately narrow: this script only ever reads our own logo asset.
      // Anything else should stop here rather than emit a silently wrong icon.
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); ` +
            'expected 8-bit RGBA, non-interlaced',
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // length + type + body + CRC
  }

  if (!width || !height) throw new Error('no IHDR found');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);

  // Reverse the per-scanline filters (PNG spec §9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0; // left
      const b = prev ? prev[x] : 0; // up
      const c = prev && x >= 4 ? prev[x - 4] : 0; // upper-left
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }

  return { width, height, data: out };
}

// ── Resample + flatten ──────────────────────────────────────────────────────

/** Tight bounding box of everything non-transparent, so the tile is composed
 *  around the mark itself rather than around whatever padding the export had. */
function alphaBounds(src) {
  let x0 = src.width;
  let y0 = src.height;
  let x1 = -1;
  let y1 = -1;

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.data[(y * src.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  if (x1 < 0) throw new Error('source image is fully transparent');
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Crop to the mark, area-average downscale, then composite onto the opaque
 * background.
 *
 * Resampling happens in PREMULTIPLIED alpha so the fully-transparent pixels
 * around the mark don't drag their (undefined) colour into the edge pixels —
 * that's what produces dark or white fringing on antialiased line art.
 */
function renderIcon(src, box, size) {
  // Fit by width; the mark is wider than it is tall, so width is the binding
  // constraint. Aspect ratio is preserved — never squash the logo.
  const innerW = Math.round(size * MARK_SCALE);
  const innerH = Math.max(1, Math.round((innerW * box.h) / box.w));
  const offsetX = Math.floor((size - innerW) / 2);
  const offsetY = Math.floor((size - innerH) / 2);
  const out = Buffer.alloc(size * size * 3);

  // Fill the whole tile with the background first.
  for (let i = 0; i < size * size; i++) {
    out[i * 3] = BACKGROUND.r;
    out[i * 3 + 1] = BACKGROUND.g;
    out[i * 3 + 2] = BACKGROUND.b;
  }

  const scaleX = box.w / innerW;
  const scaleY = box.h / innerH;

  for (let y = 0; y < innerH; y++) {
    const y0 = box.y0 + Math.floor(y * scaleY);
    const y1 = Math.min(box.y0 + box.h, Math.max(y0 + 1, box.y0 + Math.floor((y + 1) * scaleY)));

    for (let x = 0; x < innerW; x++) {
      const x0 = box.x0 + Math.floor(x * scaleX);
      const x1 = Math.min(box.x0 + box.w, Math.max(x0 + 1, box.x0 + Math.floor((x + 1) * scaleX)));

      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      let n = 0;

      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          const a = src.data[i + 3] / 255;
          pr += src.data[i] * a; // premultiply
          pg += src.data[i + 1] * a;
          pb += src.data[i + 2] * a;
          pa += a;
          n++;
        }
      }

      pr /= n;
      pg /= n;
      pb /= n;
      pa /= n;

      // Composite premultiplied source over the opaque background.
      const d = ((y + offsetY) * size + (x + offsetX)) * 3;
      out[d] = Math.round(pr + BACKGROUND.r * (1 - pa));
      out[d + 1] = Math.round(pg + BACKGROUND.g * (1 - pa));
      out[d + 2] = Math.round(pb + BACKGROUND.b * (1 - pa));
    }
  }

  return out;
}

// ── PNG encode ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** Encode an opaque RGB buffer as a PNG (colorType 2, no alpha). */
function encodePng(rgb, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha
  // 10/11/12 = compression, filter, interlace — all 0.

  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Run ─────────────────────────────────────────────────────────────────────

const src = decodePng(readFileSync(SOURCE));
const box = alphaBounds(src);
console.log(`source: ${path.relative(ROOT, SOURCE)} (${src.width}x${src.height} RGBA)`);
console.log(`  mark bounds: ${box.w}x${box.h} at (${box.x0},${box.y0})`);

for (const { file, size } of TARGETS) {
  const png = encodePng(renderIcon(src, box, size), size);
  writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`  wrote assets/${file} — ${size}x${size}, ${(png.length / 1024).toFixed(1)} KB`);
}
