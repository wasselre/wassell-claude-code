// ============================================================================
// YouTube media download via yt-dlp (Phase 3). YouTube exposes no direct mp4
// URL, so we fetch a bounded analysis copy (≤720p, ≤~55MB, ≤40min) with yt-dlp,
// STREAMED to temporary disk (never buffered whole in memory), then hand the
// temp path to the caller to store + clean up. Failures are classified so an
// unavailable / private / age-restricted / region-blocked / too-large / too-long
// video is an explicit terminal state, never a silent skip.
//
// yt-dlp is pinned by the Alpine release of the node:22-alpine base tag and uses
// the ffmpeg already in the image. Handles both standard videos and Shorts.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDurationMs, cleanup } from './ffmpegMedia.js';

export type YtFailureKind = 'private' | 'unavailable' | 'age_restricted' | 'region_blocked' | 'too_large' | 'too_long' | 'bot_check' | 'no_output' | 'error';
export class YtDownloadError extends Error {
  constructor(public kind: YtFailureKind, message: string) { super(message); this.name = 'YtDownloadError'; }
}

function classify(stderr: string): YtFailureKind {
  const s = stderr.toLowerCase();
  if (/not a bot|confirm you.?re not a bot|--cookies|cookies-from-browser|sign in to confirm you/.test(s)) return 'bot_check';
  if (/private video/.test(s)) return 'private';
  if (/sign in to confirm your age|age-restricted|confirm your age/.test(s)) return 'age_restricted';
  if (/available in your country|geo-restrict|geo.?block|blocked it in your country|not available from your location/.test(s)) return 'region_blocked';
  if (/larger than.*max-filesize|file is larger/.test(s)) return 'too_large';
  if (/video unavailable|this video is (not|no longer) available|has been removed|account.*terminated/.test(s)) return 'unavailable';
  return 'error';
}

export interface YtDownload { path: string; dir: string; bytes: number; durationMs: number | null; ext: string }

/** Download a bounded analysis copy of a YouTube video to temp disk. Throws
 *  YtDownloadError (classified) on any terminal condition. Caller stores the
 *  bytes then MUST cleanup(dir). */
export async function downloadYouTube(videoId: string, opts: { maxHeight?: number; maxBytesMb?: number; maxDurationSec?: number } = {}): Promise<YtDownload> {
  const maxHeight = opts.maxHeight ?? 720;
  const maxMb = opts.maxBytesMb ?? 55;
  const maxDur = opts.maxDurationSec ?? 2400; // 40 min
  const dir = await mkdtemp(join(tmpdir(), 'mkt-yt-'));
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    // player_client=android/ios/tv avoids YouTube's web bot-check + PO-token
    // requirement that blocks datacenter IPs (Fly). Not guaranteed forever;
    // a bot_check failure is recorded explicitly when even these are blocked.
    '--extractor-args', 'youtube:player_client=android,ios,tv,web_safari',
    '-f', `b[height<=${maxHeight}][ext=mp4]/b[height<=${maxHeight}]/bv*[height<=${maxHeight}]+ba/b`,
    '--max-filesize', `${maxMb}M`,
    '--match-filter', `duration < ${maxDur}`,
    '--no-playlist', '--no-warnings', '--no-progress',
    '--retries', '2', '--socket-timeout', '30',
    '--no-part', '-o', join(dir, 'v.%(ext)s'),
    url,
  ];
  let stderr = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('yt-dlp', args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } reject(new YtDownloadError('error', 'yt-dlp timed out after 300s')); }, 300_000);
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(new YtDownloadError('error', e.message)); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new YtDownloadError(classify(stderr), `yt-dlp exit ${code}: ${stderr.slice(-300)}`)); });
    });
  } catch (e) { await cleanup(dir); throw e; }

  // Locate the downloaded file (yt-dlp picks the ext). --match-filter skip →
  // exit 0 with no file → too_long.
  const files = (await readdir(dir)).filter((f) => f.startsWith('v.'));
  if (files.length === 0) { await cleanup(dir); throw new YtDownloadError('too_long', `no output (likely duration ≥ ${maxDur}s or filtered)`); }
  const path = join(dir, files[0]!);
  const size = (await stat(path)).size;
  if (size === 0) { await cleanup(dir); throw new YtDownloadError('no_output', 'empty output'); }
  const durationMs = await probeDurationMs(path);
  return { path, dir, bytes: size, durationMs, ext: files[0]!.split('.').pop() ?? 'mp4' };
}

export { classify as classifyYtError };
