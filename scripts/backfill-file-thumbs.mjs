#!/usr/bin/env node
// ============================================================================
// backfill-file-thumbs.mjs — a stored poster (files.thumb_path) for every
// VIDEO and PDF that does not have one yet.
//
//   node scripts/backfill-file-thumbs.mjs --dry-run
//   node scripts/backfill-file-thumbs.mjs --confirm [--concurrency 4] [--limit N] [--force]
//
// New uploads get their poster from the worker's enrichment lane
// (worker/src/lib/fileThumb.ts). This script is the one-time sweep for files
// that were enriched before that existed — and the repair tool if a poster is
// ever missing. Resumable: it only touches rows whose thumb_path is NULL
// (unless --force).
//
//   video → one frame at 20% of the duration (skips fade-ins / logo cards),
//           read by ffmpeg straight from a signed URL (range requests — the
//           video is not downloaded whole).
//   pdf   → page 1, rendered by PyMuPDF.
//
// Both become a 480px-wide JPEG at `thumbs/<file_id>.jpg` in the file's OWN
// bucket. No AI call, nothing metered.
//
// Needs on PATH: ffmpeg, and python with PyMuPDF (`pip install pymupdf`).
// ENV: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .env).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeIdentifiedClient } from './_lib/serviceClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^"(.*)"$/.test(v)) v = v.slice(1, -1); else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(REPO, '.env.local'));
loadEnvFile(path.join(REPO, '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(2); }
const sb = makeIdentifiedClient('script:backfill-file-thumbs', SUPABASE_URL, SERVICE_KEY);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DRY = flag('dry-run');
const CONFIRM = flag('confirm');
const FORCE = flag('force');
const CONCURRENCY = Math.max(1, Number(opt('concurrency', 4)));
const LIMIT = Number(opt('limit', 0));
if (!DRY && !CONFIRM) { console.error('pass --dry-run or --confirm'); process.exit(2); }

const THUMB_WIDTH = 480;

function run(cmd, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out)); else reject(new Error(`${cmd} exit ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`));
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

async function videoPoster(signedUrl, durationSeconds) {
  const out = path.join(os.tmpdir(), `thumb-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
  const at = durationSeconds && durationSeconds > 1 ? Math.max(0.5, durationSeconds * 0.2) : 0;
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', signedUrl, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4', out]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      // A seek past the last keyframe yields no frame — take the first one.
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', signedUrl, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4', out]);
    }
    const bytes = fs.readFileSync(out);
    if (bytes.length === 0) throw new Error('ffmpeg produced an empty frame');
    return bytes;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

const PDF_PY = `
import sys, fitz
data = sys.stdin.buffer.read()
doc = fitz.open(stream=data, filetype='pdf')
page = doc[0]
zoom = ${THUMB_WIDTH} / max(1.0, page.rect.width)
pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
sys.stdout.buffer.write(pix.tobytes('jpeg', jpg_quality=80))
`;
async function pdfPoster(bucket, storagePath) {
  const { data, error } = await sb.storage.from(bucket).download(storagePath);
  if (error) throw new Error(`download: ${error.message}`);
  const bytes = Buffer.from(await data.arrayBuffer());
  const jpeg = await run('python', ['-c', PDF_PY], { input: bytes });
  if (jpeg.length === 0) throw new Error('PyMuPDF produced no image');
  return jpeg;
}

async function loadTargets() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('files')
      .select('id, kind, storage_bucket, storage_path, duration_seconds, size_bytes')
      .in('kind', ['video', 'pdf'])
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (!FORCE) q = q.is('thumb_path', null);
    const { data, error } = await q;
    if (error) throw new Error(`list files: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
}

async function one(f) {
  let jpeg;
  if (f.kind === 'video') {
    const { data, error } = await sb.storage.from(f.storage_bucket).createSignedUrl(f.storage_path, 600);
    if (error) throw new Error(`sign: ${error.message}`);
    jpeg = await videoPoster(data.signedUrl, Number(f.duration_seconds) || 0);
  } else {
    jpeg = await pdfPoster(f.storage_bucket, f.storage_path);
  }
  const thumbPath = `thumbs/${f.id}.jpg`;
  const { error: upErr } = await sb.storage.from(f.storage_bucket).upload(thumbPath, jpeg, { contentType: 'image/jpeg', upsert: true });
  if (upErr) throw new Error(`upload: ${upErr.message}`);
  const { data: upd, error: dbErr } = await sb.from('files').update({ thumb_path: thumbPath }).eq('id', f.id).select('id');
  if (dbErr) throw new Error(`update: ${dbErr.message}`);
  if (!upd || upd.length === 0) throw new Error('update changed no row');
  return jpeg.length;
}

const targets = await loadTargets();
const byKind = targets.reduce((a, f) => { a[f.kind] = (a[f.kind] ?? 0) + 1; return a; }, {});
console.log(`targets: ${targets.length}`, byKind, DRY ? '(dry run — nothing written)' : '');
// No process.exit(): on Windows it trips a libuv assertion while the Supabase
// client's sockets are still closing. Let the event loop drain instead.
if (!DRY) {

let done = 0, failed = 0, idx = 0;
const failures = [];
async function lane() {
  for (;;) {
    const f = targets[idx++];
    if (!f) return;
    try {
      await one(f);
      done++;
    } catch (e) {
      failed++;
      failures.push({ id: f.id, kind: f.kind, error: e instanceof Error ? e.message : String(e) });
      console.error(`FAILED ${f.kind} ${f.id}: ${e instanceof Error ? e.message : e}`);
    }
    if ((done + failed) % 25 === 0) console.log(`progress ${done + failed}/${targets.length} (failed ${failed})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, lane));
console.log(`done: ${done} written, ${failed} failed of ${targets.length}`);
if (failures.length) console.log(JSON.stringify(failures, null, 1));
process.exitCode = failed > 0 ? 1 : 0;
}
