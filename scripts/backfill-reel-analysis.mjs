#!/usr/bin/env node
/**
 * backfill-reel-analysis.mjs
 * ----------------------------------------------------------------------------
 * Bulk "Clean & Analyze" for the Competitor Library (`competitors` model,
 * type=reel_script). For every reel it runs the SHARED engine
 * api/_lib/reelAnalyst.mjs (same code the in-app "Clean & Analyze" button
 * calls) and writes back the cleaned transcript + the marketing-analysis
 * fields via the `record_save` RPC.
 *
 * SHARED ENGINE, ZERO DRIFT: this .mjs script and api/analyze-reel.ts both
 * import api/_lib/reelAnalyst.mjs, so the cleaning prompt is identical in the
 * one-off bulk run and the per-record button (the repo has no tsx, so the
 * engine is .mjs precisely so a plain-`node` script can import it).
 *
 * REQUIRED ENV (process.env or auto-loaded from .env.local / .env at repo root):
 *   SUPABASE_URL              (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY (service role — bypasses RLS so every reel is
 *                              visible + writable in one pass)
 *   ANTHROPIC_API_KEY
 *
 * USAGE
 *   node scripts/backfill-reel-analysis.mjs              # process all pending
 *   node scripts/backfill-reel-analysis.mjs --limit 15   # SAMPLE: first 15
 *   node scripts/backfill-reel-analysis.mjs --ids a,b,c  # only these record ids
 *   node scripts/backfill-reel-analysis.mjs --force      # re-process analyzed/reviewed/skipped too
 *   node scripts/backfill-reel-analysis.mjs --concurrency 8
 *
 * IDEMPOTENT: by default skips reels already in status analyzed/reviewed/skipped
 * (so a re-run only picks up raw + previously-errored reels). Reels with empty /
 * near-empty `content` are marked `skipped`. Failures are marked `error` (with
 * the reason in analysis_notes) and retried on the next run — never a silent
 * swallow (CLAUDE.md "Silent Failures").
 * ----------------------------------------------------------------------------
 */

import { makeIdentifiedClient } from './_lib/serviceClient.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanAndAnalyzeReel, MIN_TRANSCRIPT_CHARS } from '../api/_lib/reelAnalyst.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

// ── tiny zero-dep .env loader (mirrors scripts/sync-model-workflow-prds.mjs) ──
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  let txt;
  try {
    txt = readFileSync(p, 'utf8');
  } catch {
    return;
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env'));

// ── args ─────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
function argValue(name, fallback) {
  const i = ARGS.indexOf(name);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : fallback;
}
const FORCE = ARGS.includes('--force');
const LIMIT = argValue('--limit', null) ? parseInt(argValue('--limit'), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(argValue('--concurrency', '6'), 10) || 6);
const ONLY_IDS = (() => {
  const raw = argValue('--ids', null);
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();

function bail(reason) {
  console.error(`[backfill-reels] ERROR — ${reason}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!SUPABASE_URL) bail('SUPABASE_URL (or VITE_SUPABASE_URL) is not set');
if (!SERVICE_KEY) bail('SUPABASE_SERVICE_ROLE_KEY is not set (required to read+write all reels)');
if (!ANTHROPIC_API_KEY) bail('ANTHROPIC_API_KEY is not set');

const supabase = makeIdentifiedClient('script:backfill-reel-analysis', SUPABASE_URL, SERVICE_KEY);

const ANALYSIS_KEYS = [
  'clean_content', 'hook', 'hook_type', 'angle', 'psych_trigger',
  'structure', 'tone', 'cta', 'cta_type', 'analysis_notes',
];

// ── persist: record_save with optimistic concurrency + one retry ───────────
async function saveMerged(id, modelId, patch, baseData, baseVersion) {
  const attempt = (data, version) =>
    supabase.rpc('record_save', {
      p_model_id: modelId,
      p_id: id,
      p_data: data,
      p_expected_version: version,
    });

  let { error } = await attempt({ ...baseData, ...patch }, baseVersion);
  if (error) {
    const isConflict = error.code === '40001' || (error.message ?? '').includes('version_mismatch');
    if (!isConflict) throw new Error(`record_save failed: ${error.message}`);
    // Concurrent edit landed during the model call — re-read, re-merge, retry once.
    const { data: fresh, error: freshErr } = await supabase
      .from('records').select('data, version').eq('id', id).maybeSingle();
    if (freshErr) throw new Error(`re-read failed: ${freshErr.message}`);
    const freshData = fresh?.data ?? baseData;
    ({ error } = await attempt({ ...freshData, ...patch }, fresh?.version ?? null));
    if (error) throw new Error(`record_save retry failed: ${error.message}`);
  }
}

// ── process one reel ───────────────────────────────────────────────────────
async function processOne(rec, modelId) {
  const data = rec.data ?? {};
  const name = typeof data.name === 'string' ? data.name : rec.id.slice(0, 8);
  const content = typeof data.content === 'string' ? data.content.trim() : '';

  if (content.length < MIN_TRANSCRIPT_CHARS) {
    await saveMerged(rec.id, modelId, { processing_status: 'skipped' }, data, rec.version);
    return { outcome: 'skipped', name, reason: `content ${content.length} < ${MIN_TRANSCRIPT_CHARS}` };
  }

  try {
    const r = await cleanAndAnalyzeReel(ANTHROPIC_API_KEY, content);
    const patch = {
      clean_content: r.clean_content,
      hook: r.hook,
      hook_type: r.hook_type,
      angle: r.angle,
      psych_trigger: r.psych_trigger,
      structure: r.structure,
      tone: r.tone,
      cta: r.cta,
      cta_type: r.cta_type,
      analysis_notes: r.analysis_notes,
      processing_status: 'analyzed',
    };
    await saveMerged(rec.id, modelId, patch, data, rec.version);
    return {
      outcome: 'analyzed', name,
      contentLen: content.length, cleanLen: r.clean_content.length,
      hook: r.hook, angle: r.angle, confidence: r.confidence,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Record the failure on the row so it's visible in the UI and retried next
    // run. If even THIS write fails, log loudly — never swallow.
    try {
      await saveMerged(rec.id, modelId, {
        processing_status: 'error',
        analysis_notes: `Backfill error: ${msg}`,
      }, data, rec.version);
    } catch (writeErr) {
      console.error(`[backfill-reels] could not record error on ${rec.id}: ${writeErr instanceof Error ? writeErr.message : writeErr}`);
    }
    return { outcome: 'error', name, error: msg };
  }
}

// ── simple bounded-concurrency pool ────────────────────────────────────────
async function runPool(items, concurrency, worker) {
  let next = 0;
  const results = new Array(items.length);
  const runner = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const { data: modelRow, error: modelErr } = await supabase
    .from('models').select('id').eq('name', 'competitors').single();
  if (modelErr || !modelRow) bail(`competitors model not found: ${modelErr?.message ?? 'missing'}`);
  const MODEL_ID = modelRow.id;

  // Page through every reel_script row (avoid the 1000-row PostgREST cap).
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('records')
      .select('id, data, version')
      .eq('model_id', MODEL_ID)
      .eq('data->>type', 'reel_script')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) bail(`failed to load reels: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Candidate selection.
  const DONE = new Set(['analyzed', 'reviewed', 'skipped']);
  let candidates = all.filter((r) => {
    if (ONLY_IDS && !ONLY_IDS.has(r.id)) return false;
    const status = r.data?.processing_status;
    if (!FORCE && DONE.has(status)) return false;
    return true;
  });
  const totalPending = candidates.length;
  if (LIMIT != null) candidates = candidates.slice(0, LIMIT);

  console.error(
    `[backfill-reels] ${all.length} reel_script rows · ${totalPending} pending · ` +
    `processing ${candidates.length}${LIMIT != null ? ` (--limit ${LIMIT})` : ''} · ` +
    `concurrency ${CONCURRENCY}${FORCE ? ' · --force' : ''}`,
  );
  if (candidates.length === 0) {
    console.error('[backfill-reels] nothing to do.');
    return;
  }

  let analyzed = 0, skipped = 0, errored = 0, completed = 0;
  const startedAt = Date.now();

  const results = await runPool(candidates, CONCURRENCY, async (rec) => {
    const res = await processOne(rec, MODEL_ID);
    completed++;
    if (res.outcome === 'analyzed') {
      analyzed++;
      const hook = (res.hook ?? '').replace(/\s+/g, ' ').slice(0, 64);
      console.error(
        `  [${completed}/${candidates.length}] ✓ ${res.name} · ${res.contentLen}→${res.cleanLen} ch · ` +
        `conf ${res.confidence} · angle [${(res.angle ?? []).join(', ')}] · hook "${hook}"`,
      );
    } else if (res.outcome === 'skipped') {
      skipped++;
      console.error(`  [${completed}/${candidates.length}] – skipped ${res.name} (${res.reason})`);
    } else {
      errored++;
      console.error(`  [${completed}/${candidates.length}] ✗ ERROR ${res.name}: ${res.error}`);
    }
    return res;
  });

  const secs = Math.round((Date.now() - startedAt) / 1000);
  console.error(
    `\n[backfill-reels] done in ${secs}s — analyzed ${analyzed} · skipped ${skipped} · errors ${errored}`,
  );
  if (errored > 0) {
    console.error(`[backfill-reels] ${errored} reel(s) errored (status='error', reason in analysis_notes). Re-run to retry them.`);
  }
  // Emit a machine-readable tail line for any wrapper.
  console.log(JSON.stringify({ analyzed, skipped, errors: errored, processed: results.length }));
}

main().catch((err) => bail(err instanceof Error ? err.stack ?? err.message : String(err)));
