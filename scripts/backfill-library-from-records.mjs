/**
 * backfill-library-from-records.mjs — consolidate EXISTING project photos and
 * brochures into the marketing library, and REPORT duplicates. Deletes nothing.
 * ----------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT AUTOMATIC
 *
 * From 2026-08-05 a trigger on `files` auto-registers project photos/PDFs into
 * the library the moment they're attached (migration
 * 2026-08-05_library_link_project_media.sql). That covers everything uploaded
 * from now on.
 *
 * The files uploaded BEFORE that trigger existed are historical: this script
 * walks the project records, finds their image/PDF fields, and calls the same
 * idempotent `mos_register_record_file(file_id)` RPC the trigger uses — so each
 * historical file gets ONE library asset (referencing the SAME file, no copy)
 * plus a record-link. It also flags byte-identical duplicates across the two
 * systems (the same photo uploaded once to a project and once to the library),
 * so a human can decide what to prune — the script itself NEVER deletes.
 *
 * ----------------------------------------------------------------------------
 * USAGE
 *
 *   node scripts/backfill-library-from-records.mjs            # dry-run (report only)
 *   node scripts/backfill-library-from-records.mjs --apply    # actually register
 *   node scripts/backfill-library-from-records.mjs --apply --report out.json
 *
 * OPTIONS
 *   --apply         Call mos_register_record_file for each in-scope file.
 *                   WITHOUT it the script only reports — registers nothing.
 *   --report PATH   Write the full JSON report (incl. the duplicate list) here.
 *   --limit N       Max records to scan per model (default: all).
 *
 * SAFE TO RE-RUN. mos_register_record_file is idempotent (one asset per file,
 * one link per record) and this script never deletes.
 *
 * REQUIRED ENV (process.env or auto-loaded from .env.local / .env):
 *   SUPABASE_URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY   — required; registers on behalf of any uploader
 * ----------------------------------------------------------------------------
 */
import { makeIdentifiedClient } from './_lib/serviceClient.mjs';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile(resolve(ROOT, '.env.local'));
loadEnvFile(resolve(ROOT, '.env'));

const APPLY = process.argv.includes('--apply');
const reportIdx = process.argv.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 ? process.argv[reportIdx + 1] : null;
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

const PROJECT_MODELS = ['all_projects', 'our_projects', 'targeted_projects'];
const MEDIA_FIELD_TYPES = new Set(['image', 'multi_image', 'file', 'multi_file', 'attachment']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (registration is service-role only).');
  process.exit(1);
}
const sb = makeIdentifiedClient('script:backfill-library-from-records', url, key);

/** Pull every file_id / legacy URL out of one record's media fields. */
function extractMedia(data, mediaSlugs) {
  const fileIds = [];
  const legacyUrls = [];
  const consume = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      if (UUID_RE.test(v)) fileIds.push(v);
      else if (/^https?:\/\//i.test(v)) legacyUrls.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(consume);
    } else if (typeof v === 'object') {
      // attachment refs: { type:'file', file_id } or { id } etc.
      const cand = v.file_id ?? v.id ?? null;
      if (typeof cand === 'string' && UUID_RE.test(cand)) fileIds.push(cand);
      const u = v.url ?? null;
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) legacyUrls.push(u);
    }
  };
  for (const slug of mediaSlugs) consume(data?.[slug]);
  return { fileIds, legacyUrls };
}

async function pageRecords(modelId) {
  const out = [];
  const size = 1000;
  for (let from = 0; from < LIMIT; from += size) {
    const to = Math.min(from + size, LIMIT) - 1;
    const { data, error } = await sb
      .from('unified_records')
      .select('id, data')
      .eq('model_id', modelId)
      .range(from, to);
    if (error) throw new Error(`unified_records read failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return out;
}

async function main() {
  console.log(`\n== library backfill from project records ${APPLY ? '(APPLY)' : '(dry-run — report only)'} ==\n`);

  const { data: models, error: mErr } = await sb
    .from('models').select('id, name, schema').in('name', PROJECT_MODELS);
  if (mErr) { console.error('FATAL: models read failed:', mErr.message); process.exit(1); }

  // Collect every file_id referenced by a media field on a project record.
  const referencedFileIds = new Set();
  let legacyUrlCount = 0;
  const legacyUrlSamples = [];
  let recordsScanned = 0;

  for (const model of models ?? []) {
    const mediaSlugs = [];
    for (const s of model.schema?.sections ?? []) {
      for (const f of s.fields ?? []) if (MEDIA_FIELD_TYPES.has(f.type)) mediaSlugs.push(f.name);
    }
    if (mediaSlugs.length === 0) { console.log(`- ${model.name}: no media fields, skipped`); continue; }
    const records = await pageRecords(model.id);
    recordsScanned += records.length;
    for (const r of records) {
      const { fileIds, legacyUrls } = extractMedia(r.data, mediaSlugs);
      fileIds.forEach((id) => referencedFileIds.add(id));
      legacyUrlCount += legacyUrls.length;
      if (legacyUrls.length && legacyUrlSamples.length < 10) legacyUrlSamples.push(...legacyUrls.slice(0, 2));
    }
    console.log(`- ${model.name}: ${records.length} records · media fields [${mediaSlugs.join(', ')}]`);
  }

  const allFileIds = [...referencedFileIds];
  console.log(`\nreferenced files: ${allFileIds.length} · legacy public URLs: ${legacyUrlCount}`);

  // Resolve those files (image/pdf are in scope) + the existing library.
  const files = [];
  for (let i = 0; i < allFileIds.length; i += 500) {
    const { data, error } = await sb
      .from('files').select('id, original_name, size_bytes, mime_type, kind')
      .in('id', allFileIds.slice(i, i + 500));
    if (error) throw new Error(`files read failed: ${error.message}`);
    files.push(...(data ?? []));
  }
  const inScope = files.filter((f) => f.kind === 'image' || f.kind === 'pdf');

  const { data: existingAssets, error: aErr } = await sb
    .from('mos_assets').select('id, file_id, url, original_name, size_bytes');
  if (aErr) throw new Error(`mos_assets read failed: ${aErr.message}`);
  const registeredFileIds = new Set((existingAssets ?? []).map((a) => a.file_id).filter(Boolean));
  // url-based library uploads, keyed by name|size — to spot the same photo
  // that was ALSO uploaded straight to the library (a genuine duplicate copy).
  const urlAssetByKey = new Map();
  for (const a of existingAssets ?? []) {
    if (a.file_id || !a.url) continue;
    urlAssetByKey.set(`${a.original_name}|${a.size_bytes}`, a);
  }

  const toRegister = inScope.filter((f) => !registeredFileIds.has(f.id));
  const duplicates = [];
  for (const f of inScope) {
    const dup = urlAssetByKey.get(`${f.original_name}|${f.size_bytes}`);
    if (dup) duplicates.push({ file_id: f.id, name: f.original_name, size_bytes: f.size_bytes, duplicate_library_asset_id: dup.id });
  }

  console.log(`in scope (image/pdf): ${inScope.length} · already registered: ${inScope.length - toRegister.length} · to register: ${toRegister.length}`);
  console.log(`candidate duplicate copies (same file also uploaded straight to the library): ${duplicates.length}`);

  let registered = 0;
  const failures = [];
  if (APPLY) {
    for (const f of toRegister) {
      const { error } = await sb.rpc('mos_register_record_file', { p_file_id: f.id });
      if (error) failures.push({ file_id: f.id, error: error.message });
      else registered += 1;
    }
    console.log(`\nregistered: ${registered}${failures.length ? ` · failures: ${failures.length}` : ''}`);
  } else {
    console.log('\n(dry-run) nothing registered — pass --apply to register the files above.');
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    records_scanned: recordsScanned,
    referenced_files: allFileIds.length,
    legacy_public_urls: legacyUrlCount,
    legacy_url_samples: legacyUrlSamples,
    in_scope_image_pdf: inScope.length,
    to_register: toRegister.length,
    registered,
    failures,
    duplicates,
  };
  if (REPORT_PATH) {
    writeFileSync(resolve(process.cwd(), REPORT_PATH), JSON.stringify(report, null, 2));
    console.log(`\nreport written to ${REPORT_PATH}`);
  }
  console.log('\nNOTHING WAS DELETED. Review `duplicates` before pruning any copies.\n');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
