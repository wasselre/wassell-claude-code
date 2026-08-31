// ============================================================================
// ffmpeg helpers for content understanding: probe duration, extract a compact
// 16 kHz mono audio track for transcription, and sample representative frames
// for visual-text extraction. ffmpeg/ffprobe are installed in the worker image.
//
// House posture (copied from runVideoConvertJob / runPreviewJob): every ffmpeg
// invocation runs in its own process GROUP and is killed as a group on timeout,
// so the launcher can never leave an orphan eating a machine's memory.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`${bin} exited ${code}: ${(err || out).slice(-400)}`)); });
  });
}

/** Write bytes to a fresh temp dir; returns { dir, path } — caller must cleanup(dir). */
export async function toTempFile(bytes: Buffer, ext: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mkt-content-'));
  const path = join(dir, `in.${ext}`);
  await writeFile(path, bytes);
  return { dir, path };
}
export async function cleanup(dir: string): Promise<void> { await rm(dir, { recursive: true, force: true }).catch(() => {}); }

/**
 * Re-encode an image to a bounded JPEG (max 1600px on the long edge, moderate
 * quality) so it fits comfortably under the vision API's ~10 MB per-image limit,
 * and so unsupported source formats (e.g. HEIC) become a plain JPEG the model
 * accepts. Throws if ffmpeg cannot decode the source — the caller then treats the
 * file as un-analysable and applies a kind-based default. Same process-group
 * kill posture as every other ffmpeg call here.
 */
export async function imageToBoundedJpeg(bytes: Buffer, srcExt: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'mkt-img-'));
  const inPath = join(dir, `in.${srcExt || 'img'}`);
  const outPath = join(dir, 'out.jpg');
  try {
    await writeFile(inPath, bytes);
    // Fit within 1600x1600 (no upscale beyond it), then force a baseline
    // yuvj420p JPEG the vision API accepts. NOTE: no min()/commas inside a single
    // -vf token — a comma is a filter-chain separator, so `min(1600,iw)` produces
    // a broken graph and garbage output (measured live 2026-08-31). The comma
    // between `scale=...` and `format=...` below is a legitimate chain of two.
    await run('ffmpeg', ['-y', '-i', inPath,
      '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease,format=yuvj420p',
      '-q:v', '4', outPath], 60_000);
    const out = await readFile(outPath);
    // Guard against ffmpeg exiting 0 with empty/non-JPEG output — send only a
    // real JPEG (SOI marker FF D8), else let the caller apply a kind-default.
    if (out.length < 4 || out[0] !== 0xFF || out[1] !== 0xD8) {
      throw new Error(`ffmpeg produced non-JPEG output (${out.length} bytes)`);
    }
    return out;
  } finally { await cleanup(dir); }
}

/** Video duration in ms via ffprobe, or null if unprobeable. */
export async function probeDurationMs(videoPath: string): Promise<number | null> {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], 30_000);
    const secs = parseFloat(out.trim());
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
  } catch { return null; }
}

/**
 * Does this file carry an audio stream at all?
 *
 * A silent video is COMMON in real-estate marketing — 14 of 74 collected
 * Instagram Reels have no audio track whatsoever (measured 2026-07-27). Without
 * this probe, extractAudio asks ffmpeg to write an audio-only file from a source
 * with nothing to copy; ffmpeg emits "Output file does not contain any stream"
 * and exits 234, which the caller then records as a transcription FAILURE.
 *
 * That is a mislabel, not a malfunction: "this video is silent" is a fact about
 * the creative, and it should read as an empty transcript rather than a broken
 * step. Returns true when unprobeable, so a genuine ffprobe problem still takes
 * the normal error path instead of being silently reclassified as "no audio".
 */
export async function hasAudioStream(videoPath: string): Promise<boolean> {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], 30_000);
    return out.trim().length > 0;
  } catch { return true; }
}

/** Extract a compact 16 kHz mono m4a audio track (Whisper's preferred input). */
export async function extractAudio(videoPath: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'mkt-audio-'));
  const outPath = join(dir, 'audio.m4a');
  try {
    await run('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', outPath], 180_000);
    return await readFile(outPath);
  } finally { await cleanup(dir); }
}

/**
 * Sample representative frames at fractions of the duration (opening, spread,
 * closing) — bounded, not every frame. Returns downscaled JPEGs with timestamps.
 * Deliberately fraction-based rather than scene-detection: deterministic, cheap,
 * and guarantees title-card coverage at start/end where offers usually appear.
 */
export async function sampleFrames(videoPath: string, durationMs: number, count = 6): Promise<Array<{ tsMs: number; jpeg: Buffer }>> {
  const fracs = count <= 1 ? [0.1] : [0.05, 0.2, 0.4, 0.6, 0.8, 0.95].slice(0, count);
  const dir = await mkdtemp(join(tmpdir(), 'mkt-frames-'));
  const frames: Array<{ tsMs: number; jpeg: Buffer }> = [];
  try {
    for (let i = 0; i < fracs.length; i++) {
      const tsMs = Math.max(0, Math.min(durationMs - 200, Math.round(durationMs * fracs[i]!)));
      const outPath = join(dir, `f${i}.jpg`);
      try {
        // fast seek before -i, one frame, downscaled to keep vision cost low
        await run('ffmpeg', ['-y', '-ss', (tsMs / 1000).toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=768:-1', '-q:v', '3', outPath], 45_000);
        frames.push({ tsMs, jpeg: await readFile(outPath) });
      } catch { /* one frame failing is not fatal — keep the rest */ }
    }
    return dedupeFrames(frames);
  } finally { await cleanup(dir); }
}

/** Drop near-duplicate adjacent frames by JPEG byte-size proximity (no image decoder needed). */
function dedupeFrames(frames: Array<{ tsMs: number; jpeg: Buffer }>): Array<{ tsMs: number; jpeg: Buffer }> {
  const kept: Array<{ tsMs: number; jpeg: Buffer }> = [];
  for (const f of frames) {
    const prev = kept[kept.length - 1];
    if (prev && Math.abs(prev.jpeg.length - f.jpeg.length) / Math.max(1, prev.jpeg.length) < 0.02) continue; // ~identical size → likely static scene
    kept.push(f);
  }
  return kept;
}

export { readdir };
