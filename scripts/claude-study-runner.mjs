#!/usr/bin/env node
/**
 * claude-study-runner — drains the `claude_jobs` queue by running FULL headless
 * Claude Code sessions.
 *
 * PRODUCTION HOME (since 2026-07-26): the Fly app **wassel-claude-runner**
 * (`runner/Dockerfile` + `runner/fly.toml`, region sin, one machine + a standby).
 * It is always-on and does NOT depend on any developer machine. Deploy with:
 *   flyctl deploy --config runner/fly.toml --dockerfile runner/Dockerfile \
 *                 --app wassel-claude-runner
 * Health: `select claude_runner_health();` or the Runner card in Marketing
 * Operations. Logs: `flyctl logs --app wassel-claude-runner`.
 *
 * Running it locally (`npm run study-runner`) is now REFUSED unless
 * RUNNER_ALLOW_LOCAL=1 — see the dev-mode gate at the bottom. A laptop runner
 * would contend for the same production lease and could take ownership, which
 * is precisely the dependency the Fly deployment removes.
 *
 * For each pending job (ONE at a time — sequential by design, so the runner
 * never competes with the owner's interactive Claude sessions for rate limit):
 *   kind='ping'          → trivial echo session; verifies the whole chain.
 *   kind='client_study'  → `claude -p "/client-study <chat-url>" ...` in the
 *                          repo root. The prompt instructs the session to
 *                          write a result-sentinel JSON file; the runner
 *                          uploads the produced PDF to the `wassel-files`
 *                          bucket, mints a 7-day signed URL, and completes the
 *                          job with { pdf_signed_url, whatsapp_draft, ... }.
 *
 * Credentials: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local/.env
 * (same auto-load posture as scripts/sync-model-workflow-prds.mjs); on Fly they
 * arrive as runtime secrets, never baked into an image layer.
 *
 * Claude auth: the PAID SUBSCRIPTION, via CLAUDE_CODE_OAUTH_TOKEN in the
 * environment (on a laptop, the machine's own `claude` login also works). This
 * is not an Anthropic API key and produces NO incremental per-token API charge —
 * the work is included within the existing Claude subscription and is subject to
 * that subscription's shared capacity. ANTHROPIC_API_KEY is deliberately deleted
 * from the child env (see runClaude) and is absent from the Fly runner entirely,
 * so the runner cannot silently fall back to metered API billing.
 *
 * Sessions run with --dangerously-skip-permissions: this runner executes ONLY
 * on a trusted machine against our own repo. Do not point it at untrusted
 * repos or prompts.
 *
 * SINGLETON: ownership is enforced by a DB lease (claude_runner_lease), not by
 * operator discipline — two runners raced during the first live validation. A
 * second process exits cleanly at boot; the owner renews every 30s and the lease
 * expires 120s after the last heartbeat, so a crashed runner is taken over
 * automatically. All expiry comparisons use the DATABASE clock, so client clock
 * skew cannot produce two owners.
 *
 * SHUTDOWN: SIGINT/SIGTERM/SIGBREAK stop new claims, give the in-flight session
 * a 60s grace period, then group-kill the Claude child, requeue the job via
 * claude_job_interrupt (compare-and-set: only the claiming owner, only while
 * still 'running'), and release the lease — so a clean stop never leaves a job
 * stuck until the 45-minute crash watchdog.
 *   PLATFORM CAVEAT: Node on Windows cannot reliably receive SIGTERM from an
 *   external `kill` (verified — the handler does not run). On Windows the lease
 *   TTL + watchdog are the recovery path; on Linux/Fly (the production target)
 *   the container runtime delivers the signal and the graceful path runs.
 */
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnrichmentResults, isSubscriptionLimit } from './lib/mkt-enrichment-validate.mjs';
import { validateCampaignSummaries } from './lib/mkt-campaign-summary-validate.mjs';

// Thrown when Claude reports a subscription/usage limit — the runner parks the
// job (claude_job_block) and cools down instead of failing/retrying it.
class RateLimitError extends Error {}
const ENRICH_RULE_VERSION = 'enrich-runner-v1';
const CAMPAIGN_SUMMARY_VERSION = 'campaign-summary-v1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL_MS = 10_000;
const SESSION_TIMEOUT_MS = 35 * 60 * 1000;
const HOSTNAME = process.env.COMPUTERNAME || process.env.HOSTNAME || process.env.FLY_MACHINE_ID || 'local';
const WORKER = `runner:${HOSTNAME}:${process.pid}`;

// ── env (auto-load .env.local / .env, no dotenv dep) ────────────────────────
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[runner] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — check .env.local');
  process.exit(1);
}
const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── singleton lease + graceful shutdown state ───────────────────────────────
// Which LANE this process serves. Each lane is its own singleton — exactly one
// session per lease, same compare-and-set guarantee as before; there are simply
// two leases now so a rep's client_study no longer queues behind a long
// marketing backfill (see 2026-08-16_claude_two_lane_runner.sql).
//   'marketing_intelligence' → mkt_content_enrichment, mkt_campaign_summary
//   'interactive'            → ping, client_study
// The DB decides what each lane may claim; this process keeps every handler so
// it can ADOPT the other lane's work if that lease goes unheld.
const LEASE = process.env.RUNNER_LEASE || 'marketing_intelligence';
const LEASE_TTL_S = 120;          // lease dies 120s after the last heartbeat
const HEARTBEAT_MS = 30_000;      // renew every 30s (4x margin)
const SHUTDOWN_GRACE_MS = 60_000; // let the in-flight Claude session finish
let shuttingDown = false;
let currentJobId = null;
let currentChild = null;          // the live `claude` child (for group-kill)
let heartbeatTimer = null;

/** Kill the Claude child as a process GROUP (house posture — the CLI spawns
 *  children; killing only the parent leaves orphans holding the session). */
function killClaudeChild() {
  const child = currentChild;
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// ── claude CLI session ──────────────────────────────────────────────────────
function runClaude(prompt, cwd) {
  return new Promise((resolve) => {
    // Prompt goes via STDIN (not argv): multiline Arabic prompts survive
    // Windows shell quoting, and the CLI's "no stdin" warning goes away.
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'text'];
    // The child session must authenticate with THIS MACHINE'S Claude login
    // (the owner's account — explicit decision 2026-07-22). .env.local's
    // ANTHROPIC_API_KEY is the app's server-side key and is NOT valid for the
    // CLI — if it leaks into the child env the CLI prefers it and 401s.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const child = spawn('claude', args, {
      cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
      detached: process.platform !== 'win32', // POSIX: own process group so we can group-kill
    });
    currentChild = child;
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
      resolve({ code: -1, out, err: err + '\n[runner] session timeout' });
    }, SESSION_TIMEOUT_MS);
    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); currentChild = null; resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); currentChild = null; resolve({ code: -2, out, err: String(e) }); });
  });
}

// ── job handlers ────────────────────────────────────────────────────────────
async function handlePing(job) {
  const { code, out, err } = await runClaude(
    'Reply with exactly the single word PONG and nothing else.', ROOT);
  if (code !== 0 || !/PONG/i.test(out)) throw new Error(`ping session failed (code ${code}): ${(err || out).slice(-400)}`);
  return { pong_at: new Date().toISOString(), echo: out.trim().slice(0, 100) };
}

// Attach the generated PDF to the chat's linked client as a `files` row
// (kind='pdf', bucket wassel-files). Returns the new files.id, or null if the
// chat has no client link / anything fails. Best-effort by contract.
async function attachStudyToClient({ chatRecordId, storagePath, sizeBytes, title, ownerUserId }) {
  try {
    const { data: chatRows, error: chatErr } = await supa
      .from('records').select('data').eq('id', chatRecordId).limit(1);
    if (chatErr) throw chatErr;
    const clientId = chatRows?.[0]?.data?.client_link;
    if (!clientId || typeof clientId !== 'string') return null; // unlinked chat → nothing to attach to

    const { data: modelRows, error: modelErr } = await supa
      .from('models').select('id').eq('name', 'clients').limit(1);
    if (modelErr) throw modelErr;
    const clientsModelId = modelRows?.[0]?.id;
    if (!clientsModelId) return null;

    const fileRow = {
      model_id: clientsModelId,
      record_id: clientId,
      uploaded_by_user_id: ownerUserId,
      original_name: `${title}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: sizeBytes,
      storage_bucket: 'wassel-files',
      storage_path: storagePath,
      kind: 'pdf',
    };
    const { data: inserted, error: insErr } = await supa
      .from('files').insert(fileRow).select('id').single();
    if (insErr) throw insErr;
    return inserted?.id ?? null;
  } catch (e) {
    console.error('[runner] attach-to-client failed (non-fatal):', e.message ?? e);
    return null;
  }
}

async function handleClientStudy(job) {
  const chatId = job.payload?.chat_record_id;
  if (!chatId) throw new Error('payload.chat_record_id is required');

  const notes = typeof job.payload?.notes === 'string' ? job.payload.notes.trim() : '';
  const isRevision = typeof job.payload?.revision_of === 'string' && job.payload.revision_of.length > 0;

  const workDir = mkdtempSync(path.join(tmpdir(), 'claude-study-'));
  const sentinel = path.join(workDir, 'result.json');
  const prompt = [
    `/client-study https://app.wassel.re/model/chats/${chatId}`,
    '',
    ...(isRevision && notes ? [
      'This is a REVISION. The rep already received a study for this client,',
      'reviewed it, and gave this feedback — regenerate the study fully',
      'addressing it (keep what worked, fix what they flagged):',
      `«${notes}»`,
      '',
    ] : notes ? [
      'The rep gave these STUDY INSTRUCTIONS — treat them as priority guidance',
      'for scope, focus, framing, or what to avoid (they override the skill',
      `defaults where they conflict):`,
      `«${notes}»`,
      '',
    ] : []),
    'You are running HEADLESS from the app queue — no one can answer questions,',
    'so make every decision autonomously per the skill. When the study is done',
    'and visually verified, write a JSON file to exactly this path:',
    `  ${sentinel}`,
    'with keys: "pdf_path" (absolute path of the final PDF — FORWARD slashes,',
    'e.g. C:/Users/..., never raw backslashes), "title" (short',
    'Arabic study title), "whatsapp_draft" (the Arabic message for the client),',
    '"summary" (2-3 sentences for the rep, Arabic), "heads_ups" (array of',
    'private notes for the rep, may be empty). Writing this file is the LAST',
    'thing you do.',
  ].join('\n');

  try {
    const { code, out, err } = await runClaude(prompt, ROOT);
    if (!existsSync(sentinel)) {
      throw new Error(`session ended (code ${code}) without result sentinel: ${(err || out).slice(-600)}`);
    }
    const rawSentinel = readFileSync(sentinel, 'utf-8');
    let result;
    try {
      result = JSON.parse(rawSentinel);
    } catch {
      // Lenient pass: sessions sometimes write Windows paths with raw
      // backslashes ("C:\Users\...") — invalid JSON escapes. Double every
      // backslash not already part of a valid escape and retry; if it still
      // fails, surface the sentinel head for diagnosis.
      try {
        result = JSON.parse(rawSentinel.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
      } catch (e2) {
        throw new Error(`sentinel JSON invalid (${e2.message}): ${rawSentinel.slice(0, 300)}`);
      }
    }
    if (!result.pdf_path || !existsSync(result.pdf_path)) {
      throw new Error(`sentinel pdf_path missing or file not found: ${result.pdf_path}`);
    }

    const pdfBytes = readFileSync(result.pdf_path);
    const storagePath = `claude-studies/${job.id}.pdf`;
    const { error: upErr } = await supa.storage.from('wassel-files')
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

    const { data: signed, error: signErr } = await supa.storage.from('wassel-files')
      .createSignedUrl(storagePath, 7 * 24 * 3600);
    if (signErr) throw new Error(`signed url failed: ${signErr.message}`);

    // Attach the PDF to the linked client's files (files.model_id+record_id IS
    // the primary attachment). Best-effort — a broken attach must not fail the
    // whole study; the signed URL is still returned.
    const attachedFileId = await attachStudyToClient({
      chatRecordId: chatId, storagePath, sizeBytes: pdfBytes.length,
      title: result.title ?? 'دراسة عقارية', ownerUserId: job.requested_by_user_id ?? null,
    });

    return {
      title: result.title ?? 'دراسة عقارية',
      pdf_storage_path: storagePath,
      pdf_signed_url: signed.signedUrl,
      pdf_bytes: pdfBytes.length,
      attached_file_id: attachedFileId,
      whatsapp_draft: result.whatsapp_draft ?? '',
      summary: result.summary ?? '',
      heads_ups: Array.isArray(result.heads_ups) ? result.heads_ups : [],
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {
      console.error('[runner] workdir cleanup failed:', e.message);
    }
  }
}

// ── marketing content-enrichment (replaces the Anthropic enrichment API) ─────
// Reads a scoped evidence package for the batch, runs the content-enrichment
// Skill, VALIDATES the JSON (schema + business rules), and persists via the same
// scoped upsert RPCs the deterministic pipeline uses. Claude never writes to the
// DB directly. Uses THIS machine's paid Claude login — zero Anthropic API spend.
async function handleMktContentEnrichment(job) {
  const postIds = Array.isArray(job.payload?.post_ids) ? job.payload.post_ids : [];
  if (postIds.length === 0) throw new Error('payload.post_ids is required');

  const { data: evidenceRaw, error: evErr } = await supa.rpc('mkt_intelligence_evidence', { p_post_ids: postIds });
  if (evErr) throw new Error(`evidence rpc failed: ${evErr.message}`);
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0) throw new Error('no evidence returned');

  // A post with NO narrowed candidates is still worth deciding: the Skill extracts
  // the structured fields and the general-branding flag, and -1 (no project) is the
  // CORRECT answer when nothing was narrowed — most brand posts genuinely mention
  // no project. We only surface the count, because a high no-candidate rate can
  // also mean narrowing was skipped/wiped upstream and needs a content_process
  // re-run. (Never skip them here — that would strand brand posts forever.)
  const evidence = evidenceRaw;
  const noCandidates = evidenceRaw.filter((e) => !Array.isArray(e.candidates) || e.candidates.length === 0).length;

  const workDir = mkdtempSync(path.join(tmpdir(), 'mkt-enrich-'));
  const evidenceFile = path.join(workDir, 'evidence.json').replace(/\\/g, '/');
  const resultFile = path.join(workDir, 'result.json').replace(/\\/g, '/');
  writeFileSync(evidenceFile, JSON.stringify(evidence));

  try {
    const prompt = [
      `/content-enrichment ${evidenceFile} ${resultFile}`,
      '',
      'Run headless — decide autonomously per the skill and write ONLY the result',
      'JSON file. Do not ask questions. Do not print the JSON to stdout.',
    ].join('\n');

    // one skill run, then one retry if the output is unusable
    let validated = null, lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, out, err } = await runClaude(prompt, ROOT);
      const combined = `${out}\n${err}`;
      if (isSubscriptionLimit(combined)) throw new RateLimitError('Claude subscription/usage limit reached');
      if (!existsSync(resultFile)) { lastErr = `session ended (code ${code}) without result file: ${combined.slice(-400)}`; continue; }
      let parsed;
      try { parsed = JSON.parse(readFileSync(resultFile, 'utf-8')); }
      catch (e) { lastErr = `result JSON parse failed: ${e.message}`; continue; }
      const { valid, errors } = validateEnrichmentResults(parsed, evidence);
      if (valid.length === 0) { lastErr = `validation produced 0 valid rows: ${errors.slice(0, 3).join('; ')}`; continue; }
      validated = { valid, errors };
      break;
    }
    if (!validated) throw new Error(`content-enrichment failed after retry: ${lastErr}`);

    // persist each validated post via the scoped upsert RPCs
    let processed = 0;
    for (const v of validated.valid) {
      const ev = evidence.find((e) => e.post_id === v.postId);
      await supa.rpc('mkt_enrichment_upsert', {
        p_post: v.postId, p_model: 'claude-runner:content-enrichment', p_rule_version: ENRICH_RULE_VERSION,
        p_org: ev?.organization_id ?? null, p_developer: null, p_marketer: null,
        p_primary_project: v.primaryProjectId, p_candidates: v.candidates, p_result: v.result,
        p_cost: 0, p_status: 'done', p_failure: null,
      });
      if (v.primaryProjectId) {
        await supa.rpc('mkt_attribution_upsert', { p_content_post_id: v.postId, p_project_id: v.primaryProjectId, p_method: 'caption', p_confidence: 0.9, p_evidence: { matched: 'claude-runner', snippet: (ev?.snippet ?? '').slice(0, 160) }, p_matched_aliases: [], p_auto_accept: true });
      }
      for (const s of v.secondary) {
        await supa.rpc('mkt_attribution_upsert', { p_content_post_id: v.postId, p_project_id: s.projectId, p_method: 'caption', p_confidence: s.confidence, p_evidence: { matched: s.matched.join(','), snippet: (ev?.snippet ?? '').slice(0, 160) }, p_matched_aliases: s.matched, p_auto_accept: false });
      }
      await supa.rpc('mkt_content_set_status', { p_post: v.postId, p_status: v.deterministicPartial ? 'partial' : 'processed', p_media_count: null });
      processed++;
    }
    return { batch: postIds.length, evidence: evidence.length, processed, posts_without_candidates: noCandidates, validation_errors: validated.errors.slice(0, 10) };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── OCR lane ────────────────────────────────────────────────────────────────
// Visual-text extraction on the SUBSCRIPTION instead of the Anthropic API.
// Runs on its own `ocr` lease so a large OCR backlog cannot queue behind (or
// ahead of) a rep's client_study — the starvation failure fixed on 2026-08-15.
//
// Same shape as content-enrichment: the handler prepares local inputs, the Skill
// reads them and writes ONE result file, the handler validates and persists.
// Claude Code reads image files natively, so the images are staged to disk first.
// Images per session. Raised 12 -> 24 to amortise session startup over more
// images: the poll gap plus container/session warm-up is roughly fixed per job,
// so doubling the payload nearly halves that overhead per image. 24 images runs
// ~4 min, comfortably inside MAX_JOB_MS (25 min).
//
// This cap only bites if the batch actually SUPPLIES that many images. Posts
// average 1.61 stored images each, so the sweep sends OCR_POSTS_PER_BATCH = 15
// to fill it; at the old 7 posts a batch offered ~11 images and never reached
// even the old cap of 12.
const OCR_BATCH_MAX = 24;         // images per session; keeps one run bounded
const OCR_FIELDS = ['project_names','developer_names','prices','payment_plans','unit_types',
  'districts','locations','phones','urls','offers','amenities','selling_points','dates','ctas'];

async function handleMktVisualOcr(job) {
  const postIds = Array.isArray(job.payload?.post_ids) ? job.payload.post_ids : [];
  if (postIds.length === 0) throw new Error('payload.post_ids is required');

  // Only images/frames/thumbnails that are permanently STORED — never the CDN.
  const { data: media, error: mErr } = await supa
    .from('mkt_content_media')
    .select('id, content_post_id, media_kind, stored_url')
    .in('content_post_id', postIds)
    .eq('download_status', 'stored')
    .in('media_kind', ['image', 'thumbnail']);
  if (mErr) throw new Error(`media query failed: ${mErr.message}`);
  if (!media || media.length === 0) throw new Error('no stored images for the requested posts');

  // Skip anything already OCR'd — reprocessing must never re-spend a session.
  const { data: existing } = await supa.from('mkt_visual_text')
    .select('content_media_id').in('content_media_id', media.map((m) => m.id));
  const done = new Set((existing ?? []).map((r) => r.content_media_id));
  // Cap AFTER the filter, never before. Capping first took an arbitrary 12 rows
  // and then removed the finished ones, so a batch whose first 12 happened to be
  // done reported "nothing to do" while unread images sat behind the cap — and
  // the post was never offered again.
  const todo = media.filter((m) => !done.has(m.id)).slice(0, OCR_BATCH_MAX);
  if (todo.length === 0) return { batch: postIds.length, images: 0, skipped_already_ocr: media.length };

  const workDir = mkdtempSync(path.join(tmpdir(), 'mkt-ocr-'));
  const manifestFile = path.join(workDir, 'manifest.json').replace(/\\/g, '/');
  const resultFile = path.join(workDir, 'result.json').replace(/\\/g, '/');

  try {
    const manifest = [];
    for (let i = 0; i < todo.length; i++) {
      const m = todo[i];
      const res = await fetch(m.stored_url);
      if (!res.ok) { console.warn(`[runner] ocr: skip media ${m.id} — fetch ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const p = path.join(workDir, `${i}.jpg`).replace(/\\/g, '/');
      writeFileSync(p, buf);
      manifest.push({ media_id: m.id, post_id: m.content_post_id,
        source: m.media_kind === 'thumbnail' ? 'thumbnail' : 'image',
        frame_ts_ms: null, path: p });
    }
    if (manifest.length === 0) throw new Error('every image failed to download');
    writeFileSync(manifestFile, JSON.stringify(manifest));

    const prompt = [
      `/visual-ocr ${manifestFile} ${resultFile}`,
      '',
      'Run headless — read every image listed in the manifest and write ONLY the',
      'result JSON file. Do not ask questions. Do not print the JSON to stdout.',
    ].join('\n');

    let rows = null, lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, out, err } = await runClaude(prompt, ROOT);
      const combined = `${out}\n${err}`;
      if (isSubscriptionLimit(combined)) throw new RateLimitError('Claude subscription/usage limit reached');
      if (!existsSync(resultFile)) { lastErr = `session ended (code ${code}) without result file: ${combined.slice(-300)}`; continue; }
      let parsed;
      try { parsed = JSON.parse(readFileSync(resultFile, 'utf-8')); }
      catch (e) { lastErr = `result JSON parse failed: ${e.message}`; continue; }
      if (!Array.isArray(parsed) || parsed.length === 0) { lastErr = 'result was not a non-empty array'; continue; }
      // keep only rows that map back to a manifest entry — a hallucinated
      // media_id must never reach mkt_visual_text
      const byId = new Map(manifest.map((x) => [x.media_id, x]));
      rows = parsed.filter((r) => r && typeof r.media_id === 'string' && byId.has(r.media_id));
      if (rows.length === 0) { lastErr = 'no result row matched a manifest media_id'; rows = null; continue; }
      break;
    }
    if (!rows) throw new Error(`visual-ocr failed after retry: ${lastErr}`);

    const byId = new Map(manifest.map((x) => [x.media_id, x]));
    let written = 0;
    for (const r of rows) {
      const src = byId.get(r.media_id);
      const structured = { visible_text: String(r.visible_text ?? '') };
      for (const f of OCR_FIELDS) structured[f] = Array.isArray(r[f]) ? r[f].map(String) : [];
      const { error } = await supa.rpc('mkt_visual_text_upsert', {
        p_media: r.media_id, p_post: src.post_id, p_source: src.source, p_frame_ts_ms: src.frame_ts_ms,
        p_model: 'claude-runner:visual-ocr', p_text: structured.visible_text, p_structured: structured,
        p_confidence: null, p_cost: 0,   // subscription — no incremental API charge
        p_status: 'done', p_failure: null, p_raw: null,
      });
      if (error) { console.error(`[runner] ocr upsert failed for ${r.media_id}: ${error.message}`); continue; }
      written++;
    }
    return { batch: postIds.length, images: manifest.length, written,
             skipped_already_ocr: media.length - todo.length };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── main loop ───────────────────────────────────────────────────────────────
let lastWatchdog = 0;
let cooldownUntil = 0;
// The SECOND intelligence Skill on the runner. Same shape as enrichment —
// scoped evidence RPC → Skill session → pure validator → scoped upsert — because
// a second bespoke pattern would be a second thing to operate.
async function handleMktCampaignSummary(job) {
  const campaignIds = Array.isArray(job.payload?.campaign_ids) ? job.payload.campaign_ids : [];
  if (campaignIds.length === 0) throw new Error('payload.campaign_ids is required');

  const { data: evidence, error: evErr } = await supa.rpc('mkt_campaign_evidence', { p_campaign_ids: campaignIds });
  if (evErr) throw new Error(`campaign evidence rpc failed: ${evErr.message}`);
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error('no campaign evidence returned');

  const workDir = mkdtempSync(path.join(tmpdir(), 'mkt-campaign-'));
  const evidenceFile = path.join(workDir, 'evidence.json').replace(/\\/g, '/');
  const resultFile = path.join(workDir, 'result.json').replace(/\\/g, '/');
  writeFileSync(evidenceFile, JSON.stringify(evidence));

  try {
    const prompt = [
      `/campaign-summary ${evidenceFile} ${resultFile}`,
      '',
      'Run headless — decide autonomously per the skill and write ONLY the result',
      'JSON file. Do not ask questions. Do not print the JSON to stdout.',
    ].join('\n');

    let validated = null, lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, out, err } = await runClaude(prompt, ROOT);
      const combined = `${out}\n${err}`;
      if (isSubscriptionLimit(combined)) throw new RateLimitError('Claude subscription/usage limit reached');
      if (!existsSync(resultFile)) { lastErr = `session ended (code ${code}) without result file: ${combined.slice(-400)}`; continue; }
      let parsed;
      try { parsed = JSON.parse(readFileSync(resultFile, 'utf-8')); }
      catch (e) { lastErr = `result JSON parse failed: ${e.message}`; continue; }
      const { valid, errors } = validateCampaignSummaries(parsed, evidence);
      if (valid.length === 0) { lastErr = `validation produced 0 valid rows: ${errors.slice(0, 3).join('; ')}`; continue; }
      validated = { valid, errors };
      break;
    }
    if (!validated) throw new Error(`campaign-summary failed after retry: ${lastErr}`);

    let summarised = 0;
    for (const v of validated.valid) {
      const ev = evidence.find((e) => e.campaign_id === v.campaignId);
      const { error } = await supa.rpc('mkt_campaign_summary_upsert', {
        p_campaign: v.campaignId,
        p_org: job.payload?.organization_id ?? null,
        p_model: 'claude-runner:campaign-summary',
        p_skill_version: CAMPAIGN_SUMMARY_VERSION,
        p_result: v.result,
        p_evidence_refs: v.evidenceRefs,
        p_confidence: v.confidence,
        p_cost: 0, p_status: 'done', p_failure: null,
      });
      if (error) throw new Error(`summary upsert failed for ${v.campaignId}: ${error.message}`);
      summarised++;
      void ev;
    }
    return {
      batch: campaignIds.length,
      evidence: evidence.length,
      summarised,
      validation_errors: validated.errors.slice(0, 10),
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const HANDLERS = {
  ping: handlePing,
  client_study: handleClientStudy,
  mkt_content_enrichment: handleMktContentEnrichment,
  mkt_campaign_summary: handleMktCampaignSummary,
  mkt_visual_ocr: handleMktVisualOcr,
};

// Upper bound on ONE job. Must sit ABOVE the slowest legitimate session
// (whatsapp_reply and client_study have both run ~14 min) and BELOW the DB
// watchdog's 45-minute sweep, so the runner resolves its own hangs rather than
// leaving the lane blocked until the database intervenes.
const MAX_JOB_MS = Number(process.env.MAX_JOB_MS || 25 * 60_000);

async function withJobTimeout(promise, job) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          console.error(`[runner] job=${job.id} (${job.kind}) exceeded ${Math.round(MAX_JOB_MS / 60000)}m — killing the session`);
          killClaudeChild(); // process GROUP kill; the CLI spawns children
          reject(new Error(`job exceeded ${Math.round(MAX_JOB_MS / 60000)}m and was terminated by the runner`));
        }, MAX_JOB_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function tick() {
  // Cooling down after a subscription-limit hit — don't hammer Claude.
  if (Date.now() < cooldownUntil) return;

  if (Date.now() - lastWatchdog > 5 * 60_000) {
    lastWatchdog = Date.now();
    const { error } = await supa.rpc('claude_jobs_watchdog');
    if (error) console.error('[runner] watchdog rpc failed:', error.message);
    // requeue anything parked by a prior limit — the cooldown has passed
    try { await supa.rpc('claude_jobs_unblock'); } catch (e) { console.error('[runner] unblock rpc failed:', e); }
  }

  const { data: jobs, error } = await supa.rpc('claude_job_claim_next', { p_worker: WORKER });
  if (error) { console.error('[runner] claim failed:', error.message); return; }
  const job = jobs?.[0];
  if (!job) return;

  console.log(`[runner] claimed ${job.kind} job=${job.id}`);
  currentJobId = job.id;
  const handler = HANDLERS[job.kind] ?? handleClientStudy; // default keeps legacy behavior
  try {
    // HARD CEILING on a single job. A Claude session can finish its work — even
    // write its result and mark the job ready — and then never exit; observed
    // 2026-07-27, where a client_study completed at 07:47:01 but the CLI child
    // hung, so `await handler(job)` never returned and the lane sat idle-looking-
    // busy for 8 minutes. Nothing caught it: the lease kept heartbeating (own
    // timer), the loop looked legitimately occupied (currentJobId set), and the
    // DB watchdog only sweeps at 45 minutes.
    //
    // Bounding the AWAIT is the only thing that closes it — the child is killed
    // as a process group and the job fails loudly into the normal retry path.
    const result = await withJobTimeout(handler(job), job);
    const { error: doneErr } = await supa.rpc('claude_job_complete', { p_job_id: job.id, p_result: result });
    if (doneErr) console.error('[runner] complete rpc failed:', doneErr.message);
    else console.log(`[runner] job=${job.id} READY`);
  } catch (e) {
    if (e instanceof RateLimitError) {
      cooldownUntil = Date.now() + 30 * 60_000; // 30-min cooldown
      console.warn(`[runner] job=${job.id} BLOCKED (subscription limit) — cooling down 30m`);
      try { await supa.rpc('claude_job_block', { p_job_id: job.id, p_error: e.message }); } catch (err) { console.error('[runner] block rpc failed:', err); }
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[runner] job=${job.id} FAILED: ${msg}`);
    const { error: failErr } = await supa.rpc('claude_job_fail', { p_job_id: job.id, p_error: msg });
    if (failErr) console.error('[runner] fail rpc failed:', failErr.message);
  } finally {
    currentJobId = null;
  }
}

// ── singleton lease ─────────────────────────────────────────────────────────
async function acquireLease() {
  const { data, error } = await supa.rpc('claude_runner_lease_acquire', {
    p_lease: LEASE, p_owner: WORKER, p_host: HOSTNAME, p_pid: process.pid, p_ttl_seconds: LEASE_TTL_S,
  });
  if (error) { console.error('[runner] lease rpc failed:', error.message); return { acquired: false, current_owner: null }; }
  return data?.[0] ?? { acquired: false, current_owner: null };
}

/** Clean shutdown: stop claiming, let the in-flight session finish within a
 *  bounded grace period, else group-kill it and hand the job straight back to
 *  the queue (so it is NOT stuck 'running' until the 45-min crash watchdog). */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runner] ${signal} — shutting down (no new jobs)`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  if (currentJobId) {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (currentJobId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    if (currentJobId) {
      console.warn(`[runner] grace expired — terminating session and requeueing job=${currentJobId}`);
      killClaudeChild();
      try {
        await supa.rpc('claude_job_interrupt', {
          p_job_id: currentJobId, p_owner: WORKER,
          p_reason: `interrupted by runner shutdown (${signal}) — requeued`,
        });
      } catch (e) { console.error('[runner] interrupt rpc failed:', e); }
    }
  }
  try { await supa.rpc('claude_runner_lease_release', { p_lease: LEASE, p_owner: WORKER }); } catch (e) { console.error('[runner] lease release failed:', e); }
  console.log('[runner] lease released — bye');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { void shutdown(sig); });

// ── boot: dev-mode gate ─────────────────────────────────────────────────────
// Production runs on Fly (RUNNER_ENV=fly, baked into the image). A developer
// laptop that still has .env.local would otherwise be one `node` away from
// taking the production lease the moment the Fly runner restarts — and then
// production intelligence would silently depend on that laptop staying awake,
// which is the exact dependency this deployment removes. The DB lease prevents
// CONCURRENT runners; this gate prevents an unintended OWNER.
if (process.env.RUNNER_ENV !== 'fly' && process.env.RUNNER_ALLOW_LOCAL !== '1') {
  console.error(
    '[runner] refusing to start: this is not the deployed runner (RUNNER_ENV != "fly").\n' +
    '         Production runs on the Fly app "wassel-claude-runner".\n' +
    '         To run locally on purpose (debugging), set RUNNER_ALLOW_LOCAL=1 — but note\n' +
    '         it will contend for the SAME production lease and can take ownership.',
  );
  process.exit(0);
}

// ── boot: singleton gate, then the sequential loop ──────────────────────────
// Do NOT give up on the first refusal. After an unclean stop (SIGKILL, machine
// loss) the lease is still held by our own DEAD predecessor until its TTL runs
// out — and a machine that restarts inside that window would exit 0, which Fly
// treats as success and does not restart. That took the always-on runner down
// permanently in testing (verified 2026-07-26: hard kill → reboot 2s later →
// "another runner owns the lease" → both machines stopped for ~25 minutes).
//
// So wait out the TTL before concluding someone else genuinely owns it. A LIVE
// owner keeps renewing and we still exit cleanly; a dead one expires and we take
// over within seconds of the TTL.
const LEASE_WAIT_MS = (LEASE_TTL_S + 60) * 1000;
let first = await acquireLease();
if (!first.acquired) {
  const deadline = Date.now() + LEASE_WAIT_MS;
  console.warn(`[runner] lease held by ${first.current_owner} — waiting up to ${Math.round(LEASE_WAIT_MS / 1000)}s for it to expire`);
  while (!first.acquired && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    first = await acquireLease();
  }
}
if (!first.acquired) {
  console.error(`[runner] another runner still owns the lease (${first.current_owner}) after waiting — exiting cleanly`);
  process.exit(0);
}
console.log(`[runner] ${WORKER} holds the ${LEASE} lease — polling every ${POLL_MS / 1000}s — repo: ${ROOT}`);

// Winning the lease proves the previous owner stopped heartbeating for a full
// TTL, so anything still 'running' under a different owner is abandoned. Hand
// it back to the queue now instead of waiting out the 45-minute watchdog.
try {
  const { data: recovered, error: recErr } = await supa.rpc('claude_jobs_recover_orphaned', { p_owner: WORKER });
  if (recErr) console.error('[runner] orphan recovery failed:', recErr.message);
  else for (const r of recovered ?? []) console.warn(`[runner] recovered ${r.kind} job=${r.job_id} from ${r.prior_owner} → ${r.action}`);
} catch (e) { console.error('[runner] orphan recovery threw:', e); }
// Liveness of the LANE is "the poll loop is going round", not "a timer fires".
// The heartbeat runs on its own interval so it survives a 14-minute job — which
// also means a wedged poll loop keeps renewing the lease and holds the lane
// hostage while processing nothing. That happened the first time two lanes ran
// (2026-07-27): the interactive runner completed a job, its loop never came
// back, and the lease stayed green for 6+ minutes with a pending job untouched.
// A dead runner is recoverable (lease expires, another takes over); a wedged one
// that still heartbeats is invisible. So: if the loop stops advancing while NO
// job is running, stop pretending to be alive and exit non-zero so Fly restarts.
let lastTickAt = Date.now();
const STALL_MS = 5 * 60_000; // >> POLL_MS (10s); only fires on a genuine wedge

heartbeatTimer = setInterval(() => {
  if (!shuttingDown && !currentJobId && Date.now() - lastTickAt > STALL_MS) {
    console.error(`[runner] poll loop STALLED — no tick for ${Math.round((Date.now() - lastTickAt) / 1000)}s with no job running. `
      + 'Exiting non-zero so the platform restarts us; the lease will expire and another machine can take this lane.');
    process.exit(1); // deliberately NOT exit(0) — Fly does not restart on 0
  }
  acquireLease().then((r) => {
    if (!r.acquired && !shuttingDown) {
      console.error(`[runner] LOST the lease to ${r.current_owner} — shutting down`);
      void shutdown('lease-lost');
    }
  });
}, HEARTBEAT_MS);

// Sequential forever-loop: one job fully finishes before the next claim.
while (!shuttingDown) {
  lastTickAt = Date.now();
  try { await tick(); } catch (e) { console.error('[runner] tick crashed:', e); }
  if (shuttingDown) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
