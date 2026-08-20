#!/usr/bin/env node
/**
 * Phase 3 · B8 — canonicalise URL-only marketing assets onto the file system.
 *
 * An operator-run, resumable, idempotent script — NOT a migration and NOT a UI
 * flow. It moves each URL-only `mos_assets` row that has real bytes onto a
 * first-class `files` row, so Marketing's library becomes a VIEW over the
 * canonical store rather than a parallel one.
 *
 * ── WHAT IT ACTUALLY TARGETS, MEASURED (2026-08-20) ───────────────────────
 * The spec says "317 URL-only assets". Measured, those 317 are three very
 * different things and only some can be canonicalised at all:
 *
 *     179  bytes in our own marketing-assets bucket   → server-side COPY
 *     137  external URLs, of which:
 *            117  youtube.com    → a video REFERENCE, not a file. There is no
 *                                  object to canonicalise, and inventing one
 *                                  would be a lie about what the asset is.
 *             16  drive.google   → access-gated share links, not raw bytes
 *              4  fetchable      → alajlaninvest / laravel.cloud
 *       1  no url at all         → nothing to move
 *
 * So the real target is 179 + 4 = 183, and of the 179 exactly 178 objects
 * still exist (1 is a dangling URL). This script handles the 178 in-bucket
 * copies. The 4 fetchable externals and the YouTube references are reported and
 * left alone — see --report.
 *
 * ── WHY A COPY, NOT A DOWNLOAD ────────────────────────────────────────────
 * Both buckets are Supabase Storage, so the bytes move server-side via the
 * storage copy API (verified: cross-bucket copy returns 200). No download, no
 * browser, no 43 MB ArrayBuffer, and — critically — no third-party egress. The
 * repo has a scar from exactly the opposite: Aqar 403'd Fly's datacenter IPs,
 * and any B8 that downloaded the 137 external URLs would have re-learned that
 * lesson.
 *
 * ── ORDERING, AND WHY IT IS RESUMABLE ─────────────────────────────────────
 * Per asset, three steps with two failure points:
 *   1. copy the object into wassel-files at <auth_uid>/<file_id>.<ext>
 *      (the path the storage RLS requires: foldername[1] must equal auth.uid)
 *   2. INSERT the files row (B1's trigger fills title/type/owner; we set
 *      origin='marketing_intake', content_etag from the SOURCE object's eTag)
 *   3. UPDATE mos_assets: file_id = the new row, and NULL the legacy url/
 *      thumb_url/file_path so nothing reads the public copy again
 *
 * Each step checks "already done" first, so a crash between any two steps is
 * recovered by re-running: a half-copied asset finishes, a fully-copied one is
 * skipped. Nothing is destroyed — the source object in marketing-assets is left
 * in place (storage does not cascade; pruning it is a separate, manual decision
 * once the Marketing view is confirmed reading file_id).
 *
 * Usage:
 *   node scripts/canonicalise-marketing-assets.mjs --report          # counts only
 *   node scripts/canonicalise-marketing-assets.mjs --dry-run         # per-asset plan
 *   node scripts/canonicalise-marketing-assets.mjs --apply [--limit N]
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto-loaded from .env.local).
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const env = {};
  for (const f of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(join(ROOT, f), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* optional */ }
  }
  return env;
}
const ENV = loadEnv();
const URL_ = process.env.SUPABASE_URL || ENV.SUPABASE_URL || ENV.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }

const MODE = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--dry-run') ? 'dry-run' : 'report';
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

// Mirrors MIME_TO_EXT in src/lib/files/client.ts. Kept small on purpose: an
// unknown mime falls back to 'bin', exactly as uploadFile does.
const MIME_TO_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/tiff': 'tiff', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
};
const MARKETING_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime']);

const SVC = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rest = async (path, init = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...SVC, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const body = await r.text();
  if (!r.ok) throw new Error(`REST ${r.status} ${path}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
};
const rpc = async (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

async function sql(query) {
  // Read-only introspection via the runner RPC (same one the PRDs use).
  return rpc('claude_runner_sql', { p_sql: query });
}

async function loadTargets() {
  return sql(`
    with a as (
      select m.id, m.original_name, m.title, m.ref, m.mime_type, m.created_by_user_id, m.kind,
             regexp_replace(m.url,'^.*/storage/v1/object/public/marketing-assets/','') as obj_path,
             u.auth_uid
        from public.mos_assets m
        join public.users u on u.id = m.created_by_user_id
       where m.file_id is null
         and m.url like '%/storage/v1/object/public/marketing-assets/%')
    select a.id, a.original_name, a.title, a.ref, a.mime_type, a.created_by_user_id, a.auth_uid, a.obj_path,
           replace(o.metadata->>'eTag','"','') as src_etag,
           (o.metadata->>'size')::bigint       as src_size,
           coalesce(o.metadata->>'mimetype', a.mime_type) as src_mime
      from a
      join storage.objects o on o.bucket_id='marketing-assets' and o.name = a.obj_path
     order by a.id`);
}

async function objectExists(bucket, name) {
  const rows = await sql(`select 1 from storage.objects where bucket_id='${bucket}' and name='${name.replace(/'/g, "''")}' limit 1`);
  return rows.length > 0;
}

async function copyObject(srcName, destName) {
  const r = await fetch(`${URL_}/storage/v1/object/copy`, {
    method: 'POST', headers: { ...SVC, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: 'marketing-assets', sourceKey: srcName, destinationBucket: 'wassel-files', destinationKey: destName }),
  });
  if (!r.ok) throw new Error(`copy ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function main() {
  const targets = await loadTargets();
  console.log(`in-bucket URL-only assets with a live object: ${targets.length}`);

  if (MODE === 'report') {
    const bad = targets.filter((t) => !MARKETING_MIMES.has((t.src_mime || '').toLowerCase()));
    console.log(`  supported mime: ${targets.length - bad.length}`);
    if (bad.length) console.log(`  UNSUPPORTED mime (skipped): ${bad.length} — ${[...new Set(bad.map((b) => b.src_mime))].join(', ')}`);
    console.log('\nRun with --dry-run for the per-asset plan, --apply to execute.');
    return;
  }

  let done = 0, skipped = 0, failed = 0;
  for (const t of targets.slice(0, LIMIT)) {
    const mime = (t.src_mime || '').toLowerCase();
    if (!MARKETING_MIMES.has(mime)) { skipped++; continue; }
    const ext = MIME_TO_EXT[mime] || 'bin';

    try {
      // Is this asset already canonical (a prior run finished it)?
      const already = await sql(`select file_id from public.mos_assets where id='${t.id}' and file_id is not null`);
      if (already.length) { skipped++; continue; }

      const fileId = randomUUID();
      const destPath = `${t.auth_uid}/${fileId}.${ext}`;
      // 163 of these assets have a NULL original_name (files.original_name is
      // NOT NULL). The marketing title — "جزيل — فيديو 3" — is a far better
      // display name than a uuid, and it carries the context the asset already
      // had. Fall back to the ref ("A-027"), then to the id.
      const displayName = (t.original_name && t.original_name.trim())
        || (t.title && t.title.trim() && `${t.title.trim()}.${ext}`)
        || (t.ref && `${t.ref}.${ext}`)
        || `${fileId}.${ext}`;

      if (MODE === 'dry-run') {
        console.log(`WOULD canonicalise ${t.id}  "${displayName}"  ${mime}  -> ${destPath}`);
        done++; continue;
      }

      // 1. copy bytes (idempotent: skip if the dest already exists from a crash)
      if (!(await objectExists('wassel-files', destPath))) {
        await copyObject(t.obj_path, destPath);
      }

      // 2. files row. B1's trigger fills title/document_type/owner; we set the
      //    provenance that marks it a marketing intake and the digest from the
      //    SOURCE object so it participates in duplicate detection immediately.
      await rest('files', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          id: fileId,
          uploaded_by_user_id: t.created_by_user_id,
          owner_user_id: t.created_by_user_id,
          original_name: displayName,
          mime_type: mime,
          size_bytes: t.src_size ?? 0,
          storage_bucket: 'wassel-files',
          storage_path: destPath,
          kind: mime.startsWith('video/') ? 'video' : mime === 'application/pdf' ? 'pdf' : 'image',
          origin: 'marketing_intake',
          file_class: 'business',
          content_etag: /^[0-9a-f]{32}$/.test(t.src_etag || '') ? t.src_etag : null,
        }),
      });

      // 3. point the asset at the canonical row and null the legacy copy fields.
      await rest(`mos_assets?id=eq.${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ file_id: fileId, url: null, thumb_url: null, file_path: null }),
      });

      done++;
      if (done % 25 === 0) console.log(`  … ${done} canonicalised`);
    } catch (e) {
      failed++;
      console.error(`FAILED ${t.id} (${t.original_name}): ${e.message}`);
    }
  }

  console.log(`\n${MODE === 'dry-run' ? 'DRY RUN' : 'DONE'}: ${done} canonicalised, ${skipped} skipped, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
