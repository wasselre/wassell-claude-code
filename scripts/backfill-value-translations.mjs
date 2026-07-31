#!/usr/bin/env node
/**
 * Backfill the value_translations cache for every existing untranslated
 * Arabic record value (Arabic → English).
 *
 * Reads candidates from the service-role RPC `value_translation_candidates`
 * (defined in supabase/migrations/2026-07-31_value_translations.sql — the
 * translatable-field rules live THERE), translates them in batches of 20 via
 * DeepSeek, and upserts into value_translations. Idempotent and resumable:
 * the RPC only ever returns strings that are not yet cached, so re-running
 * after an interruption continues where it left off.
 *
 * Usage:
 *   node scripts/backfill-value-translations.mjs --dry-run   # count + sample only
 *   node scripts/backfill-value-translations.mjs             # run the backfill
 *   node scripts/backfill-value-translations.mjs --max 500   # cap this run
 *
 * Env (auto-loads .env.local / .env): SUPABASE_URL (or VITE_SUPABASE_URL),
 * SUPABASE_SERVICE_ROLE_KEY, DEEPSEEK_API_KEY.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── env loading (no dotenv dependency — same posture as sync-model-workflow-prds)
for (const file of ['.env.local', '.env']) {
  const p = resolve(ROOT, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const maxArg = process.argv.indexOf('--max');
const MAX_STRINGS = maxArg !== -1 ? Number(process.argv[maxArg + 1]) : Infinity;

if (!DRY_RUN && !DEEPSEEK_KEY) {
  console.error('Missing DEEPSEEK_API_KEY (required unless --dry-run)');
  process.exit(1);
}

const BATCH_MAX_ITEMS = 20; // strings per DeepSeek call (hard cap)
const BATCH_MAX_CHARS = 3000; // total source chars per call — long prose (competitor
// analyses, unit notes) must not overflow max_tokens, which truncates the JSON reply
const RPC_PAGE = 200; // candidates fetched per RPC call

// Keep in sync with the SYSTEM_PROMPT in api/value-translate.ts.
const SYSTEM_PROMPT = `You translate CRM record values between Arabic and English for a Saudi Arabian real-estate company (Wassel / وصل العقارية).

You will receive a JSON array of items: {"i": <index>, "kind": "name"|"text", "src": "<source text>"} and a target language.

Rules per kind:

1. **name** — proper nouns: project names, developer/company names, person names, unit model codes.
   - To English: TRANSLITERATE to Latin script the way Saudi developers write them in English marketing (e.g. "مساكن الأصيل" → "Masaken Al Aseel", "شركة الماجدية العقارية" → "Al Majdiah Real Estate"). Translate only generic words like شركة/مشروع when natural ("Company", "Project"); never invent a different name.
   - To Arabic: render the name in Arabic script the way Saudi media writes it.

2. **text** — notes, descriptions, analyses.
   - Translate naturally and FAITHFULLY. Keep every fact: numbers, prices, dates, directions, names. Professional real-estate register. Do not summarize, embellish, or drop anything.

3. Keep digits as-is. Keep URLs, phone numbers, and codes untouched.

4. Every item MUST appear in the output with its same index "i". Never skip, never reorder facts.

OUTPUT FORMAT (hard requirement): respond with ONLY one JSON object: {"results":[{"i": number, "t": string}]}`;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function supabaseRest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'x-wassel-service': 'script:backfill-value-translations',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  // `Prefer: return=minimal` responses (201/204) have an EMPTY body — parsing
  // them threw "Unexpected end of JSON input" and failed every batch AFTER its
  // rows were successfully upserted (live bug, 2026-07-31).
  const text = await res.text();
  return text.trim() === '' ? null : JSON.parse(text);
}

async function fetchCandidates(limit) {
  return supabaseRest('/rest/v1/rpc/value_translation_candidates', {
    method: 'POST',
    body: JSON.stringify({ p_limit: limit }),
  });
}

async function deepseekBatch(items) {
  const payload = items.map((it, i) => ({ i, kind: it.kind, src: it.source_text }));
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Target language: English.\nItems:\n${JSON.stringify(payload)}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 8000,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`deepseek HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const finish = body.choices?.[0]?.finish_reason;
  if (finish === 'length') throw new Error('deepseek reply truncated (finish_reason=length) — batch too large');
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('deepseek returned an empty completion');
  const parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  const out = new Map();
  for (const r of parsed.results ?? []) {
    if (typeof r?.i === 'number' && typeof r?.t === 'string' && r.t.trim()) out.set(r.i, r.t.trim());
  }
  return out;
}

async function upsertRows(rows) {
  await supabaseRest('/rest/v1/value_translations?on_conflict=target_lang,source_hash', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
}

let done = 0;
let failed = 0;

for (;;) {
  const doneAtPageStart = done;
  const candidates = await fetchCandidates(Math.min(RPC_PAGE, Math.max(1, MAX_STRINGS - done)));
  if (!candidates || candidates.length === 0) break;

  if (DRY_RUN) {
    console.log(`[dry-run] ${candidates.length} candidates in first page. Sample:`);
    for (const c of candidates.slice(0, 10)) {
      console.log(`  [${c.kind}] ${c.model_hint}.${c.field_hint}: ${c.source_text.slice(0, 80)}`);
    }
    // Count the rest without translating: keep paging via a growing exclusion
    // is not possible through the RPC (it excludes only CACHED rows), so the
    // dry run reports the first page only.
    console.log('[dry-run] run without --dry-run to translate.');
    process.exit(0);
  }

  // Char-budget batching: many short names pack into one call; long prose
  // (competitor analyses, unit notes) gets small batches so the JSON reply
  // never hits max_tokens and truncates.
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const c of candidates) {
    const len = c.source_text.length;
    if (current.length > 0 && (current.length >= BATCH_MAX_ITEMS || currentChars + len > BATCH_MAX_CHARS)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(c);
    currentChars += len;
  }
  if (current.length > 0) chunks.push(current);

  const runChunk = async (chunk) => {
    try {
      const results = await deepseekBatch(chunk);
      const rows = chunk
        .map((c, j) => ({
          source_hash: sha256(c.source_text),
          target_lang: 'en',
          source_text: c.source_text,
          translated_text: results.get(j) ?? null,
          kind: c.kind,
          provider: 'deepseek',
          model_hint: c.model_hint,
          field_hint: c.field_hint,
        }))
        .filter((r) => r.translated_text);
      if (rows.length > 0) await upsertRows(rows);
      done += rows.length;
      failed += chunk.length - rows.length;
      process.stdout.write(`\rtranslated ${done}  (failed ${failed})   `);
    } catch (err) {
      // One bad batch (provider hiccup, JSON garble) must not kill the run —
      // the RPC will re-offer these strings on the next pass; log and move on.
      failed += chunk.length;
      console.error(`\nbatch failed: ${err.message}`);
    }
  };

  // Modest concurrency — 4 in-flight DeepSeek calls cuts a multi-hour
  // sequential run to well under an hour without hammering the API.
  const CONCURRENCY = 4;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + CONCURRENCY).map(runChunk));
  }

  if (done >= MAX_STRINGS) break;
  // Failed strings are re-offered by the RPC (they're not cached); a page
  // that made zero progress would loop forever — stop loudly instead.
  if (done === doneAtPageStart) {
    console.error('\nno progress on the last page — aborting; fix the provider errors above and re-run.');
    break;
  }
}

console.log(`\ndone. translated ${done} strings, ${failed} failed (re-run to retry failures).`);
