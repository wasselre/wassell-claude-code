#!/usr/bin/env node
// ============================================================================
// transcribe-developer-videos.mjs — Arabic transcripts for EVERY video file
// linked to one developer's projects and units (first used for الرمز, whose
// broker portal shows transcripts).
//
//   node scripts/transcribe-developer-videos.mjs --developer <records.id> --dry-run
//   node scripts/transcribe-developer-videos.mjs --developer <records.id> --confirm [--max-usd 3] [--concurrency 3] [--force]
//   node scripts/transcribe-developer-videos.mjs --all --missing-only --dry-run   (every active video file with no transcript text)
//
// Where each result goes:
//   • the video came from the collection lane (mkt_content_media.file_id) →
//     its ONE mkt_transcripts row is overwritten in place (model fal-ai/wizper;
//     the replaced text is kept in raw._replaced). One transcript per media is
//     the invariant every reader relies on — a media whose only row has another
//     model key is updated BY ID rather than given a second row.
//   • our own uploaded video (no content media) → public.file_transcripts.
//
// Language is FORCED to Arabic: fal-ai/wizper defaults to English when the key
// is omitted and then TRANSLATES Saudi speech (the bug scripts/retranscribe-
// arabic.mjs repairs). Music-only reels come back as Whisper filler ("Thank you",
// «اشتركوا في القناة») and are stored as language 'none', empty text.
//
// Skips a video that already has an Arabic transcript produced with
// language 'ar' requested (unless --force). Every fal call is metered in
// ai_usage (area files, call_site scripts/transcribe-developer-videos); a
// failed call is recorded too and leaves the old row untouched.
//
// ENV: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .env) and FAL_KEY
//      (`vercel env pull <scratch file>` and export it — never commit it).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIdentifiedClient } from './_lib/serviceClient.mjs';
import { recordAiUsage } from './lib/aiUsage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const MODEL = 'fal-ai/wizper';
const USD_PER_MIN = 0.01; // fal list price; the API returns no billing data
const CALL_SITE = 'scripts/transcribe-developer-videos';

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
const FAL_KEY = process.env.FAL_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(2); }
const sb = makeIdentifiedClient('script:transcribe-developer-videos', SUPABASE_URL, SERVICE_KEY);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

// ── fal queue REST (same shape as retranscribe-arabic.mjs) ───────────────────
async function falRun(body, durationMs, fileId) {
  const t0 = Date.now();
  const track = { area: 'files', callSite: CALL_SITE, operation: 'transcribe', provider: 'fal', model: MODEL, unitKind: 'minute', entityKind: 'file', entityId: fileId };
  try {
    const submit = await fetch(`https://queue.fal.run/${MODEL}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Key ${FAL_KEY}` }, body: JSON.stringify(body),
    });
    if (!submit.ok) throw new Error(`submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
    const s = await submit.json();
    if (!s.status_url || !s.response_url) throw new Error('missing status/response url');
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const st = await fetch(s.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
      if (!st.ok) throw new Error(`poll ${st.status}`);
      const status = (await st.json()).status?.toUpperCase();
      if (status === 'FAILED' || status === 'ERROR') throw new Error('fal job failed');
      if (status !== 'COMPLETED') continue;
      const rr = await fetch(s.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
      if (!rr.ok) throw new Error(`result ${rr.status}: ${(await rr.text()).slice(0, 300)}`);
      const json = await rr.json();
      await recordAiUsage({ ...track, status: 'ok', units: (durationMs ?? 0) / 60000, latencyMs: Date.now() - t0, meta: { requested_language: body.language, run_kind: 'operator_script' } });
      return json;
    }
    throw new Error('poll timed out');
  } catch (e) {
    await recordAiUsage({ ...track, status: 'error', error: e.message, units: 0, latencyMs: Date.now() - t0, meta: { requested_language: body.language, run_kind: 'operator_script' } });
    throw e;
  }
}

// ── text clean-up (mirrors retranscribe-arabic.mjs / worker falTranscribe) ───
function segmentsOf(chunks) {
  let prevEnd = 0; const out = [];
  for (const c of chunks ?? []) {
    const text = (c.text ?? '').trim();
    const start_ms = typeof c.timestamp?.[0] === 'number' ? Math.round(c.timestamp[0] * 1000) : prevEnd;
    const end_ms = typeof c.timestamp?.[1] === 'number' ? Math.round(c.timestamp[1] * 1000) : start_ms;
    prevEnd = Math.max(prevEnd, end_ms);
    if (text) out.push({ start_ms, end_ms, text });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}
const MAX_REPEAT = 3;
function collapseRepeats(text) {
  const chars = text.replace(/(.)\1{6,}/gu, '$1$1$1');
  const words = chars.split(/\s+/).filter(Boolean);
  const out = []; let looped = chars !== text; let i = 0;
  while (i < words.length) {
    let skip = 0;
    for (let n = 1; n <= 12 && i + n * (MAX_REPEAT + 1) <= words.length; n++) {
      let k = 1;
      while (i + (k + 1) * n <= words.length && words.slice(i + k * n, i + (k + 1) * n).every((w, x) => w === words[i + x])) k++;
      if (k > MAX_REPEAT) { out.push(...words.slice(i, i + n)); skip = k * n; break; }
    }
    if (skip) { i += skip; looped = true; } else { out.push(words[i]); i++; }
  }
  return looped ? out.join(' ') : text;
}
const HALLUCINATIONS = new Set(['you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!', 'bye', 'bye.', '.', '..', '...', 'subscribe', 'the end']);
const AR_HALLUCINATION_PHRASES = ['اشتركوا في القناة', 'اشترك في القناة', 'شكرا لكم على المشاهدة', 'شكرا للمشاهدة', 'ترجمة نانسي قنقر', 'موسيقى', 'شكرا'];
function isMeaningless(text) {
  const t = text.trim().toLowerCase().replace(/\*[^*]*\*|\[[^\]]*\]/g, ' ').replace(/[!.?،♪♫♩♬\s]+/g, ' ').trim();
  if (t.length < 3 || HALLUCINATIONS.has(t) || HALLUCINATIONS.has(text.trim().toLowerCase())) return true;
  const filler = t.replace(/[,\-]/g, ' ').replace(/\b(thank you|thanks|so|you|amen|oh|hmm|wow|music|outro|bye)\b/g, ' ');
  if (filler.replace(/\s+/g, ' ').trim().length < 3) return true;
  let rest = t;
  for (const p of AR_HALLUCINATION_PHRASES) rest = rest.split(p).join(' ');
  return rest.replace(/\s+/g, ' ').trim().length < 3;
}
function detectLanguage(text) {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en === 0) return null;
  if (ar > 0 && en > 0 && Math.min(ar, en) / Math.max(ar, en) > 0.12) return 'mixed';
  return ar >= en ? 'ar' : 'en';
}

// ── scope: every video linked to the developer's projects + units ────────────
async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function inChunks(ids, size, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

/** Video files in scope: one developer's projects + units, or (developerId
 *  null = --all) every active video file in the CRM. */
async function scopedVideoFiles(developerId) {
  const cols = 'id,original_name,kind,status,archived_at,storage_bucket,storage_path,duration_seconds';
  if (!developerId) {
    return pageAll((a, b) => sb.from('files').select(cols).eq('kind', 'video').eq('status', 'active').is('archived_at', null).order('id').range(a, b));
  }
  const { data: models, error } = await sb.from('models').select('id,name').in('name', ['all_projects', 'units']);
  if (error) throw new Error(error.message);
  const ap = models.find((m) => m.name === 'all_projects').id;
  const un = models.find((m) => m.name === 'units').id;
  const projects = await pageAll((a, b) => sb.from('records').select('id').eq('model_id', ap).eq('data->>developer', developerId).order('id').range(a, b));
  const pids = projects.map((p) => p.id);
  const units = await inChunks(pids, 50, (chunk) => pageAll((a, b) => sb.from('records').select('id').eq('model_id', un).in('data->>project_id', chunk).order('id').range(a, b)));
  const recordIds = [...pids, ...units.map((u) => u.id)];
  const links = await inChunks(recordIds, 150, async (chunk) => {
    const { data, error: e } = await sb.from('file_links').select('file_id').in('record_id', chunk);
    if (e) throw new Error(e.message);
    return data;
  });
  const fileIds = [...new Set(links.map((l) => l.file_id))];
  const files = await inChunks(fileIds, 150, async (chunk) => {
    const { data, error: e } = await sb.from('files').select(cols).in('id', chunk);
    if (e) throw new Error(e.message);
    return data;
  });
  return files.filter((f) => f.kind === 'video' && f.status === 'active' && !f.archived_at);
}

async function loadVideos(developerId) {
  const videos = await scopedVideoFiles(developerId);
  const media = await inChunks(videos.map((v) => v.id), 150, async (chunk) => {
    const { data, error: e } = await sb.from('mkt_content_media').select('id,file_id,content_post_id,stored_url,checksum_sha256,download_status').in('file_id', chunk);
    if (e) throw new Error(e.message);
    return data;
  });
  const rows = await inChunks(media.map((m) => m.id), 150, async (chunk) => {
    const { data, error: e } = await sb.from('mkt_transcripts').select('id,content_media_id,model,language,text,raw_req:raw->_request,updated_at').in('content_media_id', chunk);
    if (e) throw new Error(e.message);
    return data;
  });
  const own = await inChunks(videos.map((v) => v.id), 150, async (chunk) => {
    const { data, error: e } = await sb.from('file_transcripts').select('file_id,language,text,raw_req:raw->_request').in('file_id', chunk);
    if (e) throw new Error(e.message);
    return data;
  });
  const mediaByFile = new Map(media.map((m) => [m.file_id, m]));
  const rowsByMedia = new Map();
  for (const r of rows) rowsByMedia.set(r.content_media_id, [...(rowsByMedia.get(r.content_media_id) ?? []), r]);
  const ownByFile = new Map(own.map((o) => [o.file_id, o]));
  return videos.map((v) => {
    const m = mediaByFile.get(v.id) ?? null;
    return { file: v, media: m, mediaRows: m ? rowsByMedia.get(m.id) ?? [] : [], own: ownByFile.get(v.id) ?? null };
  });
}

/** Nothing left to do: already transcribed with Arabic requested (not the
 *  legacy English run), or the collector recorded the video as having NO
 *  audio track (model 'none') — fal only answers 422 "failed to decode" there. */
function alreadyArabic(item) {
  const done = (r) => r && r.raw_req && typeof r.raw_req === 'object' && r.raw_req.language === 'ar';
  return item.mediaRows.some((r) => done(r) || r.model === 'none') || done(item.own);
}

async function audioUrl(item) {
  const m = item.media;
  if (m?.checksum_sha256) {
    const url = `${SUPABASE_URL}/storage/v1/object/public/marketing-assets/content/audio/${m.checksum_sha256}.m4a`;
    const h = await fetch(url, { method: 'HEAD' });
    if (h.ok) return { url, kind: 'audio' };
  }
  const { data, error } = await sb.storage.from(item.file.storage_bucket).createSignedUrl(item.file.storage_path, 60 * 60 * 2);
  if (error || !data?.signedUrl) throw new Error(`sign ${item.file.id}: ${error?.message ?? 'no url'}`);
  return { url: data.signedUrl, kind: 'file' };
}

async function write(item, result, raw) {
  const durationMs = Math.round((item.file.duration_seconds ?? 0) * 1000) || null;
  if (item.media) {
    const main = item.mediaRows.find((r) => r.model === MODEL) ?? item.mediaRows[0] ?? null;
    const replaced = main ? { model: main.model, language: main.language, text: main.text, updated_at: main.updated_at, request: main.raw_req ?? null, replaced_at: new Date().toISOString() } : null;
    const fullRaw = { ...raw, _replaced: replaced };
    if (main && main.model !== MODEL) {
      // Keep ONE row per media: convert the existing row instead of adding a second.
      const { error } = await sb.from('mkt_transcripts').update({
        provider: 'fal', model: MODEL, language: result.language, text: result.text, segments: result.segments,
        duration_ms: durationMs, cost_usd: result.costUsd, status: 'done', failure_reason: null, raw: fullRaw, updated_at: new Date().toISOString(),
      }).eq('id', main.id);
      if (error) throw new Error(`update transcript ${main.id}: ${error.message}`);
      return 'mkt_transcripts (converted row)';
    }
    const { error } = await sb.rpc('mkt_transcript_upsert', {
      p_media: item.media.id, p_post: item.media.content_post_id, p_provider: 'fal', p_model: MODEL,
      p_language: result.language, p_text: result.text, p_segments: result.segments, p_duration_ms: durationMs,
      p_confidence: null, p_cost: result.costUsd, p_status: 'done', p_failure: null,
      p_source_checksum: item.media.checksum_sha256 ?? null, p_raw: fullRaw,
    });
    if (error) throw new Error(`mkt_transcript_upsert: ${error.message}`);
    return 'mkt_transcripts';
  }
  const { error } = await sb.from('file_transcripts').upsert({
    file_id: item.file.id, provider: 'fal', model: MODEL, language: result.language, text: result.text,
    segments: result.segments, duration_ms: durationMs, cost_usd: result.costUsd, status: 'done', raw, updated_at: new Date().toISOString(),
  }, { onConflict: 'file_id' });
  if (error) throw new Error(`file_transcripts upsert: ${error.message}`);
  return 'file_transcripts';
}

async function main() {
  const all = flag('all');
  const developerId = all ? null : opt('developer', '');
  if (!all && !/^[0-9a-f-]{36}$/i.test(developerId)) { console.error('--developer <records.id> (or --all) is required'); process.exit(2); }
  const dry = flag('dry-run');
  if (!dry && !flag('confirm')) { console.error('Refusing to run without --confirm. Use --dry-run to preview.'); process.exit(2); }
  if (!dry && !FAL_KEY) { console.error('FAL_KEY is required (vercel env pull → export)'); process.exit(2); }
  const maxUsd = Number(opt('max-usd', 3));
  const conc = Math.max(1, Math.min(4, Number(opt('concurrency', 3))));

  const items = await loadVideos(developerId);
  // --missing-only: leave any video that already has readable transcript text
  // alone (even a legacy auto-detect one) — fill gaps, don't redo good rows.
  const hasText = (i) => [...i.mediaRows, i.own].some((r) => r && typeof r.text === 'string' && r.text.trim() !== '');
  const todo = (flag('force') ? items : items.filter((i) => !alreadyArabic(i)))
    .filter((i) => !flag('missing-only') || !hasText(i));
  const minutes = (xs) => xs.reduce((a, i) => a + (i.file.duration_seconds ?? 0), 0) / 60;
  console.log(`[videos] ${items.length} linked video files; ${items.length - todo.length} already done (Arabic transcript, or no audio track) — skipped`);
  console.log(`[videos] to transcribe: ${todo.length} — ${todo.filter((i) => i.media).length} collected reels, ${todo.filter((i) => !i.media).length} own uploads`);
  console.log(`[videos] ${minutes(todo).toFixed(1)} audio-min ≈ $${(minutes(todo) * USD_PER_MIN).toFixed(2)} (cap --max-usd ${maxUsd})`);
  if (dry) { console.log('[videos] DRY RUN — nothing called, nothing written.'); return; }

  let spent = 0; let ok = 0; let fail = 0; let stopped = false;
  const langs = {};
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < todo.length && !stopped) {
      const item = todo[next++];
      const est = ((item.file.duration_seconds ?? 0) / 60) * USD_PER_MIN;
      if (spent + est > maxUsd) { stopped = true; console.log(`[videos] --max-usd ${maxUsd} reached — stopping; re-run to continue`); break; }
      spent += est;
      try {
        const src = await audioUrl(item);
        const params = { task: 'transcribe', language: 'ar', chunk_level: 'segment', version: '3' };
        const durationMs = Math.round((item.file.duration_seconds ?? 0) * 1000) || null;
        const json = await falRun({ audio_url: src.url, ...params }, durationMs, item.file.id);
        const segments = segmentsOf(json.chunks).map((s) => ({ ...s, text: collapseRepeats(s.text) }));
        const text = collapseRepeats((json.text ?? '').trim());
        const noSpeech = isMeaningless(text);
        const result = {
          text: noSpeech ? '' : text,
          segments: noSpeech ? [] : segments,
          language: noSpeech ? 'none' : detectLanguage(text),
          costUsd: Math.round(est * 10000) / 10000,
        };
        const where = await write(item, result, { ...json, _request: params, _source: { kind: src.kind } });
        ok++; langs[result.language ?? 'null'] = (langs[result.language ?? 'null'] ?? 0) + 1;
        console.log(`[videos] ok ${item.file.id} ${result.language} chars=${result.text.length} → ${where} | ${item.file.original_name}`);
      } catch (e) {
        fail++;
        console.error(`[videos] FAIL ${item.file.id} (${item.file.original_name}): ${e.message} — nothing written for it`);
      }
    }
  }));
  console.log(`[videos] done: ${ok} ok ${JSON.stringify(langs)}, ${fail} failed, ≈ $${spent.toFixed(3)} (metered in ai_usage)`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
