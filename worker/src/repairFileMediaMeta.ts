/**
 * repairFileMediaMeta — fill duration / dimensions on `files` videos that never
 * got a media probe at ingest.
 *
 * Video length + geometry are CONTAINER METADATA — one ffprobe read of the file
 * header, no decode, no AI. Only one of our three ingest paths actually reads
 * them today: the social-intake scraper (runSocialFileJob) probes every file, so
 * competitor/developer videos land with duration + dimensions ~100% of the time.
 * The other two paths never did: the 2026-08-20 bulk `marketing_intake` import
 * stored files without a probe, and older `user_upload` videos predate the
 * browser-side probe (src/lib/files/mediaProbe.ts). Result on 2026-09-21: 207
 * `files` videos with `duration_seconds` NULL — which is exactly why "send the
 * longest video" could not rank them, and why the Library ratio filter dropped
 * the ones also missing width/height.
 *
 * This is the second, DATA-driven path — the same posture as the content sweep
 * it runs inside: it looks at what state the rows are actually in (a video with
 * no duration) rather than trusting that every upload path remembered to probe.
 * So a future path that also forgets self-heals on the next tick, and the 207
 * historical rows drain a batch at a time.
 *
 * The bytes are already in OUR private bucket, so this is one signed-URL fetch +
 * one ffprobe per video — no re-download from a third party.
 *
 * Bounded and idempotent: it only looks at video rows still missing duration OR
 * width, so a second run after everything is filled does nothing. A video
 * ffprobe cannot read is counted and skipped, never retried in a loop — a
 * corrupt file is a fact to report, not a job to fail.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { probeDurationMs, probeDimensions } from './marketing/content/ffmpegMedia.js';
import { snapAspectRatio } from './runSocialFileJob.js';

const FILES_BUCKET = 'wassel-files';
/** Never buffer a whole video in memory: stream it to a temp file for ffprobe. */
const MAX_PROBE_BYTES = 200 * 1024 * 1024;

export interface FileMediaRepairStats {
  examined: number;
  fixed: number;
  unprobeable: number;
  errors: string[];
}

interface FileRow {
  id: string;
  storage_bucket: string | null;
  storage_path: string;
  duration_seconds: number | null;
  width_px: number | null;
  height_px: number | null;
}

export async function repairFileMediaMeta(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<FileMediaRepairStats> {
  const limit = opts.limit ?? 25;
  const stats: FileMediaRepairStats = { examined: 0, fixed: 0, unprobeable: 0, errors: [] };

  const { data: rows, error } = await supabase
    .from('files')
    .select('id, storage_bucket, storage_path, duration_seconds, width_px, height_px')
    .eq('kind', 'video')
    .not('storage_path', 'is', null)
    .or('duration_seconds.is.null,width_px.is.null')
    // Newest first: a video just added by an un-probed path is the one most
    // likely to be about to get sent; the historical backlog still drains, just
    // after the fresh arrivals.
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
      const file = path.join(dir, 'v.mp4');
      const res = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_PROBE_BYTES) throw new Error(`oversized (${Math.round(declared / 1e6)}MB)`);
      if (!res.body) throw new Error('empty body');
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
      if ((await stat(file)).size === 0) throw new Error('downloaded 0 bytes');

      // Probe only what is missing; a partial read still fills what it can.
      const [durMs, dims] = await Promise.all([
        row.duration_seconds == null ? probeDurationMs(file) : Promise.resolve(null),
        row.width_px == null ? probeDimensions(file) : Promise.resolve(null),
      ]);

      const patch: Record<string, unknown> = {};
      if (row.duration_seconds == null && durMs != null) {
        // Seconds with one decimal — identical to runSocialFileJob's convention
        // (Math.round(ms/100)/10) so both paths store the same shape.
        patch.duration_seconds = Math.round(durMs / 100) / 10;
      }
      if (row.width_px == null && dims) {
        patch.width_px = dims.width;
        patch.height_px = dims.height;
        patch.aspect_ratio = snapAspectRatio(dims.width, dims.height);
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
