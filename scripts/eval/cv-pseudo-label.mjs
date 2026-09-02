#!/usr/bin/env node
/**
 * scripts/eval/cv-pseudo-label.mjs
 * ----------------------------------------------------------------------------
 * Machine PSEUDO-labels for the shot-boundary golden set, to be used until a
 * human has marked cuts (docs/eval/cv-golden-30-labeling.md).
 *
 * For every video in docs/eval/cv-golden-30.json: download the public
 * stored_url to a local cache (≤ 50 MB each), run ffmpeg's scene-change
 * detector at a CONSERVATIVE threshold, and write the cut timestamps into
 * `pseudo_boundaries_ms` (+ `pseudo_method`, `pseudo_labeled_at`,
 * `pseudo_threshold`). Human `boundaries_ms` are never touched.
 *
 *   ffmpeg -i in.mp4 -vf "select='gt(scene,0.4)',showinfo" -f null -
 *
 * The threshold 0.4 is deliberately high: it catches hard cuts and misses
 * slow dissolves / fades, so pseudo-labels are HIGH-PRECISION, LOW-RECALL.
 * cv-eval.mjs therefore reports precision against pseudo-labels as a real
 * signal and recall only as a lower bound (see README "Pseudo-labels").
 *
 *   node scripts/eval/cv-pseudo-label.mjs                       # all 30
 *   node scripts/eval/cv-pseudo-label.mjs --only G01,G07        # subset
 *   node scripts/eval/cv-pseudo-label.mjs --threshold 0.3       # looser
 *   node scripts/eval/cv-pseudo-label.mjs --force               # re-run even if labelled
 *   node scripts/eval/cv-pseudo-label.mjs --cache <dir>         # default %TMP%/wassel-eval/cv
 *
 * No network beyond the public Supabase storage URLs. Requires ffmpeg on PATH;
 * if absent it prints a clear note and exits 0 WITHOUT writing labels (so a
 * CI box without ffmpeg does not silently produce an empty golden set).
 * ----------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs, ROOT } from './_lib/env.mjs';

const args = parseArgs();
const GOLDEN = join(ROOT, 'docs', 'eval', 'cv-golden-30.json');
const THRESHOLD = Number(args.threshold ?? 0.4);
const CACHE = args.cache ? String(args.cache) : join(tmpdir(), 'wassel-eval', 'cv');
const ONLY = args.only ? new Set(String(args.only).split(',').map((s) => s.trim())) : null;
const FORCE = Boolean(args.force);
const CONCURRENCY = Number(args.concurrency ?? 3);
const MAX_BYTES = 50 * 1024 * 1024;

function ffmpegVersion() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = /ffmpeg version (\S+)/.exec(r.stdout || '');
  return m ? m[1] : 'unknown';
}

async function download(url, dest, expectedBytes) {
  if (existsSync(dest)) {
    const size = statSync(dest).size;
    if (!expectedBytes || size === expectedBytes) return { cached: true, bytes: size };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`download ${url} is ${len} bytes > 50 MB cap`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`download ${url} is ${buf.length} bytes > 50 MB cap`);
  writeFileSync(dest, buf);
  return { cached: false, bytes: buf.length };
}

/** Run ffmpeg scene detection; returns sorted cut timestamps in ms. */
function detectScenes(file, threshold) {
  return new Promise((resolve, reject) => {
    const vf = `select='gt(scene,${threshold})',showinfo`;
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', vf, '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code} on ${file}: ${err.slice(-400)}`));
      const ts = [];
      for (const m of err.matchAll(/pts_time:\s*([0-9.]+)/g)) ts.push(Math.round(Number(m[1]) * 1000));
      resolve([...new Set(ts)].sort((a, b) => a - b));
    });
  });
}

async function main() {
  const ver = ffmpegVersion();
  if (!ver) {
    console.log('NOTE: ffmpeg is not on PATH — pseudo-labels NOT produced. Install ffmpeg (https://ffmpeg.org, or `winget install Gyan.FFmpeg`) and re-run. Human labels (boundaries_ms) are unaffected.');
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const method = `ffmpeg-${ver} select=gt(scene,${THRESHOLD})`;
  const todo = golden.videos.filter((v) => (!ONLY || ONLY.has(v.golden_id)) && (FORCE || !Array.isArray(v.pseudo_boundaries_ms) || v.pseudo_method !== method));
  console.log(`ffmpeg ${ver} · threshold ${THRESHOLD} · cache ${CACHE} · ${todo.length}/${golden.videos.length} videos to label`);

  const failures = [];
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const v = todo[i++];
      const dest = join(CACHE, `${v.content_media_id}.mp4`);
      const t0 = Date.now();
      try {
        const dl = await download(v.stored_url, dest, v.bytes);
        const cuts = await detectScenes(dest, THRESHOLD);
        // Drop a spurious cut at t=0 (showinfo emits the first selected frame) and anything past the duration.
        const cleaned = cuts.filter((ms) => ms > 0 && ms < v.duration_ms);
        v.pseudo_boundaries_ms = cleaned;
        v.pseudo_method = method;
        v.pseudo_threshold = THRESHOLD;
        v.pseudo_labeled_at = new Date().toISOString();
        v.local_cache_path = dest;
        console.log(`${v.golden_id} ${v.platform} ${(v.duration_ms / 1000).toFixed(1)}s → ${cleaned.length} cuts (${dl.cached ? 'cached' : 'downloaded'}, ${Date.now() - t0} ms)`);
      } catch (e) {
        failures.push({ golden_id: v.golden_id, error: e instanceof Error ? e.message : String(e) });
        console.error(`${v.golden_id} FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  golden.counts.pseudo_labeled = golden.videos.filter((v) => Array.isArray(v.pseudo_boundaries_ms)).length;
  golden.pseudo_label_run = { at: new Date().toISOString(), method, threshold: THRESHOLD, failures };
  writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
  const total = golden.videos.reduce((n, v) => n + (v.pseudo_boundaries_ms?.length || 0), 0);
  console.log(`done: ${golden.counts.pseudo_labeled}/${golden.videos.length} pseudo-labelled, ${total} cuts total, ${failures.length} failures`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
