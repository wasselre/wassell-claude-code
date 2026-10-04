#!/usr/bin/env node
/**
 * One-off: embed competitor VIDEO posts (transcript + OCR + campaign message +
 * selling points) into mkt_content_embeddings so mkt_script_exemplars does
 * SEMANTIC retrieval instead of falling back to lexical. Idempotent: skips a
 * post whose text_hash is unchanged. Re-runnable; resumable.
 *
 *   node scripts/backfill-post-embeddings.mjs [--limit N] [--force]
 *
 * Env (from .env.local): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.
 * No deploy needed — talks to prod + Gemini `gemini-embedding-2` at 1024 dims,
 * the same model and length the worker's embed_text role queries with
 * (Modal's bge-m3 until 2026-10-04 — those vectors are not comparable, so the
 * model is part of text_hash and a model change re-embeds every row).
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  } catch { /* .env.local optional when the vars are already in env */ }
  return env;
}

const env = loadEnv();
const SB_URL = env.SUPABASE_URL, SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_KEY = (env.GEMINI_API_KEY || '').trim();
if (!SB_URL || !SB_KEY) { console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!GEMINI_KEY) { console.error('missing GEMINI_API_KEY'); process.exit(1); }

const args = process.argv.slice(2);
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const FORCE = args.includes('--force');
import { recordAiUsage } from './lib/aiUsage.mjs';

const MODEL = 'gemini-embedding-2', VERSION = 2, DIM = 1024, BATCH = 48;
// $0.20 per 1M text tokens — https://ai.google.dev/gemini-api/docs/pricing (read 2026-10-04).
const TEXT_USD_PER_M = 0.2;
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

async function embedText(texts) {
  // One ai_usage row per batch request; tokens come from Gemini's own count.
  const started = Date.now();
  const bill = (status, error, tokens = 0) =>
    recordAiUsage({
      area: 'competitors',
      callSite: 'scripts/backfill-post-embeddings',
      operation: 'embed_text',
      provider: 'gemini',
      model: MODEL,
      status,
      error: error ?? null,
      inputTokens: tokens,
      units: texts.length,
      unitKind: 'query',
      latencyMs: Date.now() - started,
      ...(status === 'ok' ? { costUsd: Math.round((tokens / 1e6) * TEXT_USD_PER_M * 1e8) / 1e8 } : {}),
    });
  let r;
  for (let attempt = 1; ; attempt++) {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({ requests: texts.map((t) => ({ model: `models/${MODEL}`, content: { parts: [{ text: t }] }, outputDimensionality: DIM })) }),
    });
    if (r.ok || ![429, 500, 503].includes(r.status) || attempt >= 6) break;
    // A per-minute 429 says how long to wait (retryDelay "37s"); honour it. A
    // per-DAY quota will not clear by waiting — give up on this batch at once.
    const peek = await r.clone().text();
    if (/PerDay/i.test(peek)) break;
    const hinted = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(peek)?.[1]);
    await new Promise((res) => setTimeout(res, Number.isFinite(hinted) && hinted > 0 ? (hinted + 1) * 1000 : 2000 * 2 ** attempt));
  }
  if (!r.ok) {
    const body = await r.text();
    const quota = /"quotaId":\s*"([^"]+)"/.exec(body)?.[1];
    const qv = /"quotaValue":\s*"([^"]+)"/.exec(body)?.[1];
    const msg = `embed_text ${r.status}${quota ? ` quota=${quota}${qv ? ` limit=${qv}` : ""}` : ""}: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
    await bill('error', msg);
    throw new Error(msg);
  }
  const j = await r.json();
  await bill('ok', null, Number(j.usageMetadata?.promptTokenCount ?? 0) || 0);
  const vectors = (j.embeddings ?? []).map((e) => e.values);
  if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || v.length !== DIM)) throw new Error('embed_text shape mismatch');
  return vectors;
}

// pull VIDEO posts + their best transcript + OCR + enrichment, build source_text
async function loadPosts() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('mkt_content_posts')
      .select('id, post_type, caption')
      .in('post_type', ['video', 'reel', 'short'])
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`posts: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function textFor(postId, caption) {
  const [tx, vt, en] = await Promise.all([
    sb.from('mkt_transcripts').select('text, language').eq('content_post_id', postId).eq('status', 'done')
      .order('language', { ascending: false }).limit(1).maybeSingle(),
    sb.from('mkt_visual_text').select('text').eq('content_post_id', postId).eq('status', 'done').limit(20),
    sb.from('mkt_content_enrichment').select('result').eq('content_post_id', postId).eq('status', 'done').maybeSingle(),
  ]);
  const parts = [];
  const r = en.data?.result ?? {};
  if (r.campaign_message) parts.push(String(r.campaign_message));
  if (Array.isArray(r.selling_points)) parts.push(r.selling_points.join(' · '));
  if (r.content_type) parts.push(String(r.content_type));
  if (tx.data?.text) parts.push(String(tx.data.text).slice(0, 2000));
  const ocr = (vt.data ?? []).map((v) => v.text).filter(Boolean).join(' | ');
  if (ocr) parts.push(ocr.slice(0, 1000));
  if (caption) parts.push(String(caption).slice(0, 600));
  return parts.join('\n').trim();
}

async function main() {
  const posts = await loadPosts();
  console.log(`[embed] ${posts.length} video posts`);
  // Paginated: a single select stops at 1,000 rows, which made every post past
  // the first thousand look un-embedded and get paid for again.
  const have = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('mkt_content_embeddings').select('content_post_id, text_hash')
      .order('content_post_id').range(from, from + 999);
    if (error) throw new Error(`existing embeddings: ${error.message}`);
    for (const e of data ?? []) have.set(e.content_post_id, e.text_hash);
    if (!data || data.length < 1000) break;
  }
  console.log(`[embed] ${have.size} already embedded`);

  let done = 0, skipped = 0, empty = 0, failed = 0, batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    try {
      const vectors = await embedText(batch.map((b) => b.text));
      const rows = batch.map((b, i) => ({
        content_post_id: b.id, embedding: JSON.stringify(vectors[i]), model: MODEL, version: VERSION,
        text_hash: b.hash, source_text: b.text.slice(0, 4000), updated_at: new Date().toISOString(),
      }));
      const { error } = await sb.from('mkt_content_embeddings').upsert(rows, { onConflict: 'content_post_id' });
      if (error) throw new Error(error.message);
      done += rows.length;
    } catch (e) { failed += batch.length; console.error(`[embed] batch failed: ${e.message}`); }
    batch = [];
    await new Promise((res) => setTimeout(res, 1500)); // stay under the per-minute embed quota
    if ((done + skipped + empty) % 200 < BATCH) console.log(`[embed] done=${done} skip=${skipped} empty=${empty} fail=${failed}`);
  };

  for (const p of posts) {
    if (done + skipped + empty >= LIMIT) break;
    const text = await textFor(p.id, p.caption);
    if (!text || text.length < 40) { empty++; continue; }
    const hash = createHash('sha256').update(`${MODEL}:${VERSION}:${text}`).digest('hex').slice(0, 32);
    if (!FORCE && have.get(p.id) === hash) { skipped++; continue; }
    batch.push({ id: p.id, text, hash });
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  console.log(`[embed] FINISHED done=${done} skipped=${skipped} empty=${empty} failed=${failed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
