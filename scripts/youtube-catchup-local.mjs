#!/usr/bin/env node
/**
 * YouTube catch-up from a residential connection (operator-run, 2026-10-04).
 *
 * The Fly worker downloads competitor YouTube videos with yt-dlp, but YouTube
 * refuses some requests from datacenter addresses (bot check, or a 403 from
 * its video CDN): ~8% of YouTube videos were left `failed`. Run from a laptop
 * on a home connection, this script retries exactly those, storing each video
 * the way the worker does (`content/video/<sha256>.<ext>` in marketing-assets,
 * `mkt_content_media_upsert` status 'stored'), then queues the post's
 * `content_process` job so it is read WITH its video and offered to shots.
 *
 *   node scripts/youtube-catchup-local.mjs [--dry-run] [--limit N]
 *
 * Only retryable failures are taken (bot_check, 403, empty file, timeout);
 * unavailable / private / too long stay as they are. Needs yt-dlp + ffprobe on
 * PATH and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env.local).
 * No AI call is made here — the read happens in the worker and is metered there.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      if (!env[k]) env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e; // a missing .env.local is fine when env is set; anything else is not
  }
  return env;
}

const env = loadEnv();
const SB_URL = env.SUPABASE_URL, SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const BUCKET = 'marketing-assets';
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const RETRYABLE = /^bot_check|403|file is empty|timed out/i;

async function failedVideos() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('mkt_content_media')
      .select('id, content_post_id, failure_reason, mkt_content_posts!inner(platform, external_id)')
      .eq('media_kind', 'video').eq('download_status', 'failed').eq('mkt_content_posts.platform', 'youtube')
      .order('id').range(from, from + 999);
    if (error) throw new Error(`failed videos: ${error.message}`);
    for (const r of data ?? []) if (RETRYABLE.test(r.failure_reason ?? '')) out.push(r);
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Same format choice and limits as worker/src/marketing/content/ytdlp.ts.
// On timeout the WHOLE process tree is killed: yt-dlp.exe is a launcher whose
// python child keeps the output pipe open, so killing only the launcher left the
// first run of this script waiting forever (2026-10-04).
function ytdlp(videoId, dir) {
  const argv = [
    '-f', 'b[height<=720][ext=mp4]/b[height<=720]/bv*[height<=720]+ba/b',
    '--max-filesize', '55M', '--match-filter', 'duration < 2400',
    '--no-playlist', '--no-warnings', '--no-progress', '--retries', '2', '--socket-timeout', '30',
    '--no-part', '--print', 'after_move:%(duration)s', '-o', join(dir, 'v.%(ext)s'),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', argv, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGKILL');
    }, 300_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('yt-dlp timed out after 300s'));
      if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.trim().slice(-200)}`));
      const dur = Number(out.trim().split(/\r?\n/).pop());
      resolve(Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null);
    });
  });
}

function probe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path], { encoding: 'utf8' });
  const m = /^(\d+)x(\d+)/.exec((r.stdout || '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

async function main() {
  const rows = (await failedVideos()).slice(0, LIMIT);
  console.log(`[yt-catchup] ${rows.length} retryable failed YouTube videos${DRY ? ' (dry run)' : ''}`);
  let stored = 0, failed = 0;
  for (const r of rows) {
    const vid = r.mkt_content_posts.external_id;
    if (DRY) { console.log(`  would fetch ${vid} (${(r.failure_reason ?? '').slice(0, 40)})`); continue; }
    const dir = await mkdtemp(join(tmpdir(), 'yt-catchup-'));
    try {
      const durationMs = await ytdlp(vid, dir);
      const file = (await readdir(dir)).find((f) => f.startsWith('v.'));
      if (!file) throw new Error('no output file (filtered by size/duration?)');
      const path = join(dir, file);
      const bytes = await readFile(path);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const ext = file.split('.').pop() === 'mp4' ? 'mp4' : file.split('.').pop();
      const objectPath = `content/video/${checksum}.${ext}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, 'content-type': 'video/mp4', 'x-upsert': 'true' },
        body: new Blob([bytes], { type: 'video/mp4' }),
      });
      if (!up.ok && up.status !== 409) throw new Error(`storage upload ${up.status}: ${(await up.text()).slice(0, 160)}`);
      const dims = probe(path);
      const { error: upErr } = await sb.rpc('mkt_content_media_upsert', {
        p_post: r.content_post_id, p_carousel_index: 0, p_kind: 'video', p_original_url: `https://www.youtube.com/watch?v=${vid}`,
        p_bucket: BUCKET, p_path: objectPath, p_url: `${SB_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`,
        p_mime: 'video/mp4', p_bytes: bytes.length, p_width: dims?.width ?? null, p_height: dims?.height ?? null,
        p_duration_ms: durationMs, p_checksum: checksum, p_phash: null, p_status: 'stored', p_failure: null,
      });
      if (upErr) throw new Error(`media upsert: ${upErr.message}`);
      // Read it now, with the video (also offers it to shots when cv.enabled).
      const { error: jobErr } = await sb.rpc('mkt_job_enqueue', {
        p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null,
        p_params: { content_post_id: r.content_post_id, from: 'youtube-catchup-local' }, p_priority: 60, p_requested_by: null, p_fallback_of: null,
      });
      if (jobErr) throw new Error(`enqueue: ${jobErr.message}`);
      stored++;
      console.log(`  stored ${vid} ${(bytes.length / 1e6).toFixed(1)} MB`);
    } catch (e) {
      failed++;
      const reason = `local: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      console.error(`  FAILED ${vid}: ${reason}`);
      // Record what a residential connection got, so a video that is really gone
      // ("not available") stops looking retryable; a 403 / timeout stays retryable.
      const { error: recErr } = await sb.rpc('mkt_content_media_upsert', {
        p_post: r.content_post_id, p_carousel_index: 0, p_kind: 'video', p_original_url: `https://www.youtube.com/watch?v=${vid}`,
        p_bucket: null, p_path: null, p_url: null, p_mime: null, p_bytes: null, p_width: null, p_height: null,
        p_duration_ms: null, p_checksum: null, p_phash: null, p_status: 'failed', p_failure: reason,
      });
      if (recErr) console.error(`  could not record failure for ${vid}: ${recErr.message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(`[yt-catchup] FINISHED stored=${stored} failed=${failed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
