#!/usr/bin/env node
/**
 * Backfill: import each marketed project's brochure URL (`broucher_developer`)
 * into a real CRM Files record, so the app / bot can send it and Content
 * Readiness goes green.
 *
 * For every OUR (our_projects → all_projects) project that has a
 * `broucher_developer` URL but NO brochure FILE (primary_category='brochure'
 * linked to it): fetch the PDF, upload to storage (wassel-files), INSERT a
 * `files` row typed primary_category='brochure', and link it to the project via
 * `document_links`. Idempotent: re-queries "no brochure file" so a re-run never
 * duplicates. Best-effort per project — one bad URL is reported, the rest run.
 *
 * Usage:
 *   node scripts/backfill-brochure-urls.mjs --dry-run      # fetch+validate only, no writes
 *   node scripts/backfill-brochure-urls.mjs                # do the import
 *   node scripts/backfill-brochure-urls.mjs --limit 5      # cap for a trial run
 *
 * Env (auto-loaded from .env.local / .env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// ── env (no dotenv dep) ──────────────────────────────────────────────
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1);
}

const DRY = process.argv.includes('--dry-run');
const limIdx = process.argv.indexOf('--limit');
const LIMIT = limIdx >= 0 ? Number(process.argv[limIdx + 1]) : Infinity;

// Reuse the established brochure uploader identity + storage prefix (matches the
// existing brochure files, so RLS visibility is identical).
const OWNER_USER_ID = 'a3374d65-9cee-4daa-8880-5e8ff23e7db0'; // public.users id
const STORAGE_PREFIX = '31621e58-c723-45ad-9e4f-6f8ba1689fe7'; // that user's auth.uid
const BUCKET = 'wassel-files';
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB fetch cap (oversized ones get compressed below)

// Supabase Storage's single-request upload rejects objects above ~50 MiB (a 49.5
// MB brochure uploads; a 74 MiB one fails). WhatsApp caps documents at 100 MB.
// So any brochure over this threshold is re-rendered to a smaller PDF (Ghostscript
// isn't installable here without admin; PyMuPDF flattens image-heavy brochures
// reliably) targeting 45 MiB before upload.
const COMPRESS_ABOVE = 48 * 1024 * 1024;
const PY = process.env.PYTHON || 'python';
const COMPRESS_SCRIPT = fileURLToPath(new URL('./compress-pdf.py', import.meta.url));

/** Re-render an oversized PDF to fit the upload ceiling. Returns the (possibly
 *  unchanged) buffer + a note. Throws if compression fails. */
function maybeCompress(buf) {
  if (buf.length <= COMPRESS_ABOVE) return { buf, note: '' };
  const inP = join(tmpdir(), `broch-${randomUUID()}.pdf`);
  const outP = join(tmpdir(), `broch-${randomUUID()}-c.pdf`);
  writeFileSync(inP, buf);
  try {
    const r = spawnSync(PY, [COMPRESS_SCRIPT, inP, outP, '45'], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 20 });
    const err = (r.stderr || '').toString().trim();
    if (r.status !== 0) throw new Error(`compress: ${err || `python exited ${r.status}`}`);
    const out = readFileSync(outP);
    return { buf: out, note: `compressed ${(buf.length / 1024 / 1024).toFixed(0)}→${(out.length / 1024 / 1024).toFixed(1)} MiB (${err})` };
  } finally {
    try { unlinkSync(inP); } catch { /* temp file cleanup — safe to ignore if absent */ }
    try { unlinkSync(outP); } catch { /* temp file cleanup — safe to ignore if absent */ }
  }
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function isDriveUrl(url) {
  return /drive\.google\.com|docs\.google\.com/.test(url);
}
function driveId(url) {
  const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}
/** Turn a share URL into a directly-fetchable one (Google Drive → usercontent download). */
function toDownloadUrl(url) {
  const id = driveId(url);
  if (id && isDriveUrl(url)) {
    // usercontent endpoint + confirm=t skips the small-file scan warning up front.
    return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  }
  return url;
}

function isPdf(buf, contentType) {
  if (contentType && contentType.toLowerCase().includes('pdf')) return true;
  // magic bytes: %PDF
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

const FETCH_TIMEOUT_MS = 150_000; // generous — some hosts serve 100 MB+ brochures slowly
function timedFetch(u) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(u, { redirect: 'follow', signal: ac.signal }).finally(() => clearTimeout(t));
}

async function fetchPdf(url) {
  let res = await timedFetch(toDownloadUrl(url));
  let ct = res.headers.get('content-type') || '';
  // Google Drive virus-scan interstitial: an HTML page carrying a <form> that
  // POSTs (as GET params) to drive.usercontent.google.com with hidden id/export/
  // confirm/uuid inputs. Reconstruct that URL and refetch.
  if (ct.includes('text/html') && isDriveUrl(url)) {
    const html = await res.text();
    // Preferred: rebuild the download form's query from its hidden inputs.
    const action = (html.match(/action="([^"]*drive\.usercontent\.google\.com\/download[^"]*)"/) || [])[1];
    const params = new URLSearchParams();
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      params.set(m[1], m[2]);
    }
    // Legacy inline-token fallback.
    const tok = (html.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1];
    const id = driveId(url);
    if (action && params.get('id')) {
      res = await timedFetch(`https://drive.usercontent.google.com/download?${params.toString()}`);
      ct = res.headers.get('content-type') || '';
    } else if (id) {
      res = await timedFetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${tok || 't'}`);
      ct = res.headers.get('content-type') || '';
    } else {
      throw new Error('drive interstitial (no download form — likely needs manual export)');
    }
    if (ct.includes('text/html')) throw new Error('drive interstitial (still HTML after confirm — likely needs manual export)');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`too large (${buf.length} bytes)`);
  if (!isPdf(buf, ct)) throw new Error(`not a PDF (content-type=${ct || 'none'}, ${buf.length}B)`);
  return buf;
}

async function main() {
  // model ids
  const { data: models, error: mErr } = await sb.from('models').select('id, name').in('name', ['all_projects', 'our_projects']);
  if (mErr) throw mErr;
  const apId = models.find((m) => m.name === 'all_projects').id;
  const opId = models.find((m) => m.name === 'our_projects').id;

  // our project ids
  const { data: opRows, error: opErr } = await sb.from('records').select('data').eq('model_id', opId);
  if (opErr) throw opErr;
  const ourIds = [...new Set(opRows.map((r) => r.data?.project).filter((x) => typeof x === 'string' && x))];

  // all_projects rows for our set, paginated
  const projects = [];
  for (let i = 0; i < ourIds.length; i += 200) {
    const { data, error } = await sb.from('records').select('id, data').eq('model_id', apId).in('id', ourIds.slice(i, i + 200));
    if (error) throw error;
    projects.push(...data);
  }

  // which of our projects already have a brochure FILE (skip those)
  const { data: brochLinks, error: blErr } = await sb
    .from('file_links')
    .select('record_id, file:files!inner(primary_category)')
    .eq('model_id', apId)
    .in('record_id', ourIds)
    .eq('file.primary_category', 'brochure');
  if (blErr) throw blErr;
  const hasFile = new Set((brochLinks || []).map((r) => r.record_id));

  const targets = projects.filter((p) => {
    const url = (p.data?.broucher_developer || '').trim();
    return url && !hasFile.has(p.id);
  }).slice(0, LIMIT);

  console.error(`${DRY ? '[DRY-RUN] ' : ''}${targets.length} project(s) with a brochure URL but no brochure file.\n`);

  let ok = 0, fail = 0;
  const failures = [];
  for (const p of targets) {
    const name = (p.data?.project_name || p.id).toString();
    const url = p.data.broucher_developer.trim();
    try {
      const raw = await fetchPdf(url);
      if (DRY) {
        const tag = raw.length > COMPRESS_ABOVE ? ' → would compress' : '';
        console.error(`  ✓ would import  ${name}  (${(raw.length / 1024 / 1024).toFixed(1)} MB${tag})`);
        ok++; continue;
      }
      const { buf, note } = maybeCompress(raw);
      const fileId = randomUUID();
      const storagePath = `${STORAGE_PREFIX}/${fileId}.pdf`;
      const up = await sb.storage.from(BUCKET).upload(storagePath, buf, { contentType: 'application/pdf', upsert: false });
      if (up.error) throw new Error(`upload: ${up.error.message}`);

      const now = new Date().toISOString();
      const fileRow = {
        id: fileId,
        uploaded_by_user_id: OWNER_USER_ID,
        owner_user_id: OWNER_USER_ID,
        original_name: `${name} - بروشور.pdf`,
        mime_type: 'application/pdf',
        size_bytes: buf.length,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        kind: 'pdf',
        title: `${name} - بروشور`,
        document_type: 'other',
        tags: [],
        status: 'active',
        origin: 'user_upload',
        file_class: 'business',
        confidentiality: 'internal',
        ai_suggestions: {},
        primary_category: 'brochure',
        created_at: now,
        updated_at: now,
      };
      const fi = await sb.from('files').insert(fileRow);
      if (fi.error) { await sb.storage.from(BUCKET).remove([storagePath]); throw new Error(`files insert: ${fi.error.message}`); }

      const li = await sb.from('document_links').insert({
        id: randomUUID(), file_id: fileId, model_id: apId, record_id: p.id,
        created_by_user_id: OWNER_USER_ID, role: 'marketing_asset', created_at: now,
      });
      if (li.error) throw new Error(`link insert: ${li.error.message}`);

      console.error(`  ✓ imported  ${name}  (${(buf.length / 1024 / 1024).toFixed(1)} MB${note ? `; ${note}` : ''})`);
      ok++;
    } catch (e) {
      console.error(`  ✗ FAILED    ${name}  — ${e.message}`);
      failures.push({ name, url, error: e.message });
      fail++;
    }
  }

  console.error(`\n${DRY ? '[DRY-RUN] ' : ''}done: ${ok} ${DRY ? 'importable' : 'imported'}, ${fail} failed.`);
  if (failures.length) {
    console.error('\nFailures (need manual handling):');
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}\n      ${f.url}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
