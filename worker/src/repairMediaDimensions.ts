/**
 * repairMediaDimensions — fill width/height on stored videos that never got any.
 *
 * yt-dlp reports a duration but no geometry, so every YouTube video the content
 * pipeline stored landed with `mkt_content_media.width/height` NULL. Once the
 * Files bridge started registering those media as files, the 68 affected videos
 * had no dimensions and therefore no aspect ratio, and fell out of the Library's
 * ratio filter (operator, 2026-09-15).
 *
 * The bytes are already in OUR bucket, so this is one ffprobe per video — no
 * re-download, which matters because YouTube blocks datacenter IPs and the
 * originals could not be fetched again anyway.
 *
 * Writes both sides: the media row (the source of truth for the pipeline) and
 * the registered file (dimensions + the snapped aspect ratio the Library reads).
 *
 * Bounded and idempotent: it only looks at stored videos with a NULL width, so
 * a second run after everything is filled does nothing. A video ffprobe cannot
 * read is counted and skipped, never retried in a loop — a corrupt download is
 * a fact to report, not a job to fail.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { probeDimensions } from './marketing/content/ffmpegMedia.js';
import { snapAspectRatio } from './runSocialFileJob.js';

/** Never buffer a whole video in memory: stream it to a temp file for ffprobe. */
const MAX_PROBE_BYTES = 200 * 1024 * 1024;

export interface RepairStats {
  examined: number;
  fixed: number;
  unprobeable: number;
  errors: string[];
}

export async function repairMediaDimensions(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<RepairStats> {
  const limit = opts.limit ?? 100;
  const stats: RepairStats = { examined: 0, fixed: 0, unprobeable: 0, errors: [] };

  const { data: rows, error } = await supabase
    .from('mkt_content_media')
    .select('id, stored_url, file_id, duration_ms')
    .eq('media_kind', 'video')
    .eq('download_status', 'stored')
    .is('width', null)
    .not('stored_url', 'is', null)
    .limit(limit);
  if (error) throw new Error(`repair: load media: ${error.message}`);
  if (!rows || rows.length === 0) return stats;

  for (const row of rows as Array<{ id: string; stored_url: string; file_id: string | null; duration_ms: number | null }>) {
    stats.examined++;
    let dir: string | null = null;
    try {
      dir = await mkdtemp(path.join(tmpdir(), 'dimprobe-'));
      const file = path.join(dir, 'v.mp4');
      const res = await fetch(row.stored_url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_PROBE_BYTES) throw new Error(`oversized (${Math.round(declared / 1e6)}MB)`);
      if (!res.body) throw new Error('empty body');
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
      if ((await stat(file)).size === 0) throw new Error('downloaded 0 bytes');

      const dims = await probeDimensions(file);
      if (!dims) { stats.unprobeable++; continue; }

      const { error: mErr } = await supabase
        .from('mkt_content_media').update({ width: dims.width, height: dims.height }).eq('id', row.id);
      if (mErr) throw new Error(`media update: ${mErr.message}`);

      if (row.file_id) {
        const { error: fErr } = await supabase.from('files').update({
          width_px: dims.width,
          height_px: dims.height,
          aspect_ratio: snapAspectRatio(dims.width, dims.height),
          updated_at: new Date().toISOString(),
        }).eq('id', row.file_id);
        if (fErr) throw new Error(`file update: ${fErr.message}`);
      }
      stats.fixed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push(`${row.id}: ${msg}`);
      console.error(`[repair-dims] media=${row.id} failed — ${msg}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`[repair-dims] examined=${stats.examined} fixed=${stats.fixed} unprobeable=${stats.unprobeable} errors=${stats.errors.length}`);
  return stats;
}
