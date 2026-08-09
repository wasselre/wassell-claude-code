/**
 * runVideoConvertJob — convert ONE listing video (HLS .m3u8 stream or any
 * ffmpeg-readable URL) into a WhatsApp-sendable .mp4, re-host it to the public
 * marketing-assets bucket, and cache the mapping on the LISTING record as
 *   data.video_mp4_map = { "<source_url>": "<mp4 public url>" }
 * The Listing WhatsApp send flow maps video_urls through that cache — HLS
 * streams (all Aqar videos are Cloudflare Stream playlists) previously could
 * never be sent because WhatsApp only accepts uploadable video FILES.
 *
 * One generation_jobs row (kind='video-convert') per video; enqueued by
 * api/templates/clean-listing-images.ts alongside the photo cleaning fan-out,
 * skipping sources already in the cache (file bytes are immutable — a source
 * URL never needs re-converting).
 *
 * Conversion strategy:
 *   1. COPY-REMUX first (`-c copy -bsf:a aac_adtstoasc`): Cloudflare Stream
 *      HLS is already H.264/AAC, so remuxing is fast and lossless.
 *   2. If the result exceeds the WhatsApp video cap (~16 MB), ONE re-encode
 *      pass (720p, x264 veryfast, CRF 28). Still too big → fail loudly.
 *   ffmpeg is killed as a process GROUP on timeout (house rule — same posture
 *   as soffice/gs in runPreviewJob/runCompressJob).
 *
 * Cache write posture: market_listing_custom_patch merges the one map entry
 * into custom_data under a row lock (market_listings froze 2026-08-07 —
 * video_mp4_map is a non-schema key, so it lives there now).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';

export interface VideoConvertJob {
  /** generation_jobs.id */
  id: string;
  /** market_listings.id — the listing this video belongs to. */
  recordId: string;
  /** auth.users.id of the enqueuer (storage path scope). */
  userId: string;
  /** Frozen request snapshot — { source_url, listing_id }. */
  params: Record<string, unknown>;
  attempts: number;
}

const BUCKET = 'marketing-assets';
/** WhatsApp rejects videos over ~16 MB; leave headroom. */
const MAX_VIDEO_BYTES = 15_500_000;
const REMUX_TIMEOUT_MS = 5 * 60_000;
const REENCODE_TIMEOUT_MS = 10 * 60_000;

/**
 * Run ffmpeg with a hard deadline, killing the whole process GROUP on timeout
 * (ffmpeg spawns no children today, but the group kill is the house posture
 * that survived the soffice orphan incident).
 */
function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2_000);
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // negative pid = whole group
      } catch {
        // process already exited between the timeout firing and the kill
      }
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.slice(-400)}`));
    });
  });
}

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: VideoConvertJob;
}

export async function runVideoConvertJob({ supabase, job }: RunArgs): Promise<Record<string, unknown>> {
  const sourceUrl = typeof job.params?.source_url === 'string' ? (job.params.source_url as string) : '';
  if (!sourceUrl) {
    throw new Error(`video-convert job ${job.id} missing params.source_url — cannot run`);
  }
  console.log(`[run-video] start job=${job.id} listing=${job.recordId} src=${sourceUrl.slice(0, 120)}`);

  // ── Cache pre-check: another job may have converted this source already ──
  // market_listings froze 2026-08-07 — the _v view keeps the jsonb `data`
  // shape (video_mp4_map now lives in custom_data, merged in by the view).
  const { data: listingRow, error: readErr } = await supabase
    .from('market_listings_v')
    .select('data')
    .eq('id', job.recordId)
    .single();
  if (readErr || !listingRow) {
    throw new Error(`listing read failed: ${readErr?.message ?? job.recordId}`);
  }
  const existingMap = ((listingRow.data as Record<string, unknown>)?.video_mp4_map ?? {}) as Record<string, unknown>;
  if (typeof existingMap[sourceUrl] === 'string' && existingMap[sourceUrl]) {
    console.log(`[run-video] cache hit job=${job.id} — nothing to do`);
    return { cached: true, mp4_url: existingMap[sourceUrl] };
  }

  // ── Convert: copy-remux, then a single re-encode fallback if oversized ──
  const workDir = await mkdtemp(join(tmpdir(), 'video-convert-'));
  const remuxPath = join(workDir, 'remux.mp4');
  const encodedPath = join(workDir, 'encoded.mp4');
  let outPath = remuxPath;
  try {
    await runFfmpeg(
      ['-y', '-i', sourceUrl, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', remuxPath],
      REMUX_TIMEOUT_MS,
    );
    let bytes = (await stat(remuxPath)).size;
    console.log(`[run-video] remux done job=${job.id} bytes=${bytes}`);
    if (bytes > MAX_VIDEO_BYTES) {
      console.log(`[run-video] oversize (${bytes} > ${MAX_VIDEO_BYTES}) — re-encoding 720p job=${job.id}`);
      await runFfmpeg(
        [
          '-y', '-i', remuxPath,
          '-vf', "scale='min(1280,iw)':-2",
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
          '-c:a', 'aac', '-b:a', '96k',
          '-movflags', '+faststart',
          encodedPath,
        ],
        REENCODE_TIMEOUT_MS,
      );
      bytes = (await stat(encodedPath)).size;
      outPath = encodedPath;
      console.log(`[run-video] re-encode done job=${job.id} bytes=${bytes}`);
      if (bytes > MAX_VIDEO_BYTES) {
        throw new Error(
          `video still ${Math.round(bytes / 1_048_576)} MB after 720p re-encode — too large for WhatsApp (~16 MB cap)`,
        );
      }
    }

    // ── Re-host to the public bucket ─────────────────────────────────────
    const mp4Bytes = await readFile(outPath);
    const storagePath = `listing-videos/${job.recordId}/${crypto.randomUUID()}.mp4`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, mp4Bytes, {
      contentType: 'video/mp4',
      upsert: false,
    });
    if (upErr) throw new Error(`mp4 upload failed: ${upErr.message}`);
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const mp4Url = pub?.publicUrl;
    if (!mp4Url) throw new Error('mp4 uploaded but public URL could not be resolved');

    // ── Cache the mapping on the listing record ──────────────────────────
    // video_mp4_map is a dropped (non-schema) key → custom_data. The RPC
    // merges one entry under a row lock, so concurrent convert jobs on the
    // same listing can't clobber each other (the record_save retry would).
    const { error: cacheErr } = await supabase.rpc('market_listing_custom_patch', {
      p_id: job.recordId,
      p_patch: { [sourceUrl]: mp4Url },
      p_merge_key: 'video_mp4_map',
    });
    if (cacheErr) throw new Error(`video_mp4_map cache write failed: ${cacheErr.message}`);
    console.log(`[run-video] completed job=${job.id} → ${mp4Url}`);
    return { mp4_url: mp4Url, bytes: mp4Bytes.length };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
