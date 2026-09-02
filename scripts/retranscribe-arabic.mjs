#!/usr/bin/env node
// ============================================================================
// retranscribe-arabic.mjs — Arabic re-transcription of competitor videos.
//
// WHY: fal-ai/wizper's `language` parameter DEFAULTS to "en" when omitted (it is
// NOT auto-detect — measured 2026-09-02 against the live schema + a probe). The
// v1 worker omitted it, so ~500 stored transcripts are English translations of
// Saudi Arabic speech. This script re-runs Whisper with `language: 'ar'`.
//
// MODES
//   --ab [--n 10] [--store-word] [--no-store]
//       Pick N stored videos with an existing done transcript that cover the
//       categories below, run variant B (fal-ai/whisper, language ar,
//       chunk_level word — wizper 422s on 'word') and B2 (fal-ai/wizper,
//       language ar, chunk_level segment), compute metrics against A (the
//       stored English row), store B2 under model key 'fal-ai/wizper@ar' via
//       mkt_transcript_upsert (UNIQUE (content_media_id, model) keeps A), and
//       write docs/eval/asr-ab/{report.md,human-review.md,results.json}.
//       --store-word additionally stores B under 'fal-ai/whisper@ar-word'.
//   --backfill --limit N [--dry-run] [--concurrency 3] --confirm
//       Every stored video whose wizper transcript has speech (text non-empty)
//       and has no '@ar' row yet → wizper ar segment → '@ar' row. Resumable
//       (skips existing rows), logs cost, refuses to run without --confirm.
//
// ENV: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from .env.local / .env) and
//      FAL_KEY (process.env, or .env.local — it is NOT committed anywhere on
//      disk today; `vercel env pull <scratch>` and export it before running).
//
// No worker TS is imported: the fal queue REST + the metrics live here.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'docs', 'eval', 'asr-ab');

const MODEL_A = 'fal-ai/wizper';
const MODEL_AR = 'fal-ai/wizper@ar';         // stored key for the Arabic backfill
const MODEL_WORD = 'fal-ai/whisper@ar-word';  // stored key for the word-level A/B variant (opt-in)
const USD_PER_MIN = 0.01;                     // fal list price; the API returns no billing data
const BUCKET_BASE = 'marketing-assets';

// ── env ─────────────────────────────────────────────────────────────────────
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
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required (.env.local)'); process.exit(2); }
if (!FAL_KEY) { console.error('FAL_KEY is required. It is not stored on disk in this repo — pull it from Vercel (`vercel env pull <scratch>`) or Fly and export it.'); process.exit(2); }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

// ── fal queue REST ──────────────────────────────────────────────────────────
async function falRun(model, body, { timeoutMs = 300_000 } = {}) {
  const t0 = Date.now();
  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Key ${FAL_KEY}` }, body: JSON.stringify(body),
  });
  if (!submit.ok) throw new Error(`${model} submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const s = await submit.json();
  if (!s.status_url || !s.response_url) throw new Error(`${model} missing status/response url`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await fetch(s.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    if (!st.ok) throw new Error(`${model} poll ${st.status}`);
    const status = (await st.json()).status?.toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') throw new Error(`${model} failed`);
    if (status !== 'COMPLETED') continue;
    const rr = await fetch(s.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    if (!rr.ok) throw new Error(`${model} result ${rr.status}: ${(await rr.text()).slice(0, 300)}`);
    return { json: await rr.json(), ms: Date.now() - t0 };
  }
  throw new Error(`${model} poll timed out`);
}

// Same normalization the worker's falTranscribe.ts applies (ordered segments,
// word aggregation ~5–8 s). Duplicated on purpose: this script must not import
// worker TS.
function chunksToSegments(chunks) {
  let prevEnd = 0; const raw = [];
  for (const c of chunks ?? []) {
    const text = (c.text ?? '').trim();
    const start_ms = typeof c.timestamp?.[0] === 'number' ? Math.round(c.timestamp[0] * 1000) : prevEnd;
    const end_ms = typeof c.timestamp?.[1] === 'number' ? Math.round(c.timestamp[1] * 1000) : start_ms;
    prevEnd = Math.max(prevEnd, end_ms);
    if (text) raw.push({ start_ms, end_ms, text });
  }
  const segments = raw.map((s, i) => ({ s, i })).sort((a, b) => (a.s.start_ms - b.s.start_ms) || (a.i - b.i)).map((x) => x.s);
  return { segments, reordered: segments.some((s, i) => s !== raw[i]) };
}
function aggregateWords(words, MIN = 5000, MAX = 8000, PAUSE = 700) {
  const out = []; let cur = null;
  for (const w of words) {
    if (cur) {
      const span = w.end_ms - cur.start_ms, gap = w.start_ms - cur.end_ms, longEnough = cur.end_ms - cur.start_ms >= MIN;
      if (span > MAX || (longEnough && (gap >= PAUSE || /[.!?؟،]$/.test(cur.text)))) { out.push(cur); cur = null; }
    }
    if (!cur) { cur = { ...w }; continue; }
    cur.text += ' ' + w.text; cur.end_ms = Math.max(cur.end_ms, w.end_ms);
  }
  if (cur) out.push(cur);
  return out;
}
function normalizeFal(j, durationMs, level) {
  const { segments: ordered, reordered } = chunksToSegments(j.chunks);
  const segments = level === 'word' ? aggregateWords(ordered) : ordered;
  const rawText = (j.text ?? '').trim();
  const text = reordered && segments.length ? segments.map((s) => s.text).join(' ') : rawText;
  const lastEnd = ordered.reduce((m, s) => Math.max(m, s.end_ms), 0);
  const billedMs = durationMs || lastEnd;
  return { text, segments, reordered, languages: j.languages ?? null, costUsd: Math.round((billedMs / 60000) * USD_PER_MIN * 10000) / 10000, lastEndMs: lastEnd };
}

// ── Arabic-aware text metrics ───────────────────────────────────────────────
const AR_RE = /[؀-ۿ]/g;
export function normAr(s) {
  return (s ?? '').normalize('NFKC')
    .replace(/[ً-ْٰـ]/g, '')          // harakat, tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0))
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const stripAl = (t) => t.replace(/^(و|ف|ب|ل|ك)?(ال)/, '');
function tokens(s) { return normAr(s).split(' ').filter(Boolean); }
/**
 * A name is "present" when every significant token (≥3 chars after stripping
 * ال) of at least ONE of its alternatives occurs in the transcript. Alternatives
 * are the parts split on ( ) / | — e.g. «دروازة (Derwaza)» matches on either
 * script. Returns null when the name has no significant token to test.
 */
function namePresent(name, transcriptNorm, transcriptTokens) {
  const alts = name.split(/[()\/|]/).map((a) => tokens(a).map(stripAl).filter((t) => t.length >= 3)).filter((a) => a.length);
  if (!alts.length) return null;
  return alts.some((sig) => sig.every((t) => transcriptTokens.has(t) || transcriptNorm.includes(t)));
}
function arabicRatio(text) {
  const ar = (text.match(AR_RE) ?? []).length, la = (text.match(/[A-Za-z]/g) ?? []).length;
  return ar + la === 0 ? 0 : ar / (ar + la);
}
const unifyDigits = (s) => (s ?? '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0));

// ── Arabic spoken numbers ───────────────────────────────────────────────────
// Whisper writes Saudi prices as WORDS («مليونين وخمسمية وتسعين» = 2,590,000,
// «919 ألف» = 919,000) while enrichment/captions carry digits. A digit-only
// comparison therefore under-counts the Arabic variant for a reason that has
// nothing to do with ASR accuracy. This parser expands number phrases to
// digits; the colloquial "implied ألف" (a <1000 group spoken after مليون with
// no multiplier of its own) is applied when the total is already ≥ 1,000,000.
const NUM_WORDS = new Map(Object.entries({
  صفر: 0, واحد: 1, وحده: 1, اثنين: 2, اثنان: 2, ثنين: 2, ثلاثه: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, ثمانيه: 8, ثمان: 8, ثمن: 8, تسعه: 9, تسع: 9,
  عشره: 10, عشر: 10, احدعش: 11, احدعشر: 11, اثنعش: 12, اثناعشر: 12, ثلاثتعش: 13, ثلاثةعشر: 13, اربعتعش: 14, خمستعش: 15, ستعش: 16, سبعتعش: 17, ثمنتعش: 18, تسعتعش: 19,
  عشرين: 20, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تسعين: 90,
  ميه: 100, مائه: 100, مية: 100, ميتين: 200, مائتين: 200, ميتان: 200, ثلاثميه: 300, ثلاثمائه: 300, اربعميه: 400, اربعمائه: 400, خمسميه: 500, خمسمائه: 500, ستميه: 600, ستمائه: 600, سبعميه: 700, سبعمائه: 700, ثمنميه: 800, ثمانميه: 800, ثمانمائه: 800, تسعميه: 900, تسعمائه: 900,
}));
const MULT = new Map(Object.entries({ الف: 1e3, الفين: 2e3, الاف: 1e3, ألف: 1e3, مليون: 1e6, مليونين: 2e6, ملايين: 1e6, مليار: 1e9 }));
const DUAL_MULT = new Set(['الفين', 'مليونين']);
/** Collapse thousands separators («1,289,000» / «1.282.000» → 1289000) but keep true decimals («1.5»). */
const collapseThousands = (s) => unifyDigits(s).replace(/\d{1,3}(?:[.,]\d{3})+(?![\d])/g, (m) => m.replace(/[.,]/g, ''));
/** Tokenizer for number phrases: letters normalized like normAr, but numeric tokens keep their decimal point. */
function numTokens(text) {
  return collapseThousands(text).normalize('NFKC')
    .replace(/[ً-ْٰـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1 $2')           // protect decimal points inside numbers
    .replace(/[^\p{L}\p{N}\s ]/gu, ' ').replace(/ /g, '.')
    .split(/\s+/).filter(Boolean);
}
export function spokenNumbers(text) {
  const out = new Set();
  const toks = numTokens(text).map((t) => (/^\d/.test(t) ? t : t.replace(/^و/, ''))); // «وخمسمية» → «خمسمية»
  let total = 0, group = 0, active = false, sawMillion = false;
  const flush = () => { if (active) { const v = total + group; if (v >= 10) out.add(String(v)); } total = 0; group = 0; active = false; sawMillion = false; };
  for (const t of toks) {
    if (/^\d+(?:\.\d+)?$/.test(t)) { if (active && group) flush(); group = Number(t); active = true; continue; }
    if (NUM_WORDS.has(t)) { group += NUM_WORDS.get(t); active = true; continue; }
    if (MULT.has(t)) {
      const m = MULT.get(t);
      const base = DUAL_MULT.has(t) ? 1 : (group || 1);
      total += base * m; group = 0; active = true; sawMillion = sawMillion || m >= 1e6; continue;
    }
    if (active) {
      if (sawMillion && group > 0 && group < 1000) group *= 1e3; // implied ألف after مليون
      flush();
    }
  }
  if (active) { if (sawMillion && group > 0 && group < 1000) group *= 1e3; flush(); }
  return out;
}
/** Numbers as written (1,060,000 / 1.060.000 → 1060000) — extracted BEFORE punctuation stripping — plus spoken Arabic number phrases. */
function numbersIn(s) {
  const u = collapseThousands(s);
  const digits = (u.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.length >= 2);
  return new Set([...digits, ...spokenNumbers(u)]);
}
/** Levenshtein ≤ 1 on tokens ≥ 4 chars — tolerates one ASR slip in a proper name («فستا»/«فستة», «سواري»/«سواهري»). */
function near(a, b) {
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++edits > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function namePresentFuzzy(name, transcriptTokens) {
  const alts = name.split(/[()\/|]/).map((a) => tokens(a).map(stripAl).filter((t) => t.length >= 3)).filter((a) => a.length);
  if (!alts.length) return null;
  const tt = [...transcriptTokens];
  return alts.some((sig) => sig.every((t) => tt.some((x) => near(t, x))));
}
/** Split a free-text location/district into short candidate names (≤4 tokens each). */
function shortParts(v) {
  return String(v ?? '').split(/[،,\-–\n|]+/).map((p) => p.trim()).filter((p) => p.length >= 3 && tokens(p).length <= 4);
}
const GREETING = /(بسم الله|يا متابعين|السلام عليكم|حياكم|اهلا|هلا|مرحبا|صباح الخير|مساء الخير|مساكم|اسعد الله|كل عام و?انتم بخير|in the name of god|dear followers|peace be upon|hello|welcome|good (morning|evening)|may god bless|god bless)/i;
function greetingPosition(text) {
  const n = normAr(text); const m = n.match(GREETING);
  if (!m || !n.length) return null;
  return m.index / n.length;
}
function median(xs) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }

/** Expected proper names / numbers for a video, from enrichment + linked records + caption. */
async function expectedFacts(row) {
  const e = row.mkt_content_posts?.mkt_content_enrichment; const res = (Array.isArray(e) ? e[0] : e)?.result ?? {};
  const enr = Array.isArray(e) ? e[0] : e;
  const names = new Map(); // name → source
  const add = (v, src) => { for (const x of (Array.isArray(v) ? v : [v])) { const s = String(x ?? '').trim(); if (s.length >= 3) names.set(s, src); } };
  if (enr?.primary_project_id) {
    const { data } = await sb.from('records').select('data').eq('id', enr.primary_project_id).maybeSingle();
    add(data?.data?.project_name, 'project'); add(data?.data?.project_name_en, 'project');
  }
  const orgId = row.mkt_content_posts?.organization_id;
  if (orgId) {
    const { data: org } = await sb.from('mkt_organizations').select('name_ar,name_en,developer_record_id').eq('id', orgId).maybeSingle();
    add(org?.name_ar, 'organization'); add(org?.name_en, 'organization');
    if (org?.developer_record_id) {
      const { data: dev } = await sb.from('records').select('data').eq('id', org.developer_record_id).maybeSingle();
      add(dev?.data?.name, 'developer');
    }
  }
  add(shortParts(res.district), 'district'); add(shortParts(res.location), 'location');
  const caption = row.mkt_content_posts?.caption ?? '';
  // «مشروع X [Y]» / «حي X» on ONE line only — never span a line break.
  for (const m of caption.matchAll(/(?:مشروع|حي|شركة|مدينة|مخطط|كمبوند|project|district)[ \t]+([^\s،,.!؟:\n#]+(?:[ \t]+[^\s،,.!؟:\n#]+)?)/gi)) add(m[1], 'caption');
  for (const m of caption.matchAll(/#([^\s#]+)/g)) add(m[1].replace(/_/g, ' '), 'hashtag');
  const numbers = new Set();
  for (const f of [res.price, res.payment_plan, res.offer, res.financing, ...(res.unit_types ?? []), ...(res.selling_points ?? [])]) for (const n of numbersIn(String(f ?? ''))) numbers.add(n);
  const captionNumbers = numbersIn(caption);
  const areaHint = /(م²|م2|متر|مساح|sqm|m2)/i.test(JSON.stringify(res)) || /(م²|م2|متر|مساح)/.test(caption);
  return { names: [...names.entries()].map(([name, source]) => ({ name, source })), numbers: [...numbers], captionNumbers: [...captionNumbers], areaHint, result: res };
}

function scoreTranscript(text, segments, durationMs, facts) {
  const n = normAr(text); const tk = new Set(tokens(text).flatMap((t) => [t, stripAl(t)]));
  const nameChecks = facts.names.map((f) => { const present = namePresent(f.name, n, tk); return { ...f, present, fuzzy: present || namePresentFuzzy(f.name, tk) }; }).filter((x) => x.present !== null);
  const nums = numbersIn(text);
  const numChecks = facts.numbers.map((x) => ({ number: x, present: nums.has(x) }));
  const lens = segments.map((s) => s.end_ms - s.start_ms);
  const lastEnd = segments.reduce((m, s) => Math.max(m, s.end_ms), 0);
  const g = greetingPosition(text);
  return {
    chars: text.length,
    arabic_ratio: +arabicRatio(text).toFixed(3),
    names_found: nameChecks.filter((x) => x.present).length, names_fuzzy: nameChecks.filter((x) => x.fuzzy).length, names_total: nameChecks.length, name_checks: nameChecks,
    numbers_found: numChecks.filter((x) => x.present).length, numbers_total: numChecks.length, number_checks: numChecks, numbers_in_transcript: [...nums].slice(0, 40),
    segment_count: segments.length, median_segment_ms: Math.round(median(lens)),
    greeting_pos: g === null ? null : +g.toFixed(3), greeting_in_first_15pct: g === null ? null : g <= 0.15,
    coverage: durationMs ? +Math.min(1, lastEnd / durationMs).toFixed(3) : null,
  };
}

// ── pool ────────────────────────────────────────────────────────────────────
const POOL_SELECT = 'id,content_media_id,content_post_id,model,language,text,duration_ms,segments,source_checksum,mkt_content_media(id,stored_url,checksum_sha256,duration_ms,download_status,media_kind),mkt_content_posts(id,caption,organization_id,post_url,platform,mkt_content_enrichment(result,primary_project_id,status))';
async function loadPool() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('mkt_transcripts').select(POOL_SELECT).eq('model', MODEL_A).eq('status', 'done').neq('text', '').range(from, from + 999);
    if (error) throw new Error(`pool load: ${error.message}`);
    rows.push(...data); if (data.length < 1000) break;
  }
  return rows.filter((r) => r.mkt_content_media?.download_status === 'stored' && r.mkt_content_media?.media_kind === 'video' && r.mkt_content_media?.stored_url);
}
async function existingArRows(mediaIds) {
  const have = new Set();
  for (let i = 0; i < mediaIds.length; i += 500) {
    const { data, error } = await sb.from('mkt_transcripts').select('content_media_id').eq('model', MODEL_AR).in('content_media_id', mediaIds.slice(i, i + 500));
    if (error) throw new Error(`existing @ar: ${error.message}`);
    for (const r of data) have.add(r.content_media_id);
  }
  return have;
}
async function audioUrlFor(row) {
  const m = row.mkt_content_media; const checksum = m.checksum_sha256 ?? row.source_checksum;
  if (checksum) {
    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_BASE}/content/audio/${checksum}.m4a`;
    const h = await fetch(url, { method: 'HEAD' });
    if (h.ok) return { url, kind: 'audio' };
  }
  return { url: m.stored_url, kind: 'video' };
}
async function upsertTranscript(row, modelKey, r, durationMs, raw) {
  const { error } = await sb.rpc('mkt_transcript_upsert', {
    p_media: row.content_media_id, p_post: row.content_post_id, p_provider: 'fal', p_model: modelKey,
    p_language: r.languages?.length > 1 ? 'mixed' : (r.languages?.[0] ?? (arabicRatio(r.text) > 0.5 ? 'ar' : 'en')),
    p_text: r.text, p_segments: r.segments, p_duration_ms: durationMs, p_confidence: null, p_cost: r.costUsd,
    p_status: 'done', p_failure: null, p_source_checksum: row.mkt_content_media?.checksum_sha256 ?? row.source_checksum, p_raw: raw,
  });
  if (error) throw new Error(`mkt_transcript_upsert(${modelKey}): ${error.message}`);
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ── A/B selection ───────────────────────────────────────────────────────────
function categorize(pool) {
  const cps = pool.map((r) => (r.duration_ms ? r.text.length / (r.duration_ms / 1000) : 0));
  const sorted = [...cps].filter(Boolean).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const fastCut = q(0.9), slowCut = q(0.15);
  return pool.map((r, i) => {
    const e = r.mkt_content_posts?.mkt_content_enrichment; const enr = Array.isArray(e) ? e[0] : e; const res = enr?.result ?? {};
    const blob = JSON.stringify(res);
    const cats = new Set();
    if (enr?.primary_project_id) cats.add('project_name');
    if (res.district) cats.add('district');
    if (res.price) cats.add('price');
    if (/(م²|م2|متر|مساح|sqm|m2)/i.test(blob)) cats.add('area');
    if (r.duration_ms >= 60_000) cats.add('walkthrough');
    if (cps[i] >= fastCut && r.duration_ms >= 10_000) cats.add('fast_speech');
    if (cps[i] > 0 && cps[i] <= slowCut && r.duration_ms >= 15_000) cats.add('music_noise');
    if ((r.segments ?? []).length >= 6) cats.add('multi_speaker');
    return { row: r, cats, cps: cps[i] };
  });
}
function pickAb(pool, n) {
  const scored = categorize(pool).filter((x) => x.row.duration_ms > 0 && x.row.duration_ms <= 300_000);
  const want = ['walkthrough', 'project_name', 'district', 'price', 'area', 'fast_speech', 'music_noise', 'multi_speaker'];
  const picked = []; const used = new Set(); const seenContent = new Set();
  // Cross-posted videos (same org, same length ±1 s on TikTok + Instagram) are one piece of content — sample it once.
  const contentKey = (x) => `${x.row.mkt_content_posts?.organization_id}|${Math.round(x.row.duration_ms / 1000)}`;
  const free = (x) => !used.has(x.row.id) && !seenContent.has(contentKey(x));
  const take = (x, why) => { picked.push({ ...x, why }); used.add(x.row.id); seenContent.add(contentKey(x)); };
  for (const c of want) {
    const best = scored.filter((x) => free(x) && x.cats.has(c)).sort((a, b) => b.cats.size - a.cats.size || (b.row.duration_ms - a.row.duration_ms))[0];
    if (best) take(best, c);
    if (picked.length >= n) break;
  }
  for (const x of scored.filter(free).sort((a, b) => b.cats.size - a.cats.size)) { if (picked.length >= n) break; if (free(x)) take(x, 'coverage'); }
  return picked;
}

// ── modes ───────────────────────────────────────────────────────────────────
async function runAb() {
  const n = Number(opt('n', 10)); const store = !flag('no-store'); const storeWord = flag('store-word');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pool = await loadPool();
  console.log(`[ab] pool: ${pool.length} stored videos with a done, non-empty ${MODEL_A} transcript`);
  const picked = pickAb(pool, n);
  console.log(`[ab] picked ${picked.length}:`, picked.map((p) => `${p.row.id.slice(0, 8)}(${p.why}; ${[...p.cats].join('+') || '-'}; ${Math.round(p.row.duration_ms / 1000)}s)`).join(', '));
  const pickedMin = picked.reduce((s, p) => s + (p.row.mkt_content_media?.duration_ms || p.row.duration_ms || 0), 0) / 60000;
  console.log(`[ab] ${pickedMin.toFixed(1)} audio-min × 2 variants ≈ $${(pickedMin * 2 * USD_PER_MIN).toFixed(3)} at list price`);
  if (flag('dry-run')) {
    for (const p of picked) { const f = await expectedFacts(p.row); console.log(`  ${p.row.mkt_content_posts?.post_url}\n    cats=${[...p.cats].join(',') || '-'} names=${f.names.map((n) => n.name).join(' | ') || '-'} numbers=${f.numbers.join(',') || '-'}\n    A: ${p.row.text.slice(0, 160).replace(/\n/g, ' ')}`); }
    return;
  }
  const results = await mapLimit(picked, 3, async (p) => {
    const row = p.row; const durationMs = row.mkt_content_media?.duration_ms || row.duration_ms || null;
    const src = await audioUrlFor(row);
    const facts = await expectedFacts(row);
    const out = { transcript_id: row.id, media_id: row.content_media_id, post_id: row.content_post_id, post_url: row.mkt_content_posts?.post_url, platform: row.mkt_content_posts?.platform, why: p.why, categories: [...p.cats], duration_ms: durationMs, source: src, facts, variants: {} };
    out.variants.A = { model: MODEL_A, request: '(stored v1 row: no language key ⇒ fal default "en")', text: row.text, segments: row.segments ?? [], language: row.language, costUsd: 0, metrics: scoreTranscript(row.text, row.segments ?? [], durationMs, facts) };
    const variants = [
      ['B', 'fal-ai/whisper', { task: 'transcribe', language: 'ar', chunk_level: 'word', version: '3' }, 'word', storeWord ? MODEL_WORD : null],
      ['B2', 'fal-ai/wizper', { task: 'transcribe', language: 'ar', chunk_level: 'segment', version: '3' }, 'segment', store ? MODEL_AR : null],
    ];
    for (const [key, model, params, level, storeKey] of variants) {
      const body = { audio_url: src.url, ...params };
      try {
        const { json, ms } = await falRun(model, body);
        const r = normalizeFal(json, durationMs, level);
        out.variants[key] = { model, request: params, text: r.text, segments: r.segments, reordered_by_us: r.reordered, languages: r.languages, chunk_count: (json.chunks ?? []).length, costUsd: r.costUsd, latency_ms: ms, metrics: scoreTranscript(r.text, r.segments, durationMs, facts), stored_as: storeKey };
        if (storeKey) await upsertTranscript(row, storeKey, r, durationMs, { ...json, _request: params, _source: src });
        console.log(`[ab] ${row.id.slice(0, 8)} ${key} ok ${ms}ms $${r.costUsd} ar=${out.variants[key].metrics.arabic_ratio} names=${out.variants[key].metrics.names_found}/${out.variants[key].metrics.names_total} nums=${out.variants[key].metrics.numbers_found}/${out.variants[key].metrics.numbers_total}`);
      } catch (e) {
        out.variants[key] = { model, request: params, error: e.message, costUsd: 0 };
        console.error(`[ab] ${row.id.slice(0, 8)} ${key} FAILED: ${e.message}`);
      }
    }
    return out;
  });
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ generated_at: new Date().toISOString(), pool_size: pool.length, results }, null, 2));
  writeReport(results, pool.length);
  writeHumanReview(results);
  const cost = results.reduce((s, r) => s + Object.values(r.variants).reduce((a, v) => a + (v.costUsd || 0), 0), 0);
  console.log(`[ab] done. estimated fal cost $${cost.toFixed(4)} — wrote ${OUT_DIR}/{report.md,human-review.md,results.json}`);
}

function pct(a, b) { return b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '—'; }
function writeReport(results, poolSize) {
  const V = ['A', 'B', 'B2'];
  const tot = Object.fromEntries(V.map((v) => [v, { n: 0, ar: 0, nf: 0, nz: 0, nt: 0, xf: 0, xt: 0, seg: 0, med: [], greet_ok: 0, greet_n: 0, cov: [], lat: [], cost: 0, fail: 0 }]));
  const lines = [];
  lines.push('# ASR A/B — English-default wizper (A) vs Arabic-forced (B word-level whisper, B2 wizper segment)');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/retranscribe-arabic.mjs --ab\`. Pool: ${poolSize} stored competitor videos with a done, non-empty \`fal-ai/wizper\` transcript; ${results.length} sampled.`);
  lines.push('');
  lines.push('**No human ground truth exists for these videos.** Every metric below is a proxy computed against the enrichment result, the linked project / organization / developer records, and the post caption — none of which were produced from the audio. Dialect fidelity needs the operator sheet in `human-review.md`.');
  lines.push('');
  lines.push('## Variants');
  lines.push('');
  lines.push('| Key | Endpoint | Request (besides `audio_url`) | Note |');
  lines.push('|---|---|---|---|');
  lines.push('| A | `fal-ai/wizper` | `{task:"transcribe", chunk_level:"segment", version:"3"}` — **no `language` key** | The stored v1 rows. fal\'s schema defaults `language` to `"en"`, so Whisper decoded Arabic speech as English. |');
  lines.push('| B | `fal-ai/whisper` | `{task:"transcribe", language:"ar", chunk_level:"word", version:"3"}` | wizper returns **422** for `chunk_level:"word"` (schema: `const "segment"`), so word-level ran on the sibling whisper endpoint. Words re-aggregated to ~5–8 s segments. |');
  lines.push('| B2 | `fal-ai/wizper` | `{task:"transcribe", language:"ar", chunk_level:"segment", version:"3"}` | The backfill candidate; stored as `fal-ai/wizper@ar`. |');
  lines.push('');
  lines.push('## Per-video');
  lines.push('');
  lines.push('| # | Video | Why picked | Dur s | Var | Arabic | Names (strict) | Names (±1 edit) | Numbers | Segs | Median seg s | Greeting ≤15% | Coverage | Latency s | Cost $ |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    for (const v of V) {
      const x = r.variants[v]; const m = x?.metrics; const t = tot[v];
      if (!x || x.error) { if (x?.error) t.fail++; lines.push(`| ${i + 1} | [${r.post_id.slice(0, 8)}](${r.post_url}) | ${r.why} | ${Math.round(r.duration_ms / 1000)} | ${v} | ERROR: ${x?.error ?? 'missing'} | | | | | | | | | |`); continue; }
      t.n++; t.ar += m.arabic_ratio; t.nf += m.names_found; t.nz += m.names_fuzzy ?? m.names_found; t.nt += m.names_total; t.xf += m.numbers_found; t.xt += m.numbers_total; t.seg += m.segment_count; t.med.push(m.median_segment_ms); t.cost += x.costUsd || 0; if (x.latency_ms) t.lat.push(x.latency_ms);
      if (m.greeting_in_first_15pct !== null) { t.greet_n++; if (m.greeting_in_first_15pct) t.greet_ok++; }
      if (m.coverage !== null) t.cov.push(m.coverage);
      const greet = m.greeting_in_first_15pct === null ? 'no greeting' : m.greeting_in_first_15pct ? 'yes' : `no (${Math.round(m.greeting_pos * 100)}%)`;
      lines.push(`| ${i + 1} | [${r.post_id.slice(0, 8)}](${r.post_url}) | ${r.why} | ${Math.round(r.duration_ms / 1000)} | ${v} | ${(m.arabic_ratio * 100).toFixed(0)}% | ${pct(m.names_found, m.names_total)} | ${pct(m.names_fuzzy ?? m.names_found, m.names_total)} | ${pct(m.numbers_found, m.numbers_total)} | ${m.segment_count} | ${(m.median_segment_ms / 1000).toFixed(1)} | ${greet} | ${m.coverage === null ? '—' : `${Math.round(m.coverage * 100)}%`} | ${x.latency_ms ? (x.latency_ms / 1000).toFixed(0) : '—'} | ${(x.costUsd || 0).toFixed(4)} |`);
    }
  });
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| Variant | Videos | Mean Arabic ratio | Names (strict) | Names (±1 edit) | Numbers present | Segments / video | Median seg s | Greeting ≤15% | Mean coverage | Median latency s | Est. cost $ | Failures |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const v of V) {
    const t = tot[v];
    lines.push(`| ${v} | ${t.n} | ${t.n ? (100 * t.ar / t.n).toFixed(0) : '—'}% | ${pct(t.nf, t.nt)} | ${pct(t.nz, t.nt)} | ${pct(t.xf, t.xt)} | ${t.n ? (t.seg / t.n).toFixed(1) : '—'} | ${(median(t.med) / 1000).toFixed(1)} | ${pct(t.greet_ok, t.greet_n)} | ${t.cov.length ? `${Math.round(100 * t.cov.reduce((a, b) => a + b, 0) / t.cov.length)}%` : '—'} | ${t.lat.length ? (median(t.lat) / 1000).toFixed(0) : '—'} | ${t.cost.toFixed(4)} | ${t.fail} |`);
  }
  lines.push('');
  lines.push('Cost is an estimate at fal\'s list price ($0.01 / audio-minute); the API returns no billing data — verify on the fal dashboard. A\'s cost was already paid.');
  lines.push('');
  // Gate
  const A = tot.A, B = tot.B2;
  const nameRateA = A.nt ? A.nf / A.nt : 0, nameRateB = B.nt ? B.nf / B.nt : 0;
  const numRateA = A.xt ? A.xf / A.xt : 0, numRateB = B.xt ? B.xf / B.xt : 0;
  const greetRateB = B.greet_n ? B.greet_ok / B.greet_n : null;
  const namesWin = B.nt > 0 && nameRateB > nameRateA;
  const numsWin = B.xt === 0 ? null : numRateB >= numRateA && (numRateB > numRateA || numRateB === 1);
  const orderOk = greetRateB === null ? null : greetRateB >= 0.8;
  const failed = B.fail > 0;
  const go = namesWin && numsWin !== false && orderOk !== false && !failed;
  lines.push('## Gate (B2 = the backfill variant, vs A)');
  lines.push('');
  lines.push(`- Proper names: A ${pct(A.nf, A.nt)} → B2 ${pct(B.nf, B.nt)} — ${namesWin ? 'B2 wins' : 'B2 does NOT beat A'}`);
  lines.push(`- Numbers: A ${pct(A.xf, A.xt)} → B2 ${pct(B.xf, B.xt)} — ${numsWin === null ? 'no numeric facts in the sample (inconclusive)' : numsWin ? 'B2 wins or ties at 100%' : 'B2 does NOT beat A'}`);
  lines.push(`- Ordering (greeting in first 15% of text, where a greeting exists): B2 ${pct(B.greet_ok, B.greet_n)} — ${orderOk === null ? 'no greeting found in any B2 transcript (inconclusive)' : orderOk ? 'ordering looks correct' : 'ordering suspect'}`);
  lines.push(`- Failures: ${B.fail}`);
  lines.push('');
  lines.push(`**Recommendation: ${go ? 'GO' : 'NO-GO'}** for the Arabic backfill (\`--backfill --confirm\`).${go ? '' : ' See per-video rows for what fell short.'}`);
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push('- Name/number presence is measured after Arabic normalization (harakat/tatweel stripped, أإآ→ا, ة→ه, ى→ي, digits unified, `ال` prefix ignored). A name counts only if EVERY significant token is present (strict), so partial hits count as misses for both variants; the ±1-edit column tolerates one character slip per token («فستا»/«فستة», «سواري»/«سواهري») — the usual ASR error on an unfamiliar brand name.');
  lines.push('- Numbers: Whisper writes Saudi prices as WORDS in Arabic («مليونين وخمسمية وتسعين» = 2,590,000; «919 ألف»), and as digits in English. The numeric metric expands spoken Arabic number phrases (incl. the colloquial implied «ألف» after «مليون») and dotted/comma thousands before comparing; without that expansion the Arabic variants scored 40% on a metric artifact. Remaining misses are either a genuine ASR digit error (e.g. «1.282.000» vs the enrichment\'s 1,289,000) or a number the enrichment took from the caption/visuals that was never spoken.');
  lines.push('- Expected names come from `mkt_content_enrichment` (district/location), the linked `all_projects` record (`project_name`), `mkt_organizations` (name_ar/name_en + developer record), and caption patterns (`مشروع X`, `حي X`, `#hashtag`). Organization names are often NOT spoken in the video, which depresses BOTH variants equally.');
  lines.push('- The A transcripts are English, so Arabic names can only match them through transliteration — they mostly cannot. That is the point: the stored rows are unusable for Arabic name/number extraction.');
  lines.push('- Speaker count is a heuristic (≥6 stored segments); no diarization was run.');
  lines.push('- Every stored fal row also exposes the v1 media path issue: where `content/audio/<checksum>.m4a` was missing, the stored mp4 was sent instead (see `source.kind` in results.json).');
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n') + '\n');
}
function writeHumanReview(results) {
  const L = [];
  L.push('# ASR A/B — human review sheet (dialect fidelity)');
  L.push('');
  L.push('Watch each video, then rate B2 (the Arabic wizper transcript) for Saudi-dialect fidelity from 1 (wrong words / MSA rewrite) to 5 (what was actually said). A is the stored English row; B is the word-level whisper run. Fill the `Rating` and `Notes` cells.');
  L.push('');
  results.forEach((r, i) => {
    L.push(`## ${i + 1}. ${r.post_url}`);
    L.push('');
    L.push(`- Media: ${r.media_id} · duration ${Math.round(r.duration_ms / 1000)} s · picked for: ${r.why} (${r.categories.join(', ') || '—'}) · audio source: ${r.source.kind}`);
    L.push(`- Expected names: ${r.facts.names.map((n) => `${n.name} [${n.source}]`).join('; ') || '—'}`);
    L.push(`- Expected numbers: ${r.facts.numbers.join(', ') || '—'}`);
    L.push('');
    L.push('| Variant | Transcript |');
    L.push('|---|---|');
    for (const v of ['A', 'B', 'B2']) { const x = r.variants[v]; L.push(`| ${v} | ${x?.error ? `ERROR: ${x.error}` : (x?.text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`); }
    L.push('');
    L.push('| Rating (1–5) | Notes |');
    L.push('|---|---|');
    L.push('|  |  |');
    L.push('');
  });
  fs.writeFileSync(path.join(OUT_DIR, 'human-review.md'), L.join('\n') + '\n');
}

async function runBackfill() {
  const limit = Number(opt('limit', 0)); const dry = flag('dry-run'); const conc = Number(opt('concurrency', 3));
  if (!limit) { console.error('--backfill needs --limit N'); process.exit(2); }
  if (!dry && !flag('confirm')) { console.error('Refusing to run the backfill without --confirm (the coordinator runs it only after the A/B gate passes). Use --dry-run to preview.'); process.exit(2); }
  const pool = await loadPool();
  const have = await existingArRows(pool.map((r) => r.content_media_id));
  const todo = pool.filter((r) => !have.has(r.content_media_id)).slice(0, limit);
  const estMin = todo.reduce((s, r) => s + (r.mkt_content_media?.duration_ms || r.duration_ms || 0), 0) / 60000;
  console.log(`[backfill] pool ${pool.length}, already have @ar ${have.size}, todo ${todo.length} (limit ${limit}), ~${estMin.toFixed(1)} audio-min ≈ $${(estMin * USD_PER_MIN).toFixed(3)}${dry ? ' — DRY RUN' : ''}`);
  if (dry) { for (const r of todo.slice(0, 25)) console.log(`  ${r.content_media_id} ${Math.round((r.mkt_content_media?.duration_ms || r.duration_ms || 0) / 1000)}s ${r.mkt_content_posts?.post_url}`); return; }
  let cost = 0, ok = 0, fail = 0;
  await mapLimit(todo, conc, async (row) => {
    const durationMs = row.mkt_content_media?.duration_ms || row.duration_ms || null;
    try {
      const src = await audioUrlFor(row);
      const params = { task: 'transcribe', language: 'ar', chunk_level: 'segment', version: '3' };
      const { json, ms } = await falRun('fal-ai/wizper', { audio_url: src.url, ...params });
      const r = normalizeFal(json, durationMs, 'segment');
      await upsertTranscript(row, MODEL_AR, r, durationMs, { ...json, _request: params, _source: src });
      cost += r.costUsd; ok++;
      console.log(`[backfill] ok ${row.content_media_id} ${ms}ms $${r.costUsd} ar=${arabicRatio(r.text).toFixed(2)} chars=${r.text.length} (running $${cost.toFixed(3)})`);
    } catch (e) {
      fail++; console.error(`[backfill] FAIL ${row.content_media_id}: ${e.message}`);
      // Record the failure loudly on the @ar key so the next run does not silently retry forever; resumable by deleting the row.
      const { error } = await sb.rpc('mkt_transcript_upsert', { p_media: row.content_media_id, p_post: row.content_post_id, p_provider: 'fal', p_model: MODEL_AR, p_language: null, p_text: null, p_segments: '[]', p_duration_ms: durationMs, p_confidence: null, p_cost: 0, p_status: 'failed', p_failure: String(e.message).slice(0, 300), p_source_checksum: row.mkt_content_media?.checksum_sha256 ?? row.source_checksum, p_raw: null });
      if (error) console.error(`[backfill] could not record failure row: ${error.message}`);
    }
  });
  console.log(`[backfill] done: ${ok} ok, ${fail} failed, estimated fal cost $${cost.toFixed(4)}`);
  if (fail) process.exitCode = 1;
}

/** Recompute every metric from results.json with the CURRENT scorer (no fal spend) and rewrite the markdown. */
async function runRescore() {
  const p = path.join(OUT_DIR, 'results.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const r of doc.results) {
    // Names were resolved from live records at run time and are kept verbatim;
    // numbers are re-extracted from the stored enrichment result with the
    // current extractor so a parser fix re-scores without a fal spend.
    const res = r.facts.result ?? {};
    const numbers = new Set();
    for (const f of [res.price, res.payment_plan, res.offer, res.financing, ...(res.unit_types ?? []), ...(res.selling_points ?? [])]) for (const n of numbersIn(String(f ?? ''))) numbers.add(n);
    r.facts.numbers = [...numbers];
    for (const v of Object.values(r.variants)) if (!v.error) v.metrics = scoreTranscript(v.text, v.segments ?? [], r.duration_ms, r.facts);
  }
  fs.writeFileSync(p, JSON.stringify({ ...doc, rescored_at: new Date().toISOString() }, null, 2));
  writeReport(doc.results, doc.pool_size); writeHumanReview(doc.results);
  console.log(`[rescore] rewrote ${OUT_DIR}/{report.md,human-review.md,results.json}`);
}

if (flag('ab')) await runAb();
else if (flag('backfill')) await runBackfill();
else if (flag('rescore')) await runRescore();
else { console.error('usage: node scripts/retranscribe-arabic.mjs --ab [--n 10] [--dry-run] [--no-store] [--store-word] | --rescore | --backfill --limit N [--dry-run] [--concurrency 3] --confirm'); process.exit(2); }
