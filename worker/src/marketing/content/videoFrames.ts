// ============================================================================
// Video frames → the subscription OCR lane.
//
// A stored video's on-screen text (price, offer, phone overlays) lives in its
// frames, not its cover picture. Frames are sampled here, stored, and queued in
// mkt_video_frames; the content sweep batches them into claude_jobs
// (mkt_visual_ocr {frame_ids}) and the runner writes the text back against the
// video's media row. See supabase/migrations/2026-09-30_02_video_frames_ocr.sql
// for why this exists (1,167 of 1,406 videos had been read from the cover only).
//
// No model is called here — this is download + ffmpeg + storage.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchBytes, uploadBytes } from './contentStore.js';
import { toTempFile, cleanup, probeDurationMs, sampleFrames } from './ffmpegMedia.js';
import { sha256Hex } from '../adIntel.js';

export interface SampledFrame { tsMs: number; jpeg: Buffer }

export interface FramesOnlyStats {
  post_id: string;
  videos: number;
  frames_staged: number;
  videos_failed: number;
  errors: string[];
}

/** Store already-sampled frames and queue them for OCR. Idempotent: a frame at
 *  the same timestamp of the same video is left as it is. */
export async function stageVideoFrames(sb: SupabaseClient, postId: string, mediaId: string, frames: SampledFrame[]): Promise<number> {
  let staged = 0;
  for (const f of frames) {
    const stored = await uploadBytes(f.jpeg, 'content/frames', sha256Hex(f.jpeg), 'jpg', 'image/jpeg');
    const { error } = await sb.from('mkt_video_frames').upsert(
      { content_media_id: mediaId, content_post_id: postId, frame_ts_ms: f.tsMs, bucket: stored.bucket, path: stored.path, stored_url: stored.storedUrl },
      { onConflict: 'content_media_id,frame_ts_ms', ignoreDuplicates: true },
    );
    if (error) throw new Error(`video frame row: ${error.message}`);
    staged++;
  }
  return staged;
}

/** Record that a video cannot yield frames, so the sweep stops offering it.
 *  frame_ts_ms = -1 is the marker (see the migration). */
async function markUnframeable(sb: SupabaseClient, postId: string, mediaId: string, reason: string): Promise<void> {
  const { error } = await sb.from('mkt_video_frames').upsert(
    { content_media_id: mediaId, content_post_id: postId, frame_ts_ms: -1, ocr_status: 'failed', failure: reason.slice(0, 300) },
    { onConflict: 'content_media_id,frame_ts_ms', ignoreDuplicates: true },
  );
  if (error) throw new Error(`video frame failure marker: ${error.message}`);
}

/**
 * The frames-only pass (content_process params.mode = 'frames_only'): for every
 * stored video of the post that has no frame text and no staged frames, sample
 * six frames and queue them. A video that cannot be framed gets ONE failure
 * marker and the job still succeeds — a broken video is a fact about the video,
 * not a reason to retry the job. A storage or database error throws (the job
 * fails and is retried), because then the video was never actually examined.
 */
export async function runFramesOnly(sb: SupabaseClient, postId: string): Promise<FramesOnlyStats> {
  const stats: FramesOnlyStats = { post_id: postId, videos: 0, frames_staged: 0, videos_failed: 0, errors: [] };

  const { data: media, error: mErr } = await sb.from('mkt_content_media')
    .select('id, stored_url, duration_ms')
    .eq('content_post_id', postId).eq('media_kind', 'video').eq('download_status', 'stored');
  if (mErr) throw new Error(`frames: load media: ${mErr.message}`);

  for (const m of (media ?? []) as Array<{ id: string; stored_url: string | null; duration_ms: number | null }>) {
    if (!m.stored_url) continue;
    const [{ data: vt, error: vtErr }, { data: fr, error: frErr }] = await Promise.all([
      sb.from('mkt_visual_text').select('id').eq('content_media_id', m.id).eq('source', 'frame').limit(1),
      sb.from('mkt_video_frames').select('id').eq('content_media_id', m.id).limit(1),
    ]);
    if (vtErr) throw new Error(`frames: visual-text check: ${vtErr.message}`);
    if (frErr) throw new Error(`frames: staged check: ${frErr.message}`);
    if ((vt ?? []).length > 0 || (fr ?? []).length > 0) continue;

    stats.videos++;
    let frames: SampledFrame[] = [];
    let unframeable: string | null = null;
    let bytes: Buffer | null = null;
    try {
      bytes = (await fetchBytes(m.stored_url, 120_000)).bytes;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // ONLY these are facts about the video (object gone, too big, empty) and
      // are recorded against it. Anything else — a timeout, a 5xx, a dropped
      // connection — is the network's problem: rethrow so the job retries,
      // instead of writing the video off for good over a blip.
      if (/^fetch 4\d\d|^oversized|^empty body/.test(msg)) unframeable = `stored video unreadable: ${msg}`;
      else throw new Error(`frames: fetch stored video ${m.id}: ${msg}`);
    }
    if (bytes) {
      const tmp = await toTempFile(bytes, 'mp4');
      try {
        const durationMs = m.duration_ms ?? (await probeDurationMs(tmp.path)) ?? null;
        if (!durationMs) unframeable = 'no readable duration';
        else {
          frames = await sampleFrames(tmp.path, durationMs, 6);
          if (frames.length === 0) unframeable = 'ffmpeg produced no frames';
        }
      } catch (e) {
        // ffmpeg / ffprobe could not decode it — a corrupt or unsupported file.
        unframeable = `decode failed: ${e instanceof Error ? e.message : String(e)}`;
      } finally { await cleanup(tmp.dir); }
    }

    if (unframeable) {
      await markUnframeable(sb, postId, m.id, unframeable);
      stats.videos_failed++;
      stats.errors.push(`video ${m.id}: ${unframeable}`);
      console.error(`[frames] post=${postId} media=${m.id} cannot be framed: ${unframeable}`);
      continue;
    }
    stats.frames_staged += await stageVideoFrames(sb, postId, m.id, frames);
  }
  return stats;
}
