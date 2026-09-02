#!/usr/bin/env node
/**
 * One-off: embed competitor VIDEO posts (transcript + OCR + campaign message +
 * selling points) into mkt_content_embeddings so mkt_script_exemplars does
 * SEMANTIC retrieval instead of falling back to lexical. Idempotent: skips a
 * post whose text_hash is unchanged. Re-runnable; resumable.
 *
 *   node scripts/backfill-post-embeddings.mjs [--limit N] [--force]
 *
 * Env (from .env.local): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MODAL_CV_URL,
 * MODAL_CV_TOKEN. No deploy needed — talks to prod + the Modal embed endpoint.
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
const MODAL_URL = (env.MODAL_CV_URL || '').replace(/\/+$/, ''), MODAL_TOKEN = env.MODAL_CV_TOKEN;
if (!SB_URL || !SB_KEY) { console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!MODAL_URL || !MODAL_TOKEN) { console.error('missing MODAL_CV_URL / MODAL_CV_TOKEN'); process.exit(1); }

const args = process.argv.slice(2);
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const FORCE = args.includes('--force');
const MODEL = 'bge-m3', VERSION = 1, BATCH = 48;
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

async function embedText(texts) {
  const r = await fetch(`${MODAL_URL}/embed_text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wassel-token': MODAL_TOKEN },
    body: JSON.stringify({ texts }),
  });
  if (!r.ok) throw new Error(`embed_text ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!Array.isArray(j.vectors) || j.vectors.length !== texts.length) throw new Error('embed_text shape mismatch');
  return j.vectors;
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
  const { data: existing } = await sb.from('mkt_content_embeddings').select('content_post_id, text_hash');
  const have = new Map((existing ?? []).map((e) => [e.content_post_id, e.text_hash]));

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
