/**
 * repairFileMediaMeta — fill pixel dimensions (images + videos) and duration
 * (videos) on `files` rows that never got a media probe at ingest.
 *
 * Dimensions + duration are CONTAINER/HEADER metadata — a cheap read, no AI.
 * Only ONE of our ingest paths reads them today: the social-intake scraper
 * (runSocialFileJob) probes every file, so competitor/developer media lands
 * ~100% populated. The other paths never did — the 2026-08-20 bulk
 * `marketing_intake` import, older `user_upload`s that predate the browser
 * probe (src/lib/files/mediaProbe.ts), and every server-side creator. Measured
 * 2026-09-27: 8,201 images with NULL width/height and (earlier) ~200 videos
 * with NULL duration. Consequence: the Library's aspect-ratio filter is blind
 * to those images, and "send the longest video" could not rank the videos.
 *
 * This is the DATA-driven repair path — the same posture as the content sweep
 * it runs inside: it looks at what state rows are actually in (a photo with no
 * dimensions) rather than trusting that every upload path remembered to probe.
 * A future path that also forgets self-heals on the next tick; the historical
 * backlog drains a batch at a time.
 *
 * The bytes are already in OUR private bucket, so each file is one signed-URL
 * fetch + a header read (ffprobe for video, sharp for image) — no third-party
 * re-download. Bounded and idempotent: it only looks at rows still missing the
 * metadata, so a second run once everything is filled does nothing. A file the
 * reader cannot parse (corrupt, or an image format sharp lacks, e.g. HEIC on
 * Alpine) is counted and skipped, never retried in a loop — a fact to report,
 * not a job to fail.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { probeDurationMs, probeDimensions } from './marketing/content/ffmpegMedia.js';
import { snapAspectRatio } from './runSocialFileJob.js';

const FILES_BUCKET = 'wassel-files';
/** Never buffer a whole file in memory: stream it to a temp file for the probe.
 *  Videos can be large; images are capped tighter since a header read never
 *  needs the whole thing but we download it whole for format robustness. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;

export interface FileMediaRepairStats {
  examined: number;
  fixed: number;
  unprobeable: number;
  errors: string[];
}

interface FileRow {
  id: string;
  kind: string;
  storage_bucket: string | null;
  storage_path: string;
  duration_seconds: number | null;
  width_px: number | null;
  height_px: number | null;
}

/**
 * Pixel dimensions of an image via sharp's header read (no full decode), or
 * null if sharp cannot parse it. EXIF orientation 5–8 means the stored buffer
 * is rotated 90°, so the DISPLAYED width/height are swapped — match what a
 * browser shows (and what the browser-side probe records) by swapping here too.
 */
async function imageDimensions(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(file, { failOn: 'none' }).metadata();
    let w = m.width ?? 0;
    let h = m.height ?? 0;
    if (m.orientation != null && m.orientation >= 5) { [w, h] = [h, w]; }
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

export async function repairFileMediaMeta(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<FileMediaRepairStats> {
  const limit = opts.limit ?? 25;
  const stats: FileMediaRepairStats = { examined: 0, fixed: 0, unprobeable: 0, errors: [] };

  // images missing dimensions, OR videos missing dimensions or duration.
  const { data: rows, error } = await supabase
    .from('files')
    .select('id, kind, storage_bucket, storage_path, duration_seconds, width_px, height_px')
    .in('kind', ['image', 'video'])
    .not('storage_path', 'is', null)
    .or('width_px.is.null,and(kind.eq.video,duration_seconds.is.null)')
    // Newest first: freshly-added media is the most likely to be about to get
    // sent/filtered; the historical backlog still drains, just after.
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`repair-file-meta: load files: ${error.message}`);
  if (!rows || rows.length === 0) return stats;

  for (const row of rows as FileRow[]) {
    stats.examined++;
    let dir: string | null = null;
    try {
      const bucket = row.storage_bucket ?? FILES_BUCKET;
      const { data: signed, error: signErr } = await supabase.storage
        .from(bucket).createSignedUrl(row.storage_path, 600);
      if (signErr || !signed?.signedUrl) throw new Error(`sign: ${signErr?.message ?? 'no url'}`);

      dir = await mkdtemp(path.join(tmpdir(), 'filemeta-'));
      const file = path.join(dir, 'm');
      const res = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const cap = row.kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > cap) throw new Error(`oversized (${Math.round(declared / 1e6)}MB)`);
      if (!res.body) throw new Error('empty body');
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
      if ((await stat(file)).size === 0) throw new Error('downloaded 0 bytes');

      const patch: Record<string, unknown> = {};
      if (row.kind === 'video') {
        // Probe only what is missing; a partial read still fills what it can.
        const [durMs, dims] = await Promise.all([
          row.duration_seconds == null ? probeDurationMs(file) : Promise.resolve(null),
          row.width_px == null ? probeDimensions(file) : Promise.resolve(null),
        ]);
        if (row.duration_seconds == null && durMs != null) {
          // Seconds, one decimal — identical to runSocialFileJob's convention
          // (Math.round(ms/100)/10) so both paths store the same shape.
          patch.duration_seconds = Math.round(durMs / 100) / 10;
        }
        if (row.width_px == null && dims) {
          patch.width_px = dims.width;
          patch.height_px = dims.height;
          patch.aspect_ratio = snapAspectRatio(dims.width, dims.height);
        }
      } else {
        // image
        const dims = await imageDimensions(file);
        if (dims) {
          patch.width_px = dims.width;
          patch.height_px = dims.height;
          patch.aspect_ratio = snapAspectRatio(dims.width, dims.height);
        }
      }

      if (Object.keys(patch).length === 0) { stats.unprobeable++; continue; }

      patch.updated_at = new Date().toISOString();
      const { error: uErr } = await supabase.from('files').update(patch).eq('id', row.id);
      if (uErr) throw new Error(`file update: ${uErr.message}`);
      stats.fixed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push(`${row.id}: ${msg}`);
      console.error(`[repair-file-meta] file=${row.id} failed — ${msg}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`[repair-file-meta] examined=${stats.examined} fixed=${stats.fixed} unprobeable=${stats.unprobeable} errors=${stats.errors.length}`);
  return stats;
}
