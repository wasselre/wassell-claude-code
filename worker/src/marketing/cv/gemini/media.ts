// ============================================================================
// ffmpeg / ffprobe work for the Gemini visual pipeline: download, probe, find
// hard cuts, make the silent copy the model watches, and cut keyframes.
//
// House posture (same as ffmpegMedia.ts / runPreviewJob): every child runs in
// its own process GROUP and is killed as a group on timeout, so a stuck ffmpeg
// can never leave an orphan eating the machine's memory.
//
// Scale filters use `W:H:force_original_aspect_ratio=decrease`, never
// `min(…,iw)` — a comma inside a -vf token is a filter-chain separator and
// silently produces a broken graph (measured live 2026-08-31).
// ============================================================================
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseScdet, type DetectedCut } from './shots.js';

export interface ProcResult { stdout: string; stderr: string }

export function runProc(bin: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (e) {
        // ESRCH = the group already exited between the timeout firing and the kill.
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') console.error(`[cv/media] kill ${bin} group failed:`, e);
      }
      reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}: ${(stderr || stdout).slice(-400)}`));
    });
  });
}

/** Stream a URL to disk; refuses anything over maxBytes. */
export async function downloadToFile(url: string, path: string, maxBytes = 600_000_000): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status} for ${url.slice(0, 140)}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`permanent: video is ${declared} bytes, over the ${maxBytes} limit`);
  await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), createWriteStream(path));
  const size = (await stat(path)).size;
  if (size === 0) throw new Error(`download returned 0 bytes for ${url.slice(0, 140)}`);
  if (size > maxBytes) throw new Error(`permanent: video is ${size} bytes, over the ${maxBytes} limit`);
  return size;
}

export interface VideoProbe { durationMs: number; fps: number | null; width: number | null; height: number | null }

export async function probeVideo(path: string): Promise<VideoProbe> {
  const { stdout } = await runProc('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'v:0', path], 60_000);
  let j: { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }> };
  try { j = JSON.parse(stdout) as typeof j; } catch (e) {
    throw new Error(`ffprobe returned unreadable JSON: ${(e as Error).message}`);
  }
  const s = j.streams?.[0];
  if (!s) throw new Error('permanent: file has no video stream');
  const secs = Number(j.format?.duration ?? s.duration);
  if (!Number.isFinite(secs) || secs <= 0) throw new Error('permanent: video duration is unknown');
  const rate = (s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate) ?? '';
  const [n, d] = rate.split('/').map(Number);
  const fps = n && d ? Math.round((n / d) * 100) / 100 : null;
  return { durationMs: Math.round(secs * 1000), fps, width: s.width ?? null, height: s.height ?? null };
}

/** Hard-cut candidates with scores (ffmpeg scdet). Scores below 6 are not reported. */
export async function detectCuts(path: string, timeoutMs = 600_000): Promise<DetectedCut[]> {
  const { stderr } = await runProc('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-an', '-vf', 'scdet=threshold=6:sc_pass=0', '-f', 'null', '-'], timeoutMs);
  return parseScdet(stderr);
}

/**
 * The copy the model watches: video only (the transcript carries the speech),
 * at most `maxMs` long. Stream-copied when possible; re-encoded to H.264 when
 * the container refuses a copy.
 */
export async function silentCopy(src: string, dir: string, maxMs: number): Promise<{ path: string; bytes: number }> {
  const out = join(dir, 'silent.mp4');
  const t = (maxMs / 1000).toFixed(3);
  try {
    await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-t', t, '-an', '-c:v', 'copy', '-movflags', '+faststart', out], 300_000);
  } catch (e) {
    console.warn(`[cv/media] stream copy failed, re-encoding: ${(e as Error).message.slice(0, 200)}`);
    await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-t', t, '-an', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-movflags', '+faststart', out], 900_000);
  }
  const bytes = (await stat(out)).size;
  if (bytes === 0) throw new Error('silent copy is empty');
  return { path: out, bytes };
}

/** One JPEG at `tsMs`, long edge at most 960 px. */
export async function extractFrame(src: string, tsMs: number, outPath: string): Promise<Buffer> {
  await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (tsMs / 1000).toFixed(3), '-i', src, '-frames:v', '1',
    '-vf', 'scale=960:960:force_original_aspect_ratio=decrease,format=yuvj420p', '-q:v', '3', outPath], 60_000);
  const buf = await readFile(outPath);
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error(`frame at ${tsMs}ms is not a JPEG (${buf.length} bytes)`);
  return buf;
}

/** JPEG dimensions from the SOF marker (no decode). */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
